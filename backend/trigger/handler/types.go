package handler

import (
	"context"

	"starrychat/backend/trigger/model"
)

type Service interface {
	Health(context.Context) error
	RegisterAgent(context.Context, string) (model.Agent, error)
	Subscribe(context.Context, model.SubscribeInput) (model.SubscriptionResult, error)
	Unsubscribe(context.Context, model.Source, string) error
	ClearChannel(context.Context, model.Source) error
	ReceiveMessage(context.Context, model.Message) (model.MessageResult, error)
}

type AgentResponse struct {
	Agent model.Agent `json:"agent"`
}

type MessageResponse struct {
	model.MessageResult
	Error *ErrorDetail `json:"error,omitempty"`
}

type HealthResponse struct {
	Status string `json:"status"`
}

type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type ErrorResponse struct {
	Error ErrorDetail `json:"error"`
}
