package repository

import (
	"context"
	"encoding/json"
	"time"

	"starrychat/backend/trigger/model"
)

func (r *Repository) Enqueue(ctx context.Context, deliveries []model.Delivery) error {
	return r.WithinTx(ctx, func(q *Queries) error {
		for _, item := range deliveries {
			payload, err := json.Marshal(item)
			if err != nil {
				return err
			}
			_, err = q.db.ExecContext(ctx, `INSERT INTO deliveries (agent_id, channel_id, message_id, message_seq, payload, created_at)
				VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id=id`,
				item.AgentID, item.ChannelID, item.Message.MessageID, item.Message.MessageSeq, payload, time.Now().UnixMilli())
			if err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *Repository) PendingChannels(ctx context.Context, agentID string) ([]string, error) {
	rows, err := r.pool.QueryContext(ctx, `SELECT DISTINCT channel_id FROM deliveries
		WHERE agent_id=? AND acked_at IS NULL`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var channels []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		channels = append(channels, id)
	}
	return channels, rows.Err()
}

func (r *Repository) NextDelivery(ctx context.Context, agentID, channelID string) (model.Delivery, error) {
	var payload []byte
	var item model.Delivery
	err := r.pool.QueryRowContext(ctx, `SELECT payload FROM deliveries
		WHERE agent_id=? AND channel_id=? AND acked_at IS NULL ORDER BY message_seq LIMIT 1`, agentID, channelID).Scan(&payload)
	if err != nil {
		return item, err
	}
	err = json.Unmarshal(payload, &item)
	return item, err
}

func (r *Repository) Acknowledge(ctx context.Context, agentID, messageID string) error {
	_, err := r.pool.ExecContext(ctx, `UPDATE deliveries SET acked_at=?
		WHERE agent_id=? AND message_id=? AND acked_at IS NULL`, time.Now().UnixMilli(), agentID, messageID)
	return err
}
