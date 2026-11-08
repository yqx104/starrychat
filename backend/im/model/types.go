package model

const MaxID int64 = 1<<53 - 1

type ParticipantKind string

const (
	Human ParticipantKind = "human"
	Agent ParticipantKind = "agent"
)

type Participant struct {
	ParticipantID int64           `json:"participant_id"`
	Kind          ParticipantKind `json:"kind"`
	Name          string          `json:"name"`
	CreatedAt     int64           `json:"created_at"`
}

type Conversation struct {
	ConversationID int64   `json:"conversation_id"`
	Kind           string  `json:"kind"`
	Title          *string `json:"title"`
	CreatedAt      int64   `json:"created_at"`
	DissolvedAt    *int64  `json:"dissolved_at"`
}

type Message struct {
	MessageID         int64   `json:"message_id"`
	ConversationID    int64   `json:"conversation_id"`
	SenderID          int64   `json:"sender_id"`
	Content           string  `json:"content"`
	QuotedMessageID   *int64  `json:"quoted_message_id"`
	CreatedAt         int64   `json:"created_at"`
	MentionedAgentIDs []int64 `json:"mentioned_agent_ids"`
}

type RequestContext struct {
	ParticipantID int64
}

type ParticipantsQuery struct {
	Kind ParticipantKind
}

type CreateGroupInput struct {
	Title    string
	AgentIDs []int64
}

type OpenDirectInput struct {
	AgentID int64
}

type RenameGroupInput struct {
	ConversationID int64
	Title          string
}

type AddMemberInput struct {
	ConversationID int64
	ParticipantID  int64
}

type RemoveMemberInput struct {
	ConversationID int64
	ParticipantID  int64
}

type SendMessageInput struct {
	ConversationID    int64
	Content           string
	MentionedAgentIDs []int64
	QuotedMessageID   *int64
}

type MessagePageQuery struct {
	ConversationID  int64
	Limit           int
	BeforeMessageID *int64
	AfterMessageID  *int64
}

type MessagePage struct {
	// Ascending by message_id; initial/before pages select the nearest older messages.
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
	ConversationID int64
	ParticipantID  int64
	CreatedAt      int64
}
