package service

import (
	"context"
	"database/sql"
	"errors"

	"yqx-team/backend/im/model"
	"yqx-team/backend/im/repository"
)

type Service struct{ repository *repository.Repository }

func New(repository *repository.Repository) *Service { return &Service{repository: repository} }

func transaction[T any](ctx context.Context, s *Service, options *sql.TxOptions, run func(*repository.Queries) (T, error)) (T, error) {
	var value T
	err := s.repository.WithinTx(ctx, options, func(q *repository.Queries) error {
		var err error
		value, err = run(q)
		return err
	})
	if err != nil {
		var zero T
		return zero, err
	}
	return value, nil
}

func read[T any](ctx context.Context, s *Service, run func(*repository.Queries) (T, error)) (T, error) {
	return transaction(ctx, s, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true}, run)
}

func write[T any](ctx context.Context, s *Service, run func(*repository.Queries) (T, error)) (T, error) {
	return transaction(ctx, s, &sql.TxOptions{Isolation: sql.LevelReadCommitted}, run)
}

func businessError(code, message string) error {
	return &model.ServiceError{Code: code, Message: message}
}

func requireCaller(ctx context.Context, q *repository.Queries, caller model.RequestContext, lock bool) (model.Participant, error) {
	if caller.ParticipantID < 1 || caller.ParticipantID > model.MaxID {
		return model.Participant{}, businessError("FORBIDDEN", "Caller is not a registered participant.")
	}
	var participant model.Participant
	var err error
	if lock {
		participant, err = q.LockParticipant(ctx, caller.ParticipantID)
	} else {
		participant, err = q.GetParticipant(ctx, caller.ParticipantID)
	}
	if errors.Is(err, sql.ErrNoRows) {
		err = businessError("FORBIDDEN", "Caller is not a registered participant.")
	}
	return participant, err
}

func requireHuman(ctx context.Context, q *repository.Queries, caller model.RequestContext, lock bool) (model.Participant, error) {
	participant, err := requireCaller(ctx, q, caller, lock)
	if err != nil {
		return participant, err
	}
	if participant.Kind != model.Human {
		return participant, businessError("FORBIDDEN", "Only a human participant can perform this operation.")
	}
	if _, err := ownerOf(ctx, q, participant); err != nil {
		return model.Participant{}, err
	}
	return participant, nil
}

func requireParticipant(ctx context.Context, q *repository.Queries, id int64) (model.Participant, error) {
	participant, err := q.GetParticipant(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		err = businessError("NOT_FOUND", "Participant not found.")
	}
	return participant, err
}

func requireAgent(ctx context.Context, q *repository.Queries, id int64) (model.Participant, error) {
	participant, err := requireParticipant(ctx, q, id)
	if err != nil {
		return participant, err
	}
	if participant.Kind != model.Agent {
		return participant, businessError("INVALID_OPERATION", "The target must be an agent.")
	}
	return participant, nil
}

func memberExists(ctx context.Context, q *repository.Queries, conversationID, participantID int64) (bool, error) {
	_, err := q.GetMembership(ctx, conversationID, participantID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func accessibleConversation(ctx context.Context, q *repository.Queries, caller model.RequestContext, id int64, lock bool) (model.Conversation, error) {
	ownerID, err := callerOwner(ctx, q, caller)
	if err != nil {
		return model.Conversation{}, err
	}
	var conversation model.Conversation
	if lock {
		conversation, err = q.LockConversation(ctx, id)
	} else {
		conversation, err = q.GetConversation(ctx, id)
	}
	if errors.Is(err, sql.ErrNoRows) {
		err = businessError("NOT_FOUND", "Conversation not found.")
	}
	if err != nil {
		return conversation, err
	}
	member, err := memberExists(ctx, q, id, caller.ParticipantID)
	if err != nil {
		return conversation, err
	}
	if !member {
		return conversation, businessError("FORBIDDEN", "Caller is not a member of this conversation.")
	}
	owned, err := conversationOwnedBy(ctx, q, id, ownerID)
	if err != nil {
		return model.Conversation{}, err
	}
	if !owned {
		return model.Conversation{}, businessError("FORBIDDEN", "Conversation belongs to another human.")
	}
	return conversation, nil
}

func requireGroup(conversation model.Conversation) error {
	if conversation.Kind != "group" {
		return businessError("INVALID_OPERATION", "This operation requires a group conversation.")
	}
	return nil
}

func requireActive(conversation model.Conversation) error {
	if conversation.DissolvedAt != nil {
		return businessError("CONFLICT", "The conversation has been dissolved.")
	}
	return nil
}

func editableGroup(ctx context.Context, q *repository.Queries, caller model.RequestContext, id int64) (model.Conversation, error) {
	conversation, err := accessibleConversation(ctx, q, caller, id, true)
	if err != nil {
		return conversation, err
	}
	if err := requireGroup(conversation); err != nil {
		return conversation, err
	}
	return conversation, requireActive(conversation)
}

func uniqueIDs(ids []int64) []int64 {
	unique := make([]int64, 0, len(ids))
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	return unique
}
