package repository

import (
	"context"

	"yqx-team/backend/im/model"
)

func scanMembership(row scanner) (model.Membership, error) {
	var member model.Membership
	err := row.Scan(&member.ConversationID, &member.ParticipantID, &member.CreatedAt)
	return member, err
}

func (q *Queries) GetMembership(ctx context.Context, conversationID, participantID string) (model.Membership, error) {
	return scanMembership(q.db.QueryRowContext(ctx, "SELECT conversation_id, participant_id, created_at FROM conversation_members WHERE conversation_id = ? AND participant_id = ?", conversationID, participantID))
}

func (q *Queries) ListMemberships(ctx context.Context, conversationID string) ([]model.Membership, error) {
	rows, err := q.db.QueryContext(ctx, "SELECT conversation_id, participant_id, created_at FROM conversation_members WHERE conversation_id = ? ORDER BY participant_id", conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := []model.Membership{}
	for rows.Next() {
		member, err := scanMembership(rows)
		if err != nil {
			return nil, err
		}
		members = append(members, member)
	}
	return members, rows.Err()
}

func (q *Queries) InsertMember(ctx context.Context, conversationID, participantID string, createdAt int64) error {
	_, err := q.db.ExecContext(ctx, "INSERT INTO conversation_members (conversation_id, participant_id, created_at) VALUES (?, ?, ?)", conversationID, participantID, createdAt)
	return err
}

func (q *Queries) DeleteMember(ctx context.Context, conversationID, participantID string) error {
	_, err := q.db.ExecContext(ctx, "DELETE FROM conversation_members WHERE conversation_id = ? AND participant_id = ?", conversationID, participantID)
	return err
}
