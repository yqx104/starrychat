package repository

import (
	"context"
	"errors"

	"starrychat/backend/im/common"
	"starrychat/backend/im/model"
)

// NextMessageSeq runs in the sending transaction, after locking the conversation.
// The counter and message commit together; a failed send rolls both back.
func (q *Queries) NextMessageSeq(ctx context.Context, id string) (int64, error) {
	result, err := q.db.ExecContext(ctx, "UPDATE conversations SET last_message_seq=last_message_seq+1 WHERE conversation_id=? AND last_message_seq<?", id, model.MaxSeq)
	if err != nil {
		return 0, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if rows != 1 {
		return 0, errors.New("conversation missing or message sequence exhausted")
	}
	var seq int64
	err = q.db.QueryRowContext(ctx, "SELECT last_message_seq FROM conversations WHERE conversation_id=?", id).Scan(&seq)
	return seq, err
}

func scanConversation(row scanner) (model.Conversation, error) {
	var conversation model.Conversation
	err := row.Scan(&conversation.ConversationID, &conversation.Kind, &conversation.Title, &conversation.CreatedAt, &conversation.DissolvedAt)
	return conversation, err
}

func (q *Queries) GetConversation(ctx context.Context, id string) (model.Conversation, error) {
	return scanConversation(q.db.QueryRowContext(ctx, "SELECT conversation_id, kind, title, created_at, dissolved_at FROM conversations WHERE conversation_id = ?", id))
}

func (q *Queries) LockConversation(ctx context.Context, id string) (model.Conversation, error) {
	return scanConversation(q.db.QueryRowContext(ctx, "SELECT conversation_id, kind, title, created_at, dissolved_at FROM conversations WHERE conversation_id = ? FOR UPDATE", id))
}

func (q *Queries) ListConversationMemberships(ctx context.Context, participantID string) ([]model.Membership, error) {
	rows, err := q.db.QueryContext(ctx, "SELECT conversation_id, participant_id, created_at, hidden FROM conversation_members WHERE participant_id = ? ORDER BY conversation_id", participantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	memberships := []model.Membership{}
	for rows.Next() {
		membership, err := scanMembership(rows)
		if err != nil {
			return nil, err
		}
		memberships = append(memberships, membership)
	}
	return memberships, rows.Err()
}

func (q *Queries) InsertConversation(ctx context.Context, kind string, title *string, createdAt int64) (model.Conversation, error) {
	id, err := common.NewID()
	if err != nil {
		return model.Conversation{}, err
	}
	_, err = q.db.ExecContext(ctx, "INSERT INTO conversations (conversation_id, kind, title, created_at) VALUES (?, ?, ?, ?)", id, kind, title, createdAt)
	if err != nil {
		return model.Conversation{}, err
	}
	return model.Conversation{ConversationID: id, Kind: kind, Title: title, CreatedAt: createdAt}, err
}

func (q *Queries) SetConversationTitle(ctx context.Context, id string, title string) error {
	_, err := q.db.ExecContext(ctx, "UPDATE conversations SET title = ? WHERE conversation_id = ?", title, id)
	return err
}

func (q *Queries) SetDissolvedAt(ctx context.Context, id string, dissolvedAt int64) error {
	_, err := q.db.ExecContext(ctx, "UPDATE conversations SET dissolved_at = ? WHERE conversation_id = ?", dissolvedAt, id)
	return err
}
