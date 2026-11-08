package service

import (
	"context"
	"time"

	"yqx-team/backend/im/model"
	"yqx-team/backend/im/repository"
)

func (s *Service) ListConversations(ctx context.Context, caller model.RequestContext) ([]model.Conversation, error) {
	return read(ctx, s, func(q *repository.Queries) ([]model.Conversation, error) {
		ownerID, err := callerOwner(ctx, q, caller)
		if err != nil {
			return nil, err
		}
		ids, err := q.ListConversationIDs(ctx, caller.ParticipantID)
		if err != nil {
			return nil, err
		}
		conversations := make([]model.Conversation, 0, len(ids))
		for _, id := range ids {
			owned, err := conversationOwnedBy(ctx, q, id, ownerID)
			if err != nil {
				return nil, err
			}
			if !owned {
				continue
			}
			conversation, err := q.GetConversation(ctx, id)
			if err != nil {
				return nil, err
			}
			conversations = append(conversations, conversation)
		}
		return conversations, nil
	})
}

func (s *Service) CreateGroup(ctx context.Context, caller model.RequestContext, input model.CreateGroupInput) (model.Conversation, error) {
	return write(ctx, s, func(q *repository.Queries) (model.Conversation, error) {
		human, err := requireHuman(ctx, q, caller, false)
		if err != nil {
			return model.Conversation{}, err
		}
		agentIDs := uniqueIDs(input.AgentIDs)
		for _, id := range agentIDs {
			if _, err := requireOwnedAgent(ctx, q, human.ParticipantID, id); err != nil {
				return model.Conversation{}, err
			}
		}
		now := time.Now().UnixMilli()
		conversation, err := q.InsertConversation(ctx, "group", &input.Title, now)
		if err != nil {
			return conversation, err
		}
		if err := q.InsertMember(ctx, conversation.ConversationID, human.ParticipantID, now); err != nil {
			return conversation, err
		}
		for _, id := range agentIDs {
			if err := q.InsertMember(ctx, conversation.ConversationID, id, now); err != nil {
				return conversation, err
			}
		}
		return conversation, nil
	})
}

func (s *Service) OpenDirect(ctx context.Context, caller model.RequestContext, input model.OpenDirectInput) (model.Conversation, error) {
	return write(ctx, s, func(q *repository.Queries) (model.Conversation, error) {
		// The human row serializes lookup+creation across processes, including when no chat exists yet.
		human, err := requireHuman(ctx, q, caller, true)
		if err != nil {
			return model.Conversation{}, err
		}
		agent, err := requireOwnedAgent(ctx, q, human.ParticipantID, input.AgentID)
		if err != nil {
			return model.Conversation{}, err
		}
		ids, err := q.ListConversationIDs(ctx, human.ParticipantID)
		if err != nil {
			return model.Conversation{}, err
		}
		for _, id := range ids {
			conversation, err := q.GetConversation(ctx, id)
			if err != nil {
				return conversation, err
			}
			if conversation.Kind != "direct" {
				continue
			}
			members, err := q.ListMemberships(ctx, id)
			if err != nil {
				return conversation, err
			}
			if len(members) != 2 {
				continue
			}
			for _, member := range members {
				if member.ParticipantID == agent.ParticipantID {
					return conversation, nil
				}
			}
		}
		now := time.Now().UnixMilli()
		conversation, err := q.InsertConversation(ctx, "direct", nil, now)
		if err != nil {
			return conversation, err
		}
		for _, id := range []string{human.ParticipantID, agent.ParticipantID} {
			if err := q.InsertMember(ctx, conversation.ConversationID, id, now); err != nil {
				return conversation, err
			}
		}
		return conversation, nil
	})
}

func (s *Service) GetConversation(ctx context.Context, caller model.RequestContext, id string) (model.Conversation, error) {
	return read(ctx, s, func(q *repository.Queries) (model.Conversation, error) {
		return accessibleConversation(ctx, q, caller, id, false)
	})
}

func (s *Service) RenameGroup(ctx context.Context, caller model.RequestContext, input model.RenameGroupInput) (model.Conversation, error) {
	return write(ctx, s, func(q *repository.Queries) (model.Conversation, error) {
		conversation, err := editableGroup(ctx, q, caller, input.ConversationID)
		if err != nil {
			return conversation, err
		}
		if err := q.SetConversationTitle(ctx, input.ConversationID, input.Title); err != nil {
			return conversation, err
		}
		conversation.Title = &input.Title
		return conversation, nil
	})
}

func (s *Service) DissolveGroup(ctx context.Context, caller model.RequestContext, id string) (model.Conversation, error) {
	return write(ctx, s, func(q *repository.Queries) (model.Conversation, error) {
		conversation, err := accessibleConversation(ctx, q, caller, id, true)
		if err != nil {
			return conversation, err
		}
		if err := requireGroup(conversation); err != nil {
			return conversation, err
		}
		if conversation.DissolvedAt != nil {
			return conversation, nil
		}
		now := time.Now().UnixMilli()
		if err := q.SetDissolvedAt(ctx, id, now); err != nil {
			return conversation, err
		}
		conversation.DissolvedAt = &now
		return conversation, nil
	})
}
