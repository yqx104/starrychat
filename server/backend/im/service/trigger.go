package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"starrychat/backend/im/model"
	"starrychat/backend/im/repository"
)

func triggerSource(conversation model.Conversation) model.TriggerSource {
	return model.TriggerSource{ChannelType: "im_" + conversation.Kind, ConversationID: conversation.ConversationID}
}

func (s *Service) deliverTriggerEvent(ctx context.Context, event model.TriggerEvent) error {
	switch event.Operation {
	case model.TriggerRegisterAgent:
		var input model.TriggerAgentRegistration
		if err := json.Unmarshal(event.Payload, &input); err != nil {
			return err
		}
		return s.trigger.RegisterAgent(ctx, input.AgentID)
	case model.TriggerSubscribe:
		var input model.TriggerSubscription
		if err := json.Unmarshal(event.Payload, &input); err != nil {
			return err
		}
		// Register subscription targets idempotently before subscribing.
		for _, id := range input.AgentIDs {
			if err := s.trigger.RegisterAgent(ctx, id); err != nil {
				return err
			}
		}
		return s.trigger.Subscribe(ctx, input)
	case model.TriggerUnsubscribe:
		var input model.TriggerUnsubscription
		if err := json.Unmarshal(event.Payload, &input); err != nil {
			return err
		}
		return s.trigger.Unsubscribe(ctx, input.TriggerSource, input.AgentID)
	case model.TriggerClear:
		var source model.TriggerSource
		if err := json.Unmarshal(event.Payload, &source); err != nil {
			return err
		}
		return s.trigger.ClearChannel(ctx, source)
	case model.TriggerSendMessage:
		var message model.TriggerMessage
		if err := json.Unmarshal(event.Payload, &message); err != nil {
			return err
		}
		return s.trigger.SendMessage(ctx, message)
	default:
		return errors.New("unknown Trigger event operation")
	}
}

// ProcessTriggerEvent commits either completion or a retry time. Only committed
// business events are visible, and retries preserve the original message ID.
func (s *Service) ProcessTriggerEvent(ctx context.Context) (bool, error) {
	if s.trigger == nil {
		return false, errors.New("Trigger client is not configured")
	}
	var found bool
	var deliveryErr error
	err := s.repository.WithinTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted}, func(q *repository.Queries) error {
		event, err := q.NextTriggerEvent(ctx, time.Now().UnixMilli())
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		found = true
		if err := s.deliverTriggerEvent(ctx, event); err != nil {
			deliveryErr = fmt.Errorf("Trigger event %d (%s): %w", event.ID, event.Operation, err)
			delay := min(time.Second<<min(event.Attempts, 5), 30*time.Second)
			return q.RetryTriggerEvent(ctx, event.ID, time.Now().Add(delay).UnixMilli())
		}
		return q.DeleteTriggerEvent(ctx, event.ID)
	})
	if err != nil {
		return false, err
	}
	return found, deliveryErr
}

func (s *Service) RunTriggerSync(ctx context.Context) {
	poll := time.NewTicker(time.Second)
	defer poll.Stop()
	for ctx.Err() == nil {
		processed, err := s.ProcessTriggerEvent(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			slog.Warn("Trigger sync will retry", "error", err)
		}
		if processed {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-poll.C:
		}
	}
}
