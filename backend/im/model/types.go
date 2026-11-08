package model

const MaxSeq int64 = 1<<53 - 1

type ParticipantKind string

const (
	Human ParticipantKind = "human"
	Agent ParticipantKind = "agent"
)

type Participant struct {
	ParticipantID string          `json:"participant_id"`
	Kind          ParticipantKind `json:"kind"`
	Name          string          `json:"name"`
	CreatedAt     int64           `json:"created_at"`
}

type Conversation struct {
	ConversationID string  `json:"conversation_id"`
	Kind           string  `json:"kind"`
	Title          *string `json:"title"`
	CreatedAt      int64   `json:"created_at"`
	DissolvedAt    *int64  `json:"dissolved_at"`
}

type Message struct {
	MessageSeq        int64    `json:"message_seq"`
	MessageID         string   `json:"message_id"`
	ConversationID    string   `json:"conversation_id"`
	SenderID          string   `json:"sender_id"`
	Content           string   `json:"content"`
	QuotedMessageID   *string  `json:"quoted_message_id"`
	CreatedAt         int64    `json:"created_at"`
	MentionedAgentIDs []string `json:"mentioned_agent_ids"`
}

type RequestContext struct {
	ParticipantID string
}

type ParticipantsQuery struct {
	Kind ParticipantKind
}

type CreateGroupInput struct {
	Title    string
	AgentIDs []string
}

type OpenDirectInput struct {
	AgentID string
}

type RenameGroupInput struct {
	ConversationID string
	Title          string
}

type AddMemberInput struct {
	ConversationID string
	ParticipantID  string
}

type RemoveMemberInput struct {
	ConversationID string
	ParticipantID  string
}

type SendMessageInput struct {
	ConversationID    string
	Content           string
	MentionedAgentIDs []string
	QuotedMessageID   *string
}

type MessagePageQuery struct {
	ConversationID string
	Limit          int
	BeforeSeq      *int64
	AfterSeq       *int64
}

type MessagePage struct {
	// Ascending by message_seq; initial/before pages select the nearest older messages.
	Messages []Message `json:"messages"`
	// More in the queried direction: older for initial/before, newer for after.
	HasMore bool `json:"has_more"`
}

type ServiceError struct {
	Code    string
	Message string
}

func (e *ServiceError) Error() string { return e.Message }

type Membership struct {
	ConversationID string
	ParticipantID  string
	CreatedAt      int64
}
