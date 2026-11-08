package model

type ChannelType string

const (
	IMDirect ChannelType = "im_direct"
	IMGroup  ChannelType = "im_group"
)

type Agent struct {
	AgentID   string `json:"agent_id"`
	CreatedAt int64  `json:"created_at"`
}

// Channel is one agent's subscription; subscribers to a source conversation share ChannelID.
type Channel struct {
	AgentID        string      `json:"agent_id"`
	ChannelID      string      `json:"channel_id"`
	ChannelType    ChannelType `json:"channel_type"`
	ConversationID string      `json:"conversation_id"`
	CreatedAt      int64       `json:"created_at"`
}

type Source struct {
	ChannelType    ChannelType `json:"channel_type"`
	ConversationID string      `json:"conversation_id"`
}

type SubscribeInput struct {
	Source
	AgentIDs []string `json:"agent_ids"`
}

type SubscriptionResult struct {
	ChannelID string    `json:"channel_id"`
	Channels  []Channel `json:"channels"`
}

type Message struct {
	Source
	MessageID         string   `json:"message_id"`
	MessageSeq        int64    `json:"message_seq"`
	SenderID          string   `json:"sender_id"`
	SenderKind        string   `json:"sender_kind"`
	Content           string   `json:"content"`
	MentionedAgentIDs []string `json:"mentioned_agent_ids"`
	QuotedMessageID   *string  `json:"quoted_message_id"`
	CreatedAt         int64    `json:"created_at"`
}

// Delivery is the envelope accepted by an Agent adapter, not a model execution result.
type Delivery struct {
	AgentID   string  `json:"agent_id"`
	ChannelID string  `json:"channel_id"`
	Message   Message `json:"message"`
}

type MessageResult struct {
	ChannelID         string   `json:"channel_id,omitempty"`
	DeliveredAgentIDs []string `json:"delivered_agent_ids"`
	FailedAgentIDs    []string `json:"failed_agent_ids"`
}

type ServiceError struct {
	Code    string
	Message string
}

func (e *ServiceError) Error() string { return e.Message }
