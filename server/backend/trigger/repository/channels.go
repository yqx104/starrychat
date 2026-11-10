package repository

import (
	"context"

	"starrychat/backend/trigger/model"
)

const channelColumns = "agent_id, channel_id, channel_type, conversation_id, created_at"

func scanChannel(row scanner) (model.Channel, error) {
	var channel model.Channel
	err := row.Scan(&channel.AgentID, &channel.ChannelID, &channel.ChannelType, &channel.ConversationID, &channel.CreatedAt)
	return channel, err
}

func (q *Queries) ListChannels(ctx context.Context, source model.Source) ([]model.Channel, error) {
	rows, err := q.db.QueryContext(ctx, "SELECT "+channelColumns+" FROM channels WHERE channel_type=? AND conversation_id=? ORDER BY agent_id",
		source.ChannelType, source.ConversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	channels := []model.Channel{}
	for rows.Next() {
		channel, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		channels = append(channels, channel)
	}
	return channels, rows.Err()
}

func (q *Queries) InsertChannel(ctx context.Context, channel model.Channel) error {
	_, err := q.db.ExecContext(ctx, "INSERT INTO channels ("+channelColumns+") VALUES (?, ?, ?, ?, ?)",
		channel.AgentID, channel.ChannelID, channel.ChannelType, channel.ConversationID, channel.CreatedAt)
	return err
}

func (q *Queries) DeleteSubscription(ctx context.Context, source model.Source, agentID string) error {
	_, err := q.db.ExecContext(ctx, "DELETE FROM channels WHERE channel_type=? AND conversation_id=? AND agent_id=?",
		source.ChannelType, source.ConversationID, agentID)
	return err
}

func (q *Queries) DeleteChannel(ctx context.Context, source model.Source) error {
	_, err := q.db.ExecContext(ctx, "DELETE FROM channels WHERE channel_type=? AND conversation_id=?",
		source.ChannelType, source.ConversationID)
	return err
}
