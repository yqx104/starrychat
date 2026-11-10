package service

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"time"

	"starrychat/backend/im/model"
	"starrychat/backend/im/repository"
)

func (s *Service) ListMessages(ctx context.Context, caller model.RequestContext, query model.MessagePageQuery) (model.MessagePage, error) {
	return read(ctx, s, func(q *repository.Queries) (model.MessagePage, error) {
		if _, err := accessibleConversation(ctx, q, caller, query.ConversationID, false); err != nil {
			return model.MessagePage{}, err
		}
		if query.Limit == 0 {
			query.Limit = 50
		}
		if query.Limit < 1 || query.Limit > 50 {
			return model.MessagePage{}, businessError("INVALID_OPERATION", "limit must be between 1 and 50.")
		}
		if query.BeforeSeq != nil && query.AfterSeq != nil {
			return model.MessagePage{}, businessError("INVALID_OPERATION", "Message cursor directions are mutually exclusive.")
		}
		for _, cursor := range []*int64{query.BeforeSeq, query.AfterSeq} {
			if cursor != nil && (*cursor < 0 || *cursor > model.MaxSeq) {
				return model.MessagePage{}, businessError("INVALID_OPERATION", "Message cursor must be a non-negative safe integer.")
			}
		}
		if query.BeforeSeq != nil && *query.BeforeSeq == 0 {
			return model.MessagePage{}, businessError("INVALID_OPERATION", "before_seq must be positive.")
		}
		limit := query.Limit
		query.Limit++
		messages, err := q.ListMessages(ctx, query)
		if err != nil {
			return model.MessagePage{}, err
		}
		hasMore := len(messages) > limit
		if hasMore {
			messages = messages[:limit]
		}
		if query.AfterSeq == nil {
			slices.Reverse(messages)
		}
		return model.MessagePage{Messages: messages, HasMore: hasMore}, nil
	})
}

func (s *Service) SendMessage(ctx context.Context, caller model.RequestContext, input model.SendMessageInput) (model.Message, error) {
	return write(ctx, s, func(q *repository.Queries) (model.Message, error) {
		conversation, err := accessibleConversation(ctx, q, caller, input.ConversationID, true)
		if err != nil {
			return model.Message{}, err
		}
		if err := requireActive(conversation); err != nil {
			return model.Message{}, err
		}
		mentions := uniqueIDs(input.MentionedAgentIDs)
		ownerID, err := callerOwner(ctx, q, caller)
		if err != nil {
			return model.Message{}, err
		}
		for _, id := range mentions {
			if _, err := requireOwnedAgent(ctx, q, ownerID, id); err != nil {
				return model.Message{}, err
			}
			exists, err := memberExists(ctx, q, input.ConversationID, id)
			if err != nil {
				return model.Message{}, err
			}
			if !exists {
				return model.Message{}, businessError("INVALID_OPERATION", "Mentioned agent is not a member of this conversation.")
			}
		}
		if err := quotedMessage(ctx, q, input.ConversationID, input.QuotedMessageID); err != nil {
			return model.Message{}, err
		}
		seq, err := q.NextMessageSeq(ctx, input.ConversationID)
		if err != nil {
			return model.Message{}, err
		}
		return q.InsertMessage(ctx, model.Message{
			MessageSeq:     seq,
			ConversationID: input.ConversationID, SenderID: caller.ParticipantID, Content: input.Content,
			QuotedMessageID: input.QuotedMessageID, CreatedAt: time.Now().UnixMilli(), MentionedAgentIDs: mentions,
		})
	})
}

func quotedMessage(ctx context.Context, q *repository.Queries, conversationID string, id *string) error {
	if id == nil {
		return nil
	}
	message, err := q.GetMessage(ctx, *id)
	if errors.Is(err, sql.ErrNoRows) {
		return businessError("NOT_FOUND", "Quoted message not found.")
	}
	if err != nil {
		return err
	}
	if message.ConversationID != conversationID {
		return businessError("INVALID_OPERATION", "Quoted message must belong to the same conversation.")
	}
	return nil
}
