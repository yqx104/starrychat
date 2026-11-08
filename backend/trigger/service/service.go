package service

import (
	"context"
	"sync"

	"yqx-team/backend/trigger/common"
	"yqx-team/backend/trigger/model"
	"yqx-team/backend/trigger/repository"
)

type Deliverer interface {
	Deliver(context.Context, model.Delivery) error
}

type Service struct {
	repository *repository.Repository
	deliverer  Deliverer
	// The current deployment has one Trigger instance. Serialize subscription
	// changes, including first subscription creation when no database row exists yet.
	subscriptions sync.Mutex
}

// A nil deliverer leaves registration and subscriptions usable; targeted messages return 503.
func New(repository *repository.Repository, deliverer Deliverer) *Service {
	return &Service{repository: repository, deliverer: deliverer}
}

func (s *Service) Health(ctx context.Context) error { return s.repository.Ping(ctx) }

func businessError(code, message string) error {
	return &model.ServiceError{Code: code, Message: message}
}

func validateSource(source model.Source) error {
	if source.ChannelType != model.IMDirect && source.ChannelType != model.IMGroup {
		return businessError("INVALID_REQUEST", "channel_type must be im_direct or im_group.")
	}
	if !common.ValidID(source.ConversationID) {
		return businessError("INVALID_REQUEST", "conversation_id must be a canonical UUIDv7.")
	}
	return nil
}
