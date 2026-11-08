package service

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-sql-driver/mysql"
	"yqx-team/backend/im/common"
	"yqx-team/backend/im/common/auth"
	"yqx-team/backend/im/model"
	"yqx-team/backend/im/repository"
)

func accountError(err error) error {
	var duplicate *mysql.MySQLError
	if errors.As(err, &duplicate) && duplicate.Number == 1062 {
		return businessError("CONFLICT", "The username or participant account already exists.")
	}
	return err
}

func (s *Service) Register(ctx context.Context, caller model.RequestContext, input model.RegisterInput) (model.Participant, error) {
	if err := auth.ValidateCredentials(input.Username, input.Password); err != nil {
		return model.Participant{}, businessError("INVALID_REQUEST", err.Error())
	}
	if !validName(input.Name) || (input.Kind != model.Human && input.Kind != model.Agent) {
		return model.Participant{}, businessError("INVALID_REQUEST", "Name must be 1–100 characters and kind must be human or agent.")
	}
	participant, err := write(ctx, s, func(q *repository.Queries) (model.Participant, error) {
		var ownerID *string
		if input.Kind == model.Agent {
			if _, err := requireHuman(ctx, q, caller, true); err != nil {
				return model.Participant{}, err
			}
			owner := caller.ParticipantID
			ownerID = &owner
		}
		now := time.Now().UnixMilli()
		participant, err := q.InsertParticipant(ctx, input.Kind, input.Name, now)
		if err != nil {
			return model.Participant{}, err
		}
		err = q.InsertAccount(ctx, model.ParticipantAccount{ParticipantID: participant.ParticipantID, Kind: input.Kind, OwnerParticipantID: ownerID, Username: input.Username, Password: input.Password, CreatedAt: now})
		return participant, err
	})
	return participant, accountError(err)
}

func (s *Service) Login(ctx context.Context, username, password string) (model.Participant, error) {
	if err := auth.ValidateCredentials(username, password); err != nil {
		return model.Participant{}, businessError("INVALID_REQUEST", err.Error())
	}
	account, err := s.repository.GetAccountByUsername(ctx, username)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return model.Participant{}, err
	}
	if err != nil || account.Password != password {
		return model.Participant{}, businessError("UNAUTHORIZED", "Invalid username or password.")
	}
	return s.AuthenticatedParticipant(ctx, account.ParticipantID)
}

func (s *Service) AuthenticatedParticipant(ctx context.Context, id string) (model.Participant, error) {
	if !common.ValidID(id) {
		return model.Participant{}, businessError("UNAUTHORIZED", "Authentication required.")
	}
	return read(ctx, s, func(q *repository.Queries) (model.Participant, error) {
		if _, err := q.GetAccount(ctx, id); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				err = businessError("UNAUTHORIZED", "Authentication required.")
			}
			return model.Participant{}, err
		}
		participant, err := q.GetParticipant(ctx, id)
		if errors.Is(err, sql.ErrNoRows) {
			err = businessError("UNAUTHORIZED", "Authentication required.")
		}
		if err == nil {
			_, err = ownerOf(ctx, q, participant)
			var denied *model.ServiceError
			if errors.As(err, &denied) {
				err = businessError("UNAUTHORIZED", "Authentication required.")
			}
		}
		return participant, err
	})
}

// Local maintenance only. No HTTP route accepts an existing participant ID for binding.
func (s *Service) BindHumanAccount(ctx context.Context, participantID string, username, password string) (model.Participant, error) {
	if !common.ValidID(participantID) {
		return model.Participant{}, businessError("INVALID_REQUEST", "An explicit human participant_id is required.")
	}
	if err := auth.ValidateCredentials(username, password); err != nil {
		return model.Participant{}, businessError("INVALID_REQUEST", err.Error())
	}
	participant, err := write(ctx, s, func(q *repository.Queries) (model.Participant, error) {
		participant, err := q.LockParticipant(ctx, participantID)
		if errors.Is(err, sql.ErrNoRows) {
			err = businessError("NOT_FOUND", "No existing human participant to bind.")
		}
		if err != nil {
			return model.Participant{}, err
		}
		if participant.Kind != model.Human {
			return model.Participant{}, businessError("INVALID_OPERATION", "Only an existing human can be bound.")
		}
		err = q.InsertAccount(ctx, model.ParticipantAccount{ParticipantID: participant.ParticipantID, Kind: model.Human, Username: username, Password: password, CreatedAt: time.Now().UnixMilli()})
		return participant, err
	})
	return participant, accountError(err)
}

func validName(name string) bool {
	return utf8.ValidString(name) && utf8.RuneCountInString(name) <= 100 && strings.TrimFunc(name, func(r rune) bool { return unicode.IsSpace(r) || r == '\ufeff' }) != ""
}
