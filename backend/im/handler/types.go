package handler

import (
	"context"

	"yqx-team/backend/im/model"
)

const MaxID = model.MaxID
const (
	Human = model.Human
	Agent = model.Agent
)

// Aliases preserve the handler contract while lower layers depend only on model.
type ParticipantKind = model.ParticipantKind
type Participant = model.Participant
type Conversation = model.Conversation
type Message = model.Message
type RequestContext = model.RequestContext
type ParticipantsQuery = model.ParticipantsQuery
type CreateGroupInput = model.CreateGroupInput
type OpenDirectInput = model.OpenDirectInput
type RenameGroupInput = model.RenameGroupInput
type AddMemberInput = model.AddMemberInput
type RemoveMemberInput = model.RemoveMemberInput
type SendMessageInput = model.SendMessageInput
type MessagePageQuery = model.MessagePageQuery
type MessagePage = model.MessagePage
type ServiceError = model.ServiceError

type callerKey struct{}

// WithCaller is for the trusted adapter; identity is never inferred from HTTP input.
func WithCaller(ctx context.Context, caller RequestContext) context.Context {
	return context.WithValue(ctx, callerKey{}, caller)
}

type ParticipantsResponse struct {
	Participants []Participant `json:"participants"`
}

type ConversationsResponse struct {
	Conversations []Conversation `json:"conversations"`
}

type ConversationResponse struct {
	Conversation Conversation `json:"conversation"`
}

type MembersResponse struct {
	Members []Participant `json:"members"`
}

type MemberResponse struct {
	Member Participant `json:"member"`
}

type MessageResponse struct {
	Message Message `json:"message"`
}

type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type ErrorResponse struct {
	Error ErrorDetail `json:"error"`
}

// Service is an injected dependency, not a business implementation.
type Service interface {
	ListParticipants(context.Context, RequestContext, ParticipantsQuery) ([]Participant, error)
	ListConversations(context.Context, RequestContext) ([]Conversation, error)
	CreateGroup(context.Context, RequestContext, CreateGroupInput) (Conversation, error)
	OpenDirect(context.Context, RequestContext, OpenDirectInput) (Conversation, error)
	GetConversation(context.Context, RequestContext, int64) (Conversation, error)
	RenameGroup(context.Context, RequestContext, RenameGroupInput) (Conversation, error)
	DissolveGroup(context.Context, RequestContext, int64) (Conversation, error)
	ListMembers(context.Context, RequestContext, int64) ([]Participant, error)
	AddMember(context.Context, RequestContext, AddMemberInput) (Participant, error)
	RemoveMember(context.Context, RequestContext, RemoveMemberInput) error
	ListMessages(context.Context, RequestContext, MessagePageQuery) (MessagePage, error)
	SendMessage(context.Context, RequestContext, SendMessageInput) (Message, error)
}
