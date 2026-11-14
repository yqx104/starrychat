package service

import (
	"context"
	"starrychat/backend/im/common/auth"
	"starrychat/backend/im/model"
	"starrychat/backend/im/repository"
)

func (s *Service) ListAgents(ctx context.Context, caller model.RequestContext) ([]model.AgentAccount, error) {
	return read(ctx, s, func(q *repository.Queries) ([]model.AgentAccount, error) {
		human, err := requireHuman(ctx, q, caller, false)
		if err != nil {
			return nil, err
		}
		accounts, err := q.ListAccountsByOwner(ctx, human.ParticipantID)
		if err != nil {
			return nil, err
		}
		ids := make([]string, len(accounts))
		byID := make(map[string]model.ParticipantAccount, len(accounts))
		for i, account := range accounts {
			ids[i] = account.ParticipantID
			byID[account.ParticipantID] = account
		}
		participants, err := q.GetParticipants(ctx, ids)
		if err != nil {
			return nil, err
		}
		agents := []model.AgentAccount{}
		for _, p := range participants {
			account := byID[p.ParticipantID]
			if p.Kind != model.Agent {
				continue
			}
			agents = append(agents, model.AgentAccount{ParticipantID: p.ParticipantID, Kind: model.Agent, Name: p.Name, Username: account.Username, OwnerParticipantID: human.ParticipantID, CreatedAt: p.CreatedAt})
		}
		return agents, nil
	})
}

func (s *Service) CreateAgent(ctx context.Context, caller model.RequestContext, input model.CreateAgentInput) (model.CreateAgentResult, error) {
	result, err := s.register(ctx, caller, model.RegisterInput{Username: input.Username, Password: input.Password, Name: input.Name}, model.Agent)
	if err != nil {
		return model.CreateAgentResult{}, err
	}
	participant := result.participant
	return model.CreateAgentResult{
		Agent:        model.AgentAccount{ParticipantID: participant.ParticipantID, Kind: model.Agent, Name: participant.Name, Username: input.Username, OwnerParticipantID: caller.ParticipantID, CreatedAt: participant.CreatedAt},
		Conversation: result.conversation,
	}, nil
}

func (s *Service) UpdateAgent(ctx context.Context, caller model.RequestContext, input model.UpdateAgentInput) (model.AgentAccount, error) {
	if input.Name == nil && input.Username == nil && input.Password == nil {
		return model.AgentAccount{}, businessError("INVALID_REQUEST", "At least one account field is required.")
	}
	if input.Name != nil && !validName(*input.Name) {
		return model.AgentAccount{}, businessError("INVALID_REQUEST", "Name must be 1–100 characters and cannot be blank.")
	}
	if input.Username != nil {
		if err := auth.ValidateUsername(*input.Username); err != nil {
			return model.AgentAccount{}, businessError("INVALID_REQUEST", err.Error())
		}
	}
	if input.Password != nil {
		if err := auth.ValidatePassword(*input.Password); err != nil {
			return model.AgentAccount{}, businessError("INVALID_REQUEST", err.Error())
		}
	}
	agent, err := write(ctx, s, func(q *repository.Queries) (model.AgentAccount, error) {
		human, err := requireHuman(ctx, q, caller, true)
		if err != nil {
			return model.AgentAccount{}, err
		}
		if _, err := requireOwnedAgent(ctx, q, human.ParticipantID, input.ParticipantID); err != nil {
			return model.AgentAccount{}, err
		}
		participant, err := q.LockParticipant(ctx, input.ParticipantID)
		if err != nil {
			return model.AgentAccount{}, err
		}
		account, err := q.LockAccount(ctx, input.ParticipantID)
		if err != nil {
			return model.AgentAccount{}, err
		}
		if input.Name != nil {
			participant.Name = *input.Name
			if err := q.SetParticipantName(ctx, participant.ParticipantID, participant.Name); err != nil {
				return model.AgentAccount{}, err
			}
		}
		if input.Username != nil {
			account.Username = *input.Username
		}
		if input.Password != nil {
			account.Password = *input.Password
		}
		if input.Username != nil || input.Password != nil {
			if err := q.UpdateAccountCredentials(ctx, account.ParticipantID, account.Username, account.Password); err != nil {
				return model.AgentAccount{}, err
			}
		}
		return model.AgentAccount{ParticipantID: participant.ParticipantID, Kind: model.Agent, Name: participant.Name, Username: account.Username, OwnerParticipantID: human.ParticipantID, CreatedAt: participant.CreatedAt}, nil
	})
	return agent, accountError(err)
}
