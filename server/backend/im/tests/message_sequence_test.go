package tests

import (
	"context"
	"database/sql"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"starrychat/backend/im/common"
	"starrychat/backend/im/handler"
	"starrychat/backend/im/model"
	"starrychat/backend/im/repository"
	"starrychat/backend/im/service"
)

func runMessageSequenceTests(t *testing.T, instance *mysqlInstance) {
	t.Run("independent_pools_allocate_unique_per_conversation_sequences", func(t *testing.T) {
		f := newIMFixture(t, instance)
		one, two := f.group(t), f.group(t)
		store, err := repository.Open(t.Context(), f.dsn)
		if err != nil {
			t.Fatal(err)
		}
		defer store.Close()
		other := *f
		other.handle = handler.New(service.New(store, nil))
		responses := parallelResponses(t, 64, func(ctx context.Context, i int) *httptest.ResponseRecorder {
			target, conversation := f, one
			if i%2 == 1 {
				target = &other
			}
			if i%4 >= 2 {
				conversation = two
			}
			return target.request(ctx, "POST", "/conversations/"+conversation.ConversationID+"/messages", map[string]any{"content": "Concurrent"}, f.human.ParticipantID)
		})
		ids := map[string]bool{}
		for _, response := range responses {
			message := responseValue[handler.MessageResponse](t, response, 201).Message
			if !common.ValidID(message.MessageID) || ids[message.MessageID] {
				t.Fatal("invalid or duplicate message UUID")
			}
			ids[message.MessageID] = true
		}
		for _, conversation := range []model.Conversation{one, two} {
			page := apiJSON[handler.MessagePage](t, f, "/conversations/"+conversation.ConversationID+"/messages?after_seq=0")
			equalValue(t, len(page.Messages), 32)
			for i, message := range page.Messages {
				equalValue(t, message.MessageSeq, int64(i+1))
			}
			equalValue(t, f.count(t, "SELECT last_message_seq FROM conversations WHERE conversation_id=?", conversation.ConversationID), int64(32))
		}
	})
	t.Run("counter_rolls_back_with_failed_insert_and_survives_restart", func(t *testing.T) {
		f := newIMFixture(t, instance)
		group := f.group(t)
		first := f.send(t, group.ConversationID, "First", f.human)
		err := f.store.WithinTx(t.Context(), &sql.TxOptions{Isolation: sql.LevelReadCommitted}, func(q *repository.Queries) error {
			if _, err := q.LockConversation(t.Context(), group.ConversationID); err != nil {
				return err
			}
			seq, err := q.NextMessageSeq(t.Context(), group.ConversationID)
			if err != nil {
				return err
			}
			equalValue(t, seq, int64(2))
			_, err = q.InsertMessage(t.Context(), model.Message{MessageSeq: seq, ConversationID: group.ConversationID, SenderID: "invalid", Content: "Rejected", CreatedAt: 1})
			return err
		})
		if err == nil {
			t.Fatal("invalid message inserted")
		}
		equalValue(t, f.count(t, "SELECT last_message_seq FROM conversations WHERE conversation_id=?", group.ConversationID), int64(1))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM messages"), int64(1))
		if err := f.store.Close(); err != nil {
			t.Fatal(err)
		}
		f.store, err = repository.Open(t.Context(), f.dsn)
		if err != nil {
			t.Fatal(err)
		}
		f.handle = handler.New(service.New(f.store, nil))
		second := f.send(t, group.ConversationID, "After reopen", f.human)
		equalValue(t, second.MessageSeq, int64(2))
		// Reverse UUID and timestamp order: sequence alone determines pagination.
		f.exec(t, "UPDATE messages SET message_id=?,created_at=2 WHERE message_id=?", testID(200), first.MessageID)
		f.exec(t, "UPDATE messages SET message_id=?,created_at=1 WHERE message_id=?", testID(100), second.MessageID)
		page := apiJSON[handler.MessagePage](t, f, "/conversations/"+group.ConversationID+"/messages?after_seq=0")
		equalValue(t, page.Messages[0].MessageID, testID(200))
		equalValue(t, page.Messages[1].MessageID, testID(100))
		older := apiJSON[handler.MessagePage](t, f, "/conversations/"+group.ConversationID+"/messages?before_seq=2")
		equalValue(t, len(older.Messages), 1)
		equalValue(t, older.Messages[0].MessageSeq, int64(1))
	})
	t.Run("uncommitted_sequence_cannot_be_overtaken_and_other_chat_progresses", func(t *testing.T) {
		f := newIMFixture(t, instance)
		one, two := f.group(t), f.group(t)
		locked, release, finished := make(chan struct{}), make(chan struct{}), make(chan error, 1)
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		sentinel := errors.New("rollback held message")
		go func() {
			finished <- f.store.WithinTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted}, func(q *repository.Queries) error {
				if _, err := q.LockConversation(ctx, one.ConversationID); err != nil {
					return err
				}
				seq, err := q.NextMessageSeq(ctx, one.ConversationID)
				if err != nil {
					return err
				}
				if _, err = q.InsertMessage(ctx, model.Message{MessageSeq: seq, ConversationID: one.ConversationID, SenderID: f.human.ParticipantID, Content: "Uncommitted", CreatedAt: 1}); err != nil {
					return err
				}
				close(locked)
				select {
				case <-release:
					return sentinel
				case <-ctx.Done():
					return ctx.Err()
				}
			})
		}()
		select {
		case <-locked:
		case err := <-finished:
			t.Fatal(err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			done <- f.request(ctx, "POST", "/conversations/"+one.ConversationID+"/messages", map[string]any{"content": "Waiting"}, f.human.ParticipantID)
		}()
		for f.count(t, `SELECT COUNT(*) FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME='conversations'`) == 0 {
			if ctx.Err() != nil {
				t.Fatal(ctx.Err())
			}
			time.Sleep(10 * time.Millisecond)
		}
		page := apiJSON[handler.MessagePage](t, f, "/conversations/"+one.ConversationID+"/messages?after_seq=0")
		equalValue(t, len(page.Messages), 0)
		other := responseValue[handler.MessageResponse](t, f.request(ctx, "POST", "/conversations/"+two.ConversationID+"/messages", map[string]any{"content": "Independent"}, f.human.ParticipantID), 201).Message
		equalValue(t, other.MessageSeq, int64(1))
		select {
		case <-done:
			t.Fatal("same-chat send passed an uncommitted sequence")
		default:
		}
		close(release)
		if err := <-finished; !errors.Is(err, sentinel) {
			t.Fatal(err)
		}
		select {
		case response := <-done:
			equalValue(t, responseValue[handler.MessageResponse](t, response, 201).Message.MessageSeq, int64(1))
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	})
}
