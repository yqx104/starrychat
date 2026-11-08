package service

import (
	"context"
	"time"

	"starrychat/backend/trigger/common"
	"starrychat/backend/trigger/model"
)

func (s *Service) RegisterAgent(ctx context.Context, id string) (model.Agent, error) {
	if !common.ValidID(id) {
		return model.Agent{}, businessError("INVALID_REQUEST", "agent_id must be a canonical UUIDv7.")
	}
	if err := s.repository.RegisterAgent(ctx, id, time.Now().UnixMilli()); err != nil {
		return model.Agent{}, err
	}
	return s.repository.GetAgent(ctx, id)
}
