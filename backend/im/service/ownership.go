package service

import (
	"context"
	"database/sql"
	"errors"
	"yqx-team/backend/im/model"
	"yqx-team/backend/im/repository"
)

func ownerOf(ctx context.Context, q *repository.Queries, participant model.Participant) (string, error) {
	denied := businessError("FORBIDDEN", "Participant ownership is not valid.")
	account, err := q.GetAccount(ctx, participant.ParticipantID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", denied
	}
	if err != nil {
		return "", err
	}
	if account.Kind != participant.Kind {
		return "", denied
	}
	if participant.Kind == model.Human && account.OwnerParticipantID == nil {
		return participant.ParticipantID, nil
	}
	if participant.Kind != model.Agent || account.OwnerParticipantID == nil {
		return "", denied
	}
	owner, err := q.GetParticipant(ctx, *account.OwnerParticipantID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", denied
	}
	if err != nil {
		return "", err
	}
	ownerAccount, err := q.GetAccount(ctx, owner.ParticipantID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", denied
	}
	if err != nil {
		return "", err
	}
	if owner.Kind != model.Human || ownerAccount.Kind != model.Human || ownerAccount.OwnerParticipantID != nil {
		return "", denied
	}
	return owner.ParticipantID, nil
}

func callerOwner(ctx context.Context, q *repository.Queries, caller model.RequestContext) (string, error) {
	participant, err := requireCaller(ctx, q, caller, false)
	if err != nil {
		return "", err
	}
	return ownerOf(ctx, q, participant)
}

func requireOwnedAgent(ctx context.Context, q *repository.Queries, ownerID, id string) (model.Participant, error) {
	agent, err := requireAgent(ctx, q, id)
	if err != nil {
		return agent, err
	}
	owner, err := ownerOf(ctx, q, agent)
	if err != nil {
		return agent, err
	}
	if owner != ownerID {
		return model.Participant{}, businessError("FORBIDDEN", "Agent belongs to another human.")
	}
	return agent, nil
}

func conversationOwnedBy(ctx context.Context, q *repository.Queries, conversationID, ownerID string) (bool, error) {
	members, err := q.ListMemberships(ctx, conversationID)
	if err != nil {
		return false, err
	}
	ids := make([]string, len(members))
	for i, m := range members {
		ids[i] = m.ParticipantID
	}
	participants, err := q.GetParticipants(ctx, ids)
	if err != nil {
		return false, err
	}
	var humanID string
	for _, p := range participants {
		if p.Kind == model.Human {
			if humanID != "" {
				return false, nil
			}
			humanID = p.ParticipantID
		}
	}
	return humanID == ownerID, nil
}
