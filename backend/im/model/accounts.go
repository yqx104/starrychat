package model

// Credentials never appear in serialized business responses.
type ParticipantAccount struct {
	ParticipantID      int64           `json:"-"`
	Kind               ParticipantKind `json:"-"`
	OwnerParticipantID *int64          `json:"-"`
	Username           string          `json:"-"`
	Password           string          `json:"-"`
	CreatedAt          int64           `json:"-"`
}

type AgentAccount struct {
	ParticipantID      int64           `json:"participant_id"`
	Kind               ParticipantKind `json:"kind"`
	Name               string          `json:"name"`
	Username           string          `json:"username"`
	OwnerParticipantID int64           `json:"owner_participant_id"`
	CreatedAt          int64           `json:"created_at"`
}

type CreateAgentInput struct {
	Name     string
	Username string
	Password string `json:"-"`
}

type UpdateAgentInput struct {
	ParticipantID int64
	Name          *string
	Username      *string
	Password      *string `json:"-"`
}

type RegisterInput struct {
	Username string
	Password string `json:"-"`
	Name     string
	Kind     ParticipantKind
}
