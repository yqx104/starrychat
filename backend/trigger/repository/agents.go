package repository

import (
	"context"

	"yqx-team/backend/trigger/model"
)

func (q *Queries) GetAgent(ctx context.Context, id string) (model.Agent, error) {
	var agent model.Agent
	err := q.db.QueryRowContext(ctx, "SELECT agent_id, created_at FROM agents WHERE agent_id=?", id).
		Scan(&agent.AgentID, &agent.CreatedAt)
	return agent, err
}

func (q *Queries) RegisterAgent(ctx context.Context, id string, createdAt int64) error {
	_, err := q.db.ExecContext(ctx, `INSERT INTO agents (agent_id, created_at) VALUES (?, ?)
		ON DUPLICATE KEY UPDATE agent_id=agent_id`, id, createdAt)
	return err
}
