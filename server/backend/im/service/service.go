package service

import (
	"context"
	"database/sql"
	"errors"

	"starrychat/backend/im/common"
	"starrychat/backend/im/model"
	"starrychat/backend/im/repository"
)

type AgentRegistrar interface {
	RegisterAgent(context.Context, string) error
}

type Service struct {
	repository *repository.Repository
	trigger    AgentRegistrar
}

func New(repository *repository.Repository, trigger AgentRegistrar) *Service {
	return &Service{repository: repository, trigger: trigger}
}

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
	if !common.ValidID(caller.ParticipantID) {
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

func requireParticipant(ctx context.Context, q *repository.Queries, id string) (model.Participant, error) {
	participant, err := q.GetParticipant(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		err = businessError("NOT_FOUND", "Participant not found.")
	}
	return participant, err
}

func requireAgent(ctx context.Context, q *repository.Queries, id string) (model.Participant, error) {
	participant, err := requireParticipant(ctx, q, id)
	if err != nil {
		return participant, err
	}
	if participant.Kind != model.Agent {
		return participant, businessError("INVALID_OPERATION", "The target must be an agent.")
	}
	return participant, nil
}

func memberExists(ctx context.Context, q *repository.Queries, conversationID, participantID string) (bool, error) {
	_, err := q.GetMembership(ctx, conversationID, participantID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func accessibleConversation(ctx context.Context, q *repository.Queries, caller model.RequestContext, id string, lock bool) (model.Conversation, error) {
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

func editableGroup(ctx context.Context, q *repository.Queries, caller model.RequestContext, id string) (model.Conversation, error) {
	conversation, err := accessibleConversation(ctx, q, caller, id, true)
	if err != nil {
		return conversation, err
	}
	if err := requireGroup(conversation); err != nil {
		return conversation, err
	}
	return conversation, requireActive(conversation)
}

func uniqueIDs(ids []string) []string {
	unique := make([]string, 0, len(ids))
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	return unique
}
