package service

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"starrychat/backend/trigger/common"
	"starrychat/backend/trigger/model"
	"starrychat/backend/trigger/repository"
)

func (s *Service) Subscribe(ctx context.Context, input model.SubscribeInput) (model.SubscriptionResult, error) {
	if err := validateSource(input.Source); err != nil {
		return model.SubscriptionResult{}, err
	}
	if len(input.AgentIDs) == 0 {
		return model.SubscriptionResult{}, businessError("INVALID_REQUEST", "agent_ids must not be empty.")
	}
	for _, id := range input.AgentIDs {
		if !common.ValidID(id) {
			return model.SubscriptionResult{}, businessError("INVALID_REQUEST", "agent_ids must contain canonical UUIDv7 values.")
		}
	}
	s.subscriptions.Lock()
	defer s.subscriptions.Unlock()
	var result model.SubscriptionResult
	err := s.repository.WithinTx(ctx, func(q *repository.Queries) error {
		channels, err := q.ListChannels(ctx, input.Source)
		if err != nil {
			return err
		}
		byAgent := make(map[string]model.Channel, len(channels))
		for _, channel := range channels {
			byAgent[channel.AgentID] = channel
		}
		if len(channels) > 0 {
			result.ChannelID = channels[0].ChannelID
		} else {
			result.ChannelID, err = common.NewID()
			if err != nil {
				return err
			}
		}
		result.Channels = []model.Channel{}
		seen := make(map[string]bool, len(input.AgentIDs))
		now := time.Now().UnixMilli()
		for _, id := range input.AgentIDs {
			if seen[id] {
				continue
			}
			seen[id] = true
			channel, exists := byAgent[id]
			if !exists {
				if _, err := q.GetAgent(ctx, id); errors.Is(err, sql.ErrNoRows) {
					return businessError("NOT_FOUND", "Agent is not registered: "+id)
				} else if err != nil {
					return err
				}
				channel = model.Channel{AgentID: id, ChannelID: result.ChannelID, ChannelType: input.ChannelType,
					ConversationID: input.ConversationID, CreatedAt: now}
				if err := q.InsertChannel(ctx, channel); err != nil {
					return err
				}
			}
			result.Channels = append(result.Channels, channel)
		}
		return nil
	})
	if err != nil {
		return model.SubscriptionResult{}, err
	}
	return result, nil
}

func (s *Service) Unsubscribe(ctx context.Context, source model.Source, agentID string) error {
	if err := validateSource(source); err != nil {
		return err
	}
	if !common.ValidID(agentID) {
		return businessError("INVALID_REQUEST", "agent_id must be a canonical UUIDv7.")
	}
	s.subscriptions.Lock()
	defer s.subscriptions.Unlock()
	return s.repository.DeleteSubscription(ctx, source, agentID)
}

func (s *Service) ClearChannel(ctx context.Context, source model.Source) error {
	if err := validateSource(source); err != nil {
		return err
	}
	s.subscriptions.Lock()
	defer s.subscriptions.Unlock()
	return s.repository.DeleteChannel(ctx, source)
}
