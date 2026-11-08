package service

import (
	"context"
	"log/slog"
	"slices"
	"sync"

	"yqx-team/backend/trigger/common"
	"yqx-team/backend/trigger/model"
)

func (s *Service) ReceiveMessage(ctx context.Context, message model.Message) (model.MessageResult, error) {
	result := model.MessageResult{DeliveredAgentIDs: []string{}, FailedAgentIDs: []string{}}
	if err := validateSource(message.Source); err != nil {
		return result, err
	}
	if !common.ValidID(message.MessageID) || !common.ValidID(message.SenderID) {
		return result, businessError("INVALID_REQUEST", "message_id and sender_id must be canonical UUIDv7 values.")
	}
	channels, err := s.repository.ListChannels(ctx, message.Source)
	if err != nil {
		return result, err
	}
	if len(channels) > 0 {
		result.ChannelID = channels[0].ChannelID
	}
	targets := []model.Channel{}
	for _, channel := range channels {
		if message.ChannelType == model.IMDirect {
			// A direct chat delivers to the other participant, never echoes to its sender.
			if channel.AgentID != message.SenderID {
				targets = append(targets, channel)
			}
		} else if slices.Contains(message.MentionedAgentIDs, channel.AgentID) {
			targets = append(targets, channel)
		}
	}
	if len(targets) == 0 {
		return result, nil
	}
	if s.deliverer == nil {
		for _, target := range targets {
			result.FailedAgentIDs = append(result.FailedAgentIDs, target.AgentID)
		}
		return result, businessError("DELIVERY_UNAVAILABLE", "Agent delivery endpoint is not configured.")
	}
	// Read the subscriptions once, then release database resources before doing IO.
	// Each recipient is attempted once; no background work or automatic retries.
	errorsByTarget := make([]error, len(targets))
	var pending sync.WaitGroup
	for i, target := range targets {
		pending.Go(func() {
			errorsByTarget[i] = s.deliverer.Deliver(ctx, model.Delivery{
				AgentID: target.AgentID, ChannelID: target.ChannelID, Message: message,
			})
		})
	}
	pending.Wait()
	for i, target := range targets {
		if errorsByTarget[i] != nil {
			result.FailedAgentIDs = append(result.FailedAgentIDs, target.AgentID)
			slog.Warn("Agent delivery failed", "agent_id", target.AgentID, "message_id", message.MessageID, "error", errorsByTarget[i])
		} else {
			result.DeliveredAgentIDs = append(result.DeliveredAgentIDs, target.AgentID)
		}
	}
	if len(result.FailedAgentIDs) > 0 {
		return result, businessError("DELIVERY_FAILED", "One or more Agent deliveries failed.")
	}
	return result, nil
}
