package tests

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"yqx-team/backend/im/handler"
	"yqx-team/backend/im/model"
	"yqx-team/backend/im/repository"
	"yqx-team/backend/im/service"
)

func parallelResponses(t *testing.T, count int, run func(context.Context, int) *httptest.ResponseRecorder) []*httptest.ResponseRecorder {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	responses := make([]*httptest.ResponseRecorder, count)
	start := make(chan struct{})
	var workers sync.WaitGroup
	for i := 0; i < count; i++ {
		workers.Add(1)
		go func(i int) { defer workers.Done(); <-start; responses[i] = run(ctx, i) }(i)
	}
	close(start)
	workers.Wait()
	if ctx.Err() != nil {
		t.Fatalf("parallel requests did not finish: %v", ctx.Err())
	}
	return responses
}

func responseValue[T any](t *testing.T, response *httptest.ResponseRecorder, status int) T {
	t.Helper()
	if response.Code != status {
		t.Fatalf("response status %d, want %d: %s", response.Code, status, response.Body)
	}
	var value T
	if status != 204 {
		if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
	}
	return value
}

func runMySQLConcurrencyTests(t *testing.T, instance *mysqlInstance) {
	runMessageSequenceTests(t, instance)
	t.Run("parallel_direct_open_across_independent_pools_reuses_one_chat", func(t *testing.T) {
		f := newIMFixture(t, instance)
		otherStore, err := repository.Open(t.Context(), f.dsn)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = otherStore.Close() })
		other := *f
		other.handle = handler.New(service.New(otherStore))
		responses := parallelResponses(t, 32, func(ctx context.Context, i int) *httptest.ResponseRecorder {
			target := f
			if i%2 == 1 {
				target = &other
			}
			return target.request(ctx, "POST", "/conversations/direct", map[string]any{"agent_id": f.alpha.ParticipantID}, f.human.ParticipantID)
		})
		first := responseValue[handler.ConversationResponse](t, responses[0], 200).Conversation
		for _, response := range responses {
			equalValue(t, responseValue[handler.ConversationResponse](t, response, 200).Conversation, first)
		}
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversations WHERE kind='direct'"), int64(1))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversation_members"), int64(2))
	})
	t.Run("parallel_add_is_idempotent_and_sends_commit_in_sequence_order", func(t *testing.T) {
		f := newIMFixture(t, instance)
		f.group(t, f.alpha)
		responses := parallelResponses(t, 16, func(ctx context.Context, _ int) *httptest.ResponseRecorder {
			return f.request(ctx, "POST", ("/conversations/" + f.conversationID(1) + "/members"), map[string]any{"participant_id": f.beta.ParticipantID}, f.human.ParticipantID)
		})
		for _, response := range responses {
			equalValue(t, responseValue[handler.MemberResponse](t, response, 200).Member, f.beta)
		}
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversation_members"), int64(3))
		seed := f.send(t, f.conversationID(1), "Quote target", f.human)
		responses = parallelResponses(t, 32, func(ctx context.Context, i int) *httptest.ResponseRecorder {
			caller := f.human.ParticipantID
			if i%2 == 1 {
				caller = f.alpha.ParticipantID
			}
			return f.request(ctx, "POST", ("/conversations/" + f.conversationID(1) + "/messages"), map[string]any{"content": fmt.Sprintf("Parallel %d", i), "mentioned_agent_ids": []string{f.beta.ParticipantID, f.alpha.ParticipantID, f.beta.ParticipantID}, "quoted_message_id": seed.MessageID}, caller)
		})
		byID := map[string]model.Message{seed.MessageID: seed}
		for _, response := range responses {
			message := responseValue[handler.MessageResponse](t, response, 201).Message
			if _, exists := byID[message.MessageID]; exists {
				t.Fatal("duplicate generated message ID")
			}
			equalValue(t, message.MentionedAgentIDs, []string{f.beta.ParticipantID, f.alpha.ParticipantID})
			equalValue(t, message.QuotedMessageID, &seed.MessageID)
			byID[message.MessageID] = message
		}
		page := apiJSON[handler.MessagePage](t, f, ("/conversations/" + f.conversationID(1) + "/messages"))
		equalValue(t, len(page.Messages), 33)
		if page.HasMore {
			t.Fatal("unexpected extra message page")
		}
		var previous int64
		for _, message := range page.Messages {
			if message.MessageSeq <= previous {
				t.Fatal("messages not strictly ascending")
			}
			equalValue(t, message, byID[message.MessageID])
			previous = message.MessageSeq
		}
	})
	t.Run("concurrent_removal_and_sends_keep_membership_consistent", func(t *testing.T) {
		f := newIMFixture(t, instance)
		f.group(t, f.alpha)
		responses := parallelResponses(t, 33, func(ctx context.Context, i int) *httptest.ResponseRecorder {
			if i == 0 {
				return f.request(ctx, "DELETE", fmt.Sprintf(("/conversations/"+f.conversationID(1)+"/members/%s"), f.alpha.ParticipantID), nil, f.human.ParticipantID)
			}
			return f.request(ctx, "POST", ("/conversations/" + f.conversationID(1) + "/messages"), map[string]any{"content": fmt.Sprintf("Before removal %d", i)}, f.alpha.ParticipantID)
		})
		responseValue[any](t, responses[0], 204)
		var saved int64
		for _, response := range responses[1:] {
			if response.Code == 201 {
				saved++
				continue
			}
			equalValue(t, responseValue[handler.ErrorResponse](t, response, 403).Error.Code, "FORBIDDEN")
		}
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM messages"), saved)
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversation_members WHERE participant_id=?", f.alpha.ParticipantID), int64(0))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM participants WHERE participant_id=?", f.alpha.ParticipantID), int64(1))
		apiJSON[handler.ErrorResponse](t, f, ("/conversations/" + f.conversationID(1) + "/messages"), apiOptions{method: "POST", caller: f.alpha.ParticipantID, body: map[string]any{"content": "After removal"}, status: 403})
	})
	t.Run("concurrent_dissolution_and_sends_keep_closed_state_consistent", func(t *testing.T) {
		f := newIMFixture(t, instance)
		f.group(t, f.alpha)
		responses := parallelResponses(t, 33, func(ctx context.Context, i int) *httptest.ResponseRecorder {
			if i == 0 {
				return f.request(ctx, "POST", ("/conversations/" + f.conversationID(1) + "/dissolve"), nil, f.human.ParticipantID)
			}
			return f.request(ctx, "POST", ("/conversations/" + f.conversationID(1) + "/messages"), map[string]any{"content": fmt.Sprintf("Before close %d", i)}, f.alpha.ParticipantID)
		})
		closed := responseValue[handler.ConversationResponse](t, responses[0], 200).Conversation
		if closed.DissolvedAt == nil {
			t.Fatal("group remained open")
		}
		var saved int64
		for _, response := range responses[1:] {
			if response.Code == 201 {
				saved++
				continue
			}
			equalValue(t, responseValue[handler.ErrorResponse](t, response, 409).Error.Code, "CONFLICT")
		}
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM messages"), saved)
		equalValue(t, apiJSON[handler.ConversationResponse](t, f, ("/conversations/"+f.conversationID(1)+"/dissolve"), apiOptions{method: "POST"}).Conversation, closed)
		apiJSON[handler.ErrorResponse](t, f, ("/conversations/" + f.conversationID(1) + "/messages"), apiOptions{method: "POST", body: map[string]any{"content": "After close"}, status: 409})
		equalValue(t, int64(len(apiJSON[handler.MessagePage](t, f, ("/conversations/"+f.conversationID(1)+"/messages")).Messages)), saved)
	})
	t.Run("cancellation_interrupts_a_real_row_lock_wait_and_pool_recovers", func(t *testing.T) {
		f := newIMFixture(t, instance)
		f.group(t, f.alpha)
		lock, err := f.db.BeginTx(t.Context(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer lock.Rollback()
		var id string
		if err := lock.QueryRowContext(t.Context(), ("SELECT conversation_id FROM conversations WHERE conversation_id='" + f.conversationID(1) + "' FOR UPDATE")).Scan(&id); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			done <- f.request(ctx, "POST", ("/conversations/" + f.conversationID(1) + "/messages"), map[string]any{"content": "Cancelled while locked"}, f.human.ParticipantID)
		}()
		deadline := time.Now().Add(5 * time.Second)
		for f.count(t, `SELECT COUNT(*) FROM performance_schema.data_lock_waits w
			JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
			WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME='conversations'`) == 0 {
			if time.Now().After(deadline) {
				t.Fatal("request never reached the database row lock")
			}
			time.Sleep(10 * time.Millisecond)
		}
		cancel()
		select {
		case response := <-done:
			assertError(t, response, 500, "INTERNAL_ERROR")
		case <-time.After(2 * time.Second):
			t.Fatal("cancellation did not release the SQL request")
		}
		if err := lock.Rollback(); err != nil {
			t.Fatal(err)
		}
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM messages"), int64(0))
		if store, err := repository.Open(ctx, f.dsn); !errors.Is(err, context.Canceled) {
			if store != nil {
				_ = store.Close()
			}
			t.Fatalf("cancelled Open = %v", err)
		}
		f.send(t, f.conversationID(1), "After cancellation", f.human)
	})
	t.Run("configured_entrypoint_starts_real_authenticated_listener", func(t *testing.T) {
		f := newIMFixture(t, instance)
		testRealEntrypoint(t, f)
	})
	t.Run("concurrent_close_is_idempotent_and_reopen_preserves_data", func(t *testing.T) {
		f := newIMFixture(t, instance)
		group := f.group(t, f.alpha)
		f.send(t, group.ConversationID, "Before concurrent shutdown", f.human)
		var workers sync.WaitGroup
		errors := make(chan error, 64)
		for i := 0; i < 64; i++ {
			workers.Go(func() { errors <- f.store.Close() })
		}
		workers.Wait()
		close(errors)
		for err := range errors {
			if err != nil {
				t.Fatal(err)
			}
		}
		if _, err := f.store.GetParticipant(t.Context(), f.human.ParticipantID); err == nil {
			t.Fatal("closed pool accepted query")
		}
		store, err := repository.Open(t.Context(), f.dsn)
		if err != nil {
			t.Fatal(err)
		}
		defer store.Close()
		messages, err := store.ListMessages(t.Context(), model.MessagePageQuery{ConversationID: group.ConversationID, Limit: 50})
		if err != nil || len(messages) != 1 {
			t.Fatalf("data lost after reopening: %v", err)
		}
	})
}
