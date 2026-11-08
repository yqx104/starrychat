package service

import (
	"context"

	"yqx-team/backend/im/model"
	"yqx-team/backend/im/repository"
)

func (s *Service) ListParticipants(ctx context.Context, caller model.RequestContext, query model.ParticipantsQuery) ([]model.Participant, error) {
	return read(ctx, s, func(q *repository.Queries) ([]model.Participant, error) {
		ownerID, err := callerOwner(ctx, q, caller)
		if err != nil {
			return nil, err
		}
		accounts, err := q.ListAccountsByOwner(ctx, ownerID)
		if err != nil {
			return nil, err
		}
		ids := []string{ownerID}
		for _, account := range accounts {
			ids = append(ids, account.ParticipantID)
		}
		participants, err := q.GetParticipants(ctx, ids)
		if err != nil {
			return nil, err
		}
		visible := []model.Participant{}
		for _, p := range participants {
			if (p.ParticipantID == ownerID && p.Kind == model.Human) || (p.ParticipantID != ownerID && p.Kind == model.Agent) {
				if query.Kind == "" || p.Kind == query.Kind {
					visible = append(visible, p)
				}
			}
		}
		return visible, nil
	})
}
