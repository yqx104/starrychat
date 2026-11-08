package repository

import (
	"context"

	"yqx-team/backend/im/model"
)

func scanConversation(row scanner) (model.Conversation, error) {
	var conversation model.Conversation
	err := row.Scan(&conversation.ConversationID, &conversation.Kind, &conversation.Title, &conversation.CreatedAt, &conversation.DissolvedAt)
	return conversation, err
}

func (q *Queries) GetConversation(ctx context.Context, id int64) (model.Conversation, error) {
	return scanConversation(q.db.QueryRowContext(ctx, "SELECT conversation_id, kind, title, created_at, dissolved_at FROM conversations WHERE conversation_id = ?", id))
}

func (q *Queries) LockConversation(ctx context.Context, id int64) (model.Conversation, error) {
	return scanConversation(q.db.QueryRowContext(ctx, "SELECT conversation_id, kind, title, created_at, dissolved_at FROM conversations WHERE conversation_id = ? FOR UPDATE", id))
}

func (q *Queries) ListConversationIDs(ctx context.Context, participantID int64) ([]int64, error) {
	rows, err := q.db.QueryContext(ctx, "SELECT conversation_id FROM conversation_members WHERE participant_id = ? ORDER BY conversation_id", participantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (q *Queries) InsertConversation(ctx context.Context, kind string, title *string, createdAt int64) (model.Conversation, error) {
	result, err := q.db.ExecContext(ctx, "INSERT INTO conversations (kind, title, created_at) VALUES (?, ?, ?)", kind, title, createdAt)
	if err != nil {
		return model.Conversation{}, err
	}
	id, err := insertedID(result)
	return model.Conversation{ConversationID: id, Kind: kind, Title: title, CreatedAt: createdAt}, err
}

func (q *Queries) SetConversationTitle(ctx context.Context, id int64, title string) error {
	_, err := q.db.ExecContext(ctx, "UPDATE conversations SET title = ? WHERE conversation_id = ?", title, id)
	return err
}

func (q *Queries) SetDissolvedAt(ctx context.Context, id, dissolvedAt int64) error {
	_, err := q.db.ExecContext(ctx, "UPDATE conversations SET dissolved_at = ? WHERE conversation_id = ?", dissolvedAt, id)
	return err
}
