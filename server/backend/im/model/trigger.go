package model

import "encoding/json"

type TriggerAgentRegistration struct {
	AgentID string `json:"agent_id"`
}

type TriggerSource struct {
	ChannelType    string `json:"channel_type"`
	ConversationID string `json:"conversation_id"`
}

type TriggerSubscription struct {
	TriggerSource
	AgentIDs []string `json:"agent_ids"`
}

type TriggerUnsubscription struct {
	TriggerSource
	AgentID string `json:"agent_id"`
}

type TriggerMessage struct {
	Message
	ChannelType string          `json:"channel_type"`
	SenderKind  ParticipantKind `json:"sender_kind"`
}

const (
	TriggerRegisterAgent = "register_agent"
	TriggerSubscribe     = "subscribe"
	TriggerUnsubscribe   = "unsubscribe"
	TriggerClear         = "clear"
	TriggerSendMessage   = "message"
)

type TriggerEvent struct {
	ID             int64
	ConversationID *string
	Operation      string
	Payload        json.RawMessage
	Attempts       int
}
