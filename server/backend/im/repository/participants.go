package repository

import (
	"context"
	"strings"

	"starrychat/backend/im/common"
	"starrychat/backend/im/model"
)

func scanParticipant(row scanner) (model.Participant, error) {
	var participant model.Participant
	err := row.Scan(&participant.ParticipantID, &participant.Kind, &participant.Name, &participant.CreatedAt)
	return participant, err
}

func (q *Queries) GetParticipants(ctx context.Context, ids []string) ([]model.Participant, error) {
	if len(ids) == 0 {
		return []model.Participant{}, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := q.db.QueryContext(ctx, "SELECT participant_id,kind,name,created_at FROM participants WHERE participant_id IN ("+placeholders+") ORDER BY participant_id", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	participants := []model.Participant{}
	for rows.Next() {
		participant, err := scanParticipant(rows)
		if err != nil {
			return nil, err
		}
		participants = append(participants, participant)
	}
	return participants, rows.Err()
}

func (q *Queries) GetParticipant(ctx context.Context, id string) (model.Participant, error) {
	return scanParticipant(q.db.QueryRowContext(ctx, "SELECT participant_id, kind, name, created_at FROM participants WHERE participant_id = ?", id))
}

func (q *Queries) LockParticipant(ctx context.Context, id string) (model.Participant, error) {
	return scanParticipant(q.db.QueryRowContext(ctx, "SELECT participant_id, kind, name, created_at FROM participants WHERE participant_id = ? FOR UPDATE", id))
}

func (q *Queries) SetParticipantName(ctx context.Context, id string, name string) error {
	_, err := q.db.ExecContext(ctx, "UPDATE participants SET name=? WHERE participant_id=?", name, id)
	return err
}

func (q *Queries) ListParticipants(ctx context.Context, kind model.ParticipantKind) ([]model.Participant, error) {
	query := "SELECT participant_id, kind, name, created_at FROM participants"
	var args []any
	if kind != "" {
		query += " WHERE kind = ?"
		args = append(args, kind)
	}
	rows, err := q.db.QueryContext(ctx, query+" ORDER BY participant_id", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	participants := []model.Participant{}
	for rows.Next() {
		participant, err := scanParticipant(rows)
		if err != nil {
			return nil, err
		}
		participants = append(participants, participant)
	}
	return participants, rows.Err()
}

// Low-level storage for future initialization; no registration HTTP endpoint is implied.
func (q *Queries) InsertParticipant(ctx context.Context, kind model.ParticipantKind, name string, createdAt int64) (model.Participant, error) {
	id, err := common.NewID()
	if err != nil {
		return model.Participant{}, err
	}
	_, err = q.db.ExecContext(ctx, "INSERT INTO participants (participant_id, kind, name, created_at) VALUES (?, ?, ?, ?)", id, kind, name, createdAt)
	if err != nil {
		return model.Participant{}, err
	}
	return model.Participant{ParticipantID: id, Kind: kind, Name: name, CreatedAt: createdAt}, err
}
