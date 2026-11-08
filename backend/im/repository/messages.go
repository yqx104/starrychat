package repository

import (
	"context"
	"encoding/json"
	"errors"

	"starrychat/backend/im/common"
	"starrychat/backend/im/model"
)

const messageColumns = "message_id, message_seq, conversation_id, sender_id, content, quoted_message_id, created_at, mentioned_agent_ids"

func scanMessage(row scanner) (model.Message, error) {
	var message model.Message
	var mentions []byte
	err := row.Scan(&message.MessageID, &message.MessageSeq, &message.ConversationID, &message.SenderID, &message.Content, &message.QuotedMessageID, &message.CreatedAt, &mentions)
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
		if !common.ValidID(id) {
			return message, errors.New("stored mention is not a canonical UUIDv7")
		}
	}
	return message, nil
}

func (q *Queries) GetMessage(ctx context.Context, id string) (model.Message, error) {
	return scanMessage(q.db.QueryRowContext(ctx, "SELECT "+messageColumns+" FROM messages WHERE message_id = ?", id))
}

func (q *Queries) InsertMessage(ctx context.Context, message model.Message) (model.Message, error) {
	if message.MentionedAgentIDs == nil {
		message.MentionedAgentIDs = []string{}
	}
	mentions, err := json.Marshal(message.MentionedAgentIDs)
	if err != nil {
		return model.Message{}, err
	}
	message.MessageID, err = common.NewID()
	if err != nil {
		return model.Message{}, err
	}
	_, err = q.db.ExecContext(ctx, `INSERT INTO messages
		(message_id, message_seq, conversation_id, sender_id, content, quoted_message_id, created_at, mentioned_agent_ids)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, message.MessageID, message.MessageSeq, message.ConversationID, message.SenderID, message.Content, message.QuotedMessageID, message.CreatedAt, mentions)
	if err != nil {
		return model.Message{}, err
	}
	return message, err
}

// The service requests limit+1. Initial/before rows are descending; after rows are ascending.
func (q *Queries) ListMessages(ctx context.Context, query model.MessagePageQuery) ([]model.Message, error) {
	sqlQuery := "SELECT " + messageColumns + " FROM messages WHERE conversation_id = ?"
	args := []any{query.ConversationID}
	order := " DESC"
	if query.AfterSeq != nil {
		sqlQuery += " AND message_seq > ?"
		args = append(args, *query.AfterSeq)
		order = " ASC"
	} else if query.BeforeSeq != nil {
		sqlQuery += " AND message_seq < ?"
		args = append(args, *query.BeforeSeq)
	}
	args = append(args, query.Limit)
	rows, err := q.db.QueryContext(ctx, sqlQuery+" ORDER BY message_seq"+order+" LIMIT ?", args...)
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
