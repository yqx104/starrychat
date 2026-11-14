package model

// Credentials never appear in serialized business responses.
type ParticipantAccount struct {
	ParticipantID      string          `json:"-"`
	Kind               ParticipantKind `json:"-"`
	OwnerParticipantID *string         `json:"-"`
	Username           string          `json:"-"`
	Password           string          `json:"-"`
	CreatedAt          int64           `json:"-"`
}

type AgentAccount struct {
	ParticipantID      string          `json:"participant_id"`
	Kind               ParticipantKind `json:"kind"`
	Name               string          `json:"name"`
	Username           string          `json:"username"`
	OwnerParticipantID string          `json:"owner_participant_id"`
	CreatedAt          int64           `json:"created_at"`
}

type CreateAgentInput struct {
	Name     string
	Username string
	Password string `json:"-"`
}

type CreateAgentResult struct {
	Agent        AgentAccount `json:"agent"`
	Conversation Conversation `json:"conversation"`
}

type UpdateAgentInput struct {
	ParticipantID string
	Name          *string
	Username      *string
	Password      *string `json:"-"`
}

type RegisterInput struct {
	Username string
	Password string `json:"-"`
	Name     string
}
