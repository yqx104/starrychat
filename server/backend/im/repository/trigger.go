package repository

import (
	"context"
	"encoding/json"
	"time"

	"starrychat/backend/im/model"
)

// EnqueueTrigger runs in the business transaction. Agent registration has no
// conversation; conversation events are written while that conversation is locked.
func (q *Queries) EnqueueTrigger(ctx context.Context, conversationID *string, operation string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	_, err = q.db.ExecContext(ctx, `INSERT INTO trigger_outbox
		(conversation_id, operation, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)`,
		conversationID, operation, data, now, now)
	return err
}

// Only a conversation's oldest event is eligible, including while that event waits to retry.
// Agent registrations have no conversation and are independently eligible.
// The row lock stays held through the HTTP call so concurrent workers cannot overtake it.
func (q *Queries) NextTriggerEvent(ctx context.Context, now int64) (model.TriggerEvent, error) {
	var event model.TriggerEvent
	err := q.db.QueryRowContext(ctx, `SELECT pending.id, pending.conversation_id, pending.operation, pending.payload, pending.attempts
		FROM trigger_outbox AS pending
		WHERE pending.next_attempt_at<=? AND NOT EXISTS (
			SELECT 1 FROM trigger_outbox AS earlier
			WHERE earlier.conversation_id=pending.conversation_id AND earlier.id<pending.id
		)
		ORDER BY pending.id LIMIT 1 FOR UPDATE SKIP LOCKED`, now).
		Scan(&event.ID, &event.ConversationID, &event.Operation, &event.Payload, &event.Attempts)
	return event, err
}

func (q *Queries) RetryTriggerEvent(ctx context.Context, id, nextAttemptAt int64) error {
	_, err := q.db.ExecContext(ctx, "UPDATE trigger_outbox SET attempts=LEAST(attempts+1,16), next_attempt_at=? WHERE id=?", nextAttemptAt, id)
	return err
}

func (q *Queries) DeleteTriggerEvent(ctx context.Context, id int64) error {
	_, err := q.db.ExecContext(ctx, "DELETE FROM trigger_outbox WHERE id=?", id)
	return err
}
