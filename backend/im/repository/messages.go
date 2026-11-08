package repository

import (
	"context"
	"encoding/json"
	"errors"

	"yqx-team/backend/im/model"
)

const messageColumns = "message_id, conversation_id, sender_id, content, quoted_message_id, created_at, mentioned_agent_ids"

func scanMessage(row scanner) (model.Message, error) {
	var message model.Message
	var mentions []byte
	err := row.Scan(&message.MessageID, &message.ConversationID, &message.SenderID, &message.Content, &message.QuotedMessageID, &message.CreatedAt, &mentions)
	if err != nil {
		return message, err
	}
	if err := json.Unmarshal(mentions, &message.MentionedAgentIDs); err != nil {
		return message, err
	}
	if message.MentionedAgentIDs == nil {
		return message, errors.New("stored mentions must be an array")
	}
	for _, id := range message.MentionedAgentIDs {
		if id < 1 || id > model.MaxID {
			return message, errors.New("stored mention is not a safe positive ID")
		}
	}
	return message, nil
}

func (q *Queries) GetMessage(ctx context.Context, id int64) (model.Message, error) {
	return scanMessage(q.db.QueryRowContext(ctx, "SELECT "+messageColumns+" FROM messages WHERE message_id = ?", id))
}

func (q *Queries) InsertMessage(ctx context.Context, message model.Message) (model.Message, error) {
	if message.MentionedAgentIDs == nil {
		message.MentionedAgentIDs = []int64{}
	}
	mentions, err := json.Marshal(message.MentionedAgentIDs)
	if err != nil {
		return model.Message{}, err
	}
	result, err := q.db.ExecContext(ctx, `INSERT INTO messages
		(conversation_id, sender_id, content, quoted_message_id, created_at, mentioned_agent_ids)
		VALUES (?, ?, ?, ?, ?, ?)`, message.ConversationID, message.SenderID, message.Content, message.QuotedMessageID, message.CreatedAt, mentions)
	if err != nil {
		return model.Message{}, err
	}
	message.MessageID, err = insertedID(result)
	return message, err
}

// The service requests limit+1. Initial/before rows are descending; after rows are ascending.
func (q *Queries) ListMessages(ctx context.Context, query model.MessagePageQuery) ([]model.Message, error) {
	sqlQuery := "SELECT " + messageColumns + " FROM messages WHERE conversation_id = ?"
	args := []any{query.ConversationID}
	order := " DESC"
	if query.AfterMessageID != nil {
		sqlQuery += " AND message_id > ?"
		args = append(args, *query.AfterMessageID)
		order = " ASC"
	} else if query.BeforeMessageID != nil {
		sqlQuery += " AND message_id < ?"
		args = append(args, *query.BeforeMessageID)
	}
	args = append(args, query.Limit)
	rows, err := q.db.QueryContext(ctx, sqlQuery+" ORDER BY message_id"+order+" LIMIT ?", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := []model.Message{}
	for rows.Next() {
		message, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		messages = append(messages, message)
	}
	return messages, rows.Err()
}
