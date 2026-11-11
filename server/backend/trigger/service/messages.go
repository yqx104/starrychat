package service

import (
	"context"
	"slices"

	"starrychat/backend/trigger/common"
	"starrychat/backend/trigger/model"
)

func (s *Service) ReceiveMessage(ctx context.Context, message model.Message) (model.MessageResult, error) {
	result := model.MessageResult{QueuedAgentIDs: []string{}}
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
	items := make([]model.Delivery, 0, len(targets))
	for _, target := range targets {
		items = append(items, model.Delivery{AgentID: target.AgentID, ChannelID: target.ChannelID, Message: message})
	}
	if err := s.repository.Enqueue(ctx, items); err != nil {
		return result, err
	}
	for _, target := range targets {
		result.QueuedAgentIDs = append(result.QueuedAgentIDs, target.AgentID)
	}
	return result, nil
}
