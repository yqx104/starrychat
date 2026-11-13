package tests

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"starrychat/backend/im/model"
	"starrychat/backend/im/repository"
	"starrychat/backend/im/service"
)

func startFourTriggerWorkers(t *testing.T, s *service.Service) func() {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	var workers sync.WaitGroup
	for range 4 {
		workers.Add(1)
		go func() { defer workers.Done(); s.RunTriggerSync(ctx) }()
	}
	done := make(chan struct{})
	go func() { workers.Wait(); close(done) }()
	stop := func() {
		t.Helper()
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("Trigger workers did not stop after cancellation")
		}
	}
	t.Cleanup(stop)
	return stop
}

func waitForTrigger(t *testing.T, description string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out: " + description)
}

func expectFourTriggerHeads(t *testing.T, started <-chan triggerCall) {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	seen := make(map[string]bool)
	for range 4 {
		select {
		case call := <-started:
			if seen[call.source.ConversationID] {
				t.Fatal("multiple workers entered the same conversation concurrently")
			}
			seen[call.source.ConversationID] = true
		case <-timer.C:
			t.Fatal("four conversation heads did not run concurrently")
		}
	}
}

func triggerConversationCalls(client *recordingTrigger, conversationID string) []string {
	var calls []string
	for _, call := range client.snapshot() {
		if call.source.ConversationID == conversationID {
			name := call.operation
			if name == "message" {
				name += ":" + call.message.MessageID
			}
			calls = append(calls, name)
		}
	}
	return calls
}

func TestTriggerOutboxWorkers(t *testing.T) {
	instance := startMySQL(t)
	t.Run("four_conversations_progress_without_overtaking_or_duplicate_claims", func(t *testing.T) {
		f := newIMFixture(t, instance)
		caller := model.RequestContext{ParticipantID: f.human.ParticipantID}
		started := make(chan triggerCall, 4)
		releases := make(map[string]chan struct{})
		want := make(map[string][]string)
		var blocked string
		client := &recordingTrigger{hook: func(ctx context.Context, call triggerCall) error {
			if call.operation == "subscribe" {
				select {
				case started <- call:
				case <-ctx.Done():
					return ctx.Err()
				}
				select {
				case <-releases[call.source.ConversationID]:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			return nil
		}}
		s := service.New(f.store, client)
		for range 4 {
			group := f.group(t, f.alpha)
			if blocked == "" {
				blocked = group.ConversationID
			}
			releases[group.ConversationID] = make(chan struct{})
			first := f.send(t, group.ConversationID, "first", f.human)
			second := f.send(t, group.ConversationID, "second", f.human)
			if err := s.RemoveMember(t.Context(), caller, model.RemoveMemberInput{ConversationID: group.ConversationID, ParticipantID: f.alpha.ParticipantID}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.DissolveGroup(t.Context(), caller, group.ConversationID); err != nil {
				t.Fatal(err)
			}
			want[group.ConversationID] = []string{"subscribe", "message:" + first.MessageID, "message:" + second.MessageID, "unsubscribe", "clear"}
		}
		stop := startFourTriggerWorkers(t, s)
		expectFourTriggerHeads(t, started)
		for id := range want {
			equalValue(t, triggerConversationCalls(client, id), []string{"subscribe"})
		}
		for id, release := range releases {
			if id != blocked {
				close(release)
			}
		}
		waitForTrigger(t, "other conversations drain while one is blocked", func() bool {
			return f.count(t, "SELECT COUNT(*) FROM trigger_outbox WHERE conversation_id<>?", blocked) == 0
		})
		equalValue(t, triggerConversationCalls(client, blocked), []string{"subscribe"})
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox WHERE conversation_id=?", blocked), int64(5))
		close(releases[blocked])
		waitForTrigger(t, "all conversations drain", func() bool {
			return f.count(t, "SELECT COUNT(*) FROM trigger_outbox") == 0
		})
		stop()
		for id, calls := range want {
			equalValue(t, triggerConversationCalls(client, id), calls)
		}
	})
	t.Run("retrying_head_blocks_its_followers_only", func(t *testing.T) {
		f := newIMFixture(t, instance)
		a, b := f.group(t), f.group(t)
		first := f.send(t, a.ConversationID, "retry", f.human)
		second := f.send(t, a.ConversationID, "wait", f.human)
		other := f.send(t, b.ConversationID, "other", f.human)
		// A persisted retry count gives the failed head a 16-second backoff,
		// leaving time to observe other workers without racing a one-second retry.
		f.exec(t, "UPDATE trigger_outbox SET attempts=4 WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.message_id'))=?", first.MessageID)
		var failed atomic.Bool
		client := &recordingTrigger{hook: func(_ context.Context, call triggerCall) error {
			if call.message.MessageID == first.MessageID && !failed.Swap(true) {
				return errors.New("Trigger unavailable")
			}
			return nil
		}}
		stop := startFourTriggerWorkers(t, service.New(f.store, client))
		waitForTrigger(t, "failure is deferred and another conversation completes", func() bool {
			return f.count(t, "SELECT COUNT(*) FROM trigger_outbox WHERE attempts=5 AND next_attempt_at>?", time.Now().UnixMilli()) == 1 &&
				f.count(t, "SELECT COUNT(*) FROM trigger_outbox WHERE conversation_id=?", b.ConversationID) == 0
		})
		later := f.send(t, b.ConversationID, "still progressing", f.human)
		waitForTrigger(t, "new events progress during another conversation's backoff", func() bool {
			return f.count(t, "SELECT COUNT(*) FROM trigger_outbox WHERE conversation_id=?", b.ConversationID) == 0
		})
		equalValue(t, triggerConversationCalls(client, a.ConversationID), []string{"message:" + first.MessageID})
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox WHERE conversation_id=?", a.ConversationID), int64(2))
		f.exec(t, "UPDATE trigger_outbox SET next_attempt_at=0 WHERE attempts=5")
		waitForTrigger(t, "retry succeeds before its follower", func() bool {
			return f.count(t, "SELECT COUNT(*) FROM trigger_outbox") == 0
		})
		stop()
		equalValue(t, triggerConversationCalls(client, a.ConversationID), []string{"message:" + first.MessageID, "message:" + first.MessageID, "message:" + second.MessageID})
		equalValue(t, triggerConversationCalls(client, b.ConversationID), []string{"message:" + other.MessageID, "message:" + later.MessageID})
	})
	t.Run("cancellation_releases_all_workers_and_preserves_events_for_restart", func(t *testing.T) {
		f := newIMFixture(t, instance)
		want := make(map[string][]string)
		for range 4 {
			group := f.group(t)
			first := f.send(t, group.ConversationID, "first", f.human)
			second := f.send(t, group.ConversationID, "second", f.human)
			want[group.ConversationID] = []string{"message:" + first.MessageID, "message:" + second.MessageID}
		}
		started := make(chan triggerCall, 4)
		client := &recordingTrigger{hook: func(ctx context.Context, call triggerCall) error {
			select {
			case started <- call:
			case <-ctx.Done():
				return ctx.Err()
			}
			<-ctx.Done()
			return ctx.Err()
		}}
		stop := startFourTriggerWorkers(t, service.New(f.store, client))
		expectFourTriggerHeads(t, started)
		stop()
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox"), int64(8))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox WHERE attempts<>0"), int64(0))
		for id, calls := range want {
			equalValue(t, triggerConversationCalls(client, id), calls[:1])
		}
		if err := f.store.Close(); err != nil {
			t.Fatal(err)
		}
		reopened, err := repository.Open(t.Context(), f.dsn)
		if err != nil {
			t.Fatal(err)
		}
		defer reopened.Close()
		recovered := &recordingTrigger{}
		stop = startFourTriggerWorkers(t, service.New(reopened, recovered))
		waitForTrigger(t, "new workers drain the persisted events", func() bool {
			return f.count(t, "SELECT COUNT(*) FROM trigger_outbox") == 0
		})
		stop()
		for id, calls := range want {
			equalValue(t, triggerConversationCalls(recovered, id), calls)
		}
	})
}
