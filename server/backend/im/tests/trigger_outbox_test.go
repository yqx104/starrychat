package tests

import (
	"context"
	"errors"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"starrychat/backend/im/handler"
	"starrychat/backend/im/model"
	"starrychat/backend/im/repository"
	"starrychat/backend/im/service"
)

type triggerCall struct {
	operation    string
	source       model.TriggerSource
	agentID      string
	subscription model.TriggerSubscription
	message      model.TriggerMessage
}

type recordingTrigger struct {
	mu    sync.Mutex
	calls []triggerCall
	hook  func(triggerCall) error
}

func (r *recordingTrigger) record(call triggerCall) error {
	r.mu.Lock()
	r.calls = append(r.calls, call)
	r.mu.Unlock()
	if r.hook != nil {
		return r.hook(call)
	}
	return nil
}

func (r *recordingTrigger) snapshot() []triggerCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.calls)
}

func (r *recordingTrigger) RegisterAgent(_ context.Context, id string) error {
	return r.record(triggerCall{operation: "register", agentID: id})
}

func (r *recordingTrigger) Subscribe(_ context.Context, input model.TriggerSubscription) error {
	return r.record(triggerCall{operation: "subscribe", source: input.TriggerSource, subscription: input})
}

func (r *recordingTrigger) Unsubscribe(_ context.Context, source model.TriggerSource, id string) error {
	return r.record(triggerCall{operation: "unsubscribe", source: source, agentID: id})
}

func (r *recordingTrigger) ClearChannel(_ context.Context, source model.TriggerSource) error {
	return r.record(triggerCall{operation: "clear", source: source})
}

func (r *recordingTrigger) SendMessage(_ context.Context, message model.TriggerMessage) error {
	return r.record(triggerCall{operation: "message", source: model.TriggerSource{ChannelType: message.ChannelType, ConversationID: message.ConversationID}, message: message})
}

func drainTrigger(t *testing.T, s *service.Service) {
	t.Helper()
	for range 1000 {
		processed, err := s.ProcessTriggerEvent(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if !processed {
			return
		}
	}
	t.Fatal("Trigger outbox did not drain")
}

func TestTriggerOutbox(t *testing.T) {
	instance := startMySQL(t)
	for _, route := range []struct{ path, field string }{{"/agents", "agent"}, {"/auth/register", "participant"}} {
		t.Run("agent_registration"+route.path, func(t *testing.T) {
			f := newAuthFixture(t, instance)
			owner := f.humanLogin(t)
			equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox"), int64(0))
			client := &recordingTrigger{}
			s := service.New(f.store, client)
			f.api = handler.NewAPI(s, s, f.tokens, handler.APIOptions{InsecureLocalHTTP: true})
			input := map[string]any{"username": "queued-agent", "password": testPassword, "name": "Queued Agent"}
			if route.path == "/auth/register" {
				input["kind"] = "agent"
			}
			created := responseValue[map[string]any](t, f.call("POST", route.path, input, authRequest{bearer: owner.Token}), 201)
			id := created[route.field].(map[string]any)["participant_id"].(string)
			equalValue(t, len(client.snapshot()), 0)
			loggedIn := responseValue[loginResult](t, f.call("POST", "/auth/login", loginBody("queued-agent", "bearer")), 200)
			equalValue(t, loggedIn.Participant.ParticipantID, id)
			equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox WHERE operation='register_agent' AND conversation_id IS NULL AND JSON_LENGTH(payload)=1 AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.agent_id'))=?", id), int64(1))
			responseValue[handler.ErrorResponse](t, f.call("POST", route.path, input, authRequest{bearer: owner.Token}), 409)
			equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox"), int64(1))
			client.hook = func(call triggerCall) error {
				if call.agentID == id {
					return errors.New("Trigger unavailable")
				}
				return nil
			}
			if processed, err := s.ProcessTriggerEvent(t.Context()); !processed || err == nil {
				t.Fatalf("registration failure was not retained: %v %v", processed, err)
			}
			equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox WHERE attempts=1 AND next_attempt_at>?", time.Now().UnixMilli()), int64(1))
			f.exec(t, "UPDATE trigger_outbox SET next_attempt_at=?", time.Now().Add(time.Hour).UnixMilli())
			other, err := s.Register(t.Context(), model.RequestContext{ParticipantID: owner.Participant.ParticipantID}, model.RegisterInput{Kind: model.Agent, Name: "Other", Username: "other-agent", Password: testPassword})
			if err != nil {
				t.Fatal(err)
			}
			drainTrigger(t, s)
			equalValue(t, len(client.snapshot()), 2)
			equalValue(t, client.snapshot()[1].agentID, other.ParticipantID)
			equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox"), int64(1))
			if err := f.store.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := repository.Open(t.Context(), f.dsn)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			client.hook = nil
			f.exec(t, "UPDATE trigger_outbox SET next_attempt_at=0")
			drainTrigger(t, service.New(reopened, client))
			equalValue(t, len(client.snapshot()), 3)
			equalValue(t, client.snapshot()[2].agentID, id)
			equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox"), int64(0))
			equalValue(t, f.count(t, "SELECT COUNT(*) FROM participant_accounts WHERE participant_id=?", id), int64(1))
		})
	}
	t.Run("all_business_events_and_payloads", func(t *testing.T) {
		f := newIMFixture(t, instance)
		client := &recordingTrigger{}
		s := service.New(f.store, client)
		caller := model.RequestContext{ParticipantID: f.human.ParticipantID}
		group := f.group(t, f.alpha)
		direct := apiJSON[handler.ConversationResponse](t, f, "/conversations/direct", apiOptions{method: "POST", status: 200, body: map[string]any{"agent_id": f.beta.ParticipantID}}).Conversation
		reopened, err := s.OpenDirect(t.Context(), caller, model.OpenDirectInput{AgentID: f.beta.ParticipantID})
		if err != nil {
			t.Fatal(err)
		}
		equalValue(t, reopened.ConversationID, direct.ConversationID)
		for range 2 {
			if _, err := s.AddMember(t.Context(), caller, model.AddMemberInput{ConversationID: group.ConversationID, ParticipantID: f.beta.ParticipantID}); err != nil {
				t.Fatal(err)
			}
		}
		first, err := s.SendMessage(t.Context(), caller, model.SendMessageInput{ConversationID: group.ConversationID, Content: "hello", MentionedAgentIDs: []string{f.alpha.ParticipantID, f.beta.ParticipantID}})
		if err != nil {
			t.Fatal(err)
		}
		reply, err := s.SendMessage(t.Context(), model.RequestContext{ParticipantID: f.alpha.ParticipantID}, model.SendMessageInput{ConversationID: group.ConversationID, Content: "reply", MentionedAgentIDs: []string{f.beta.ParticipantID}, QuotedMessageID: &first.MessageID})
		if err != nil {
			t.Fatal(err)
		}
		if err := s.RemoveMember(t.Context(), caller, model.RemoveMemberInput{ConversationID: group.ConversationID, ParticipantID: f.alpha.ParticipantID}); err != nil {
			t.Fatal(err)
		}
		if _, err := s.DissolveGroup(t.Context(), caller, group.ConversationID); err != nil {
			t.Fatal(err)
		}
		empty := f.group(t)
		equalValue(t, len(client.snapshot()), 0)
		drainTrigger(t, s)
		var operations []string
		directSubscriptions := 0
		for _, call := range client.snapshot() {
			if call.source.ConversationID == group.ConversationID {
				operations = append(operations, call.operation)
			}
			if call.operation == "message" {
				want := model.TriggerMessage{Message: first, ChannelType: "im_group", SenderKind: model.Human}
				if call.message.MessageID == reply.MessageID {
					want.Message, want.SenderKind = reply, model.Agent
				}
				equalValue(t, call.message, want)
			}
			if call.source.ConversationID == direct.ConversationID {
				directSubscriptions++
				equalValue(t, call.subscription, model.TriggerSubscription{TriggerSource: model.TriggerSource{ChannelType: "im_direct", ConversationID: direct.ConversationID}, AgentIDs: []string{f.beta.ParticipantID}})
			}
			if call.source.ConversationID == empty.ConversationID {
				t.Fatal("empty group created a subscription")
			}
		}
		equalValue(t, operations, []string{"subscribe", "subscribe", "message", "message", "unsubscribe", "clear"})
		equalValue(t, directSubscriptions, 1)
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox"), int64(0))
	})
	t.Run("outbox_failure_rolls_back_business", func(t *testing.T) {
		f := newIMFixture(t, instance)
		s := service.New(f.store, nil)
		caller := model.RequestContext{ParticipantID: f.human.ParticipantID}
		group := f.group(t, f.alpha)
		before := f.count(t, "SELECT COUNT(*) FROM trigger_outbox")
		participants := f.count(t, "SELECT COUNT(*) FROM participants")
		accounts := f.count(t, "SELECT COUNT(*) FROM participant_accounts")
		f.exec(t, "RENAME TABLE trigger_outbox TO unavailable_outbox")
		for name, call := range map[string]func() error{
			"register": func() error {
				_, err := s.Register(t.Context(), caller, model.RegisterInput{Kind: model.Agent, Name: "Rollback", Username: "rollback-agent", Password: testPassword})
				return err
			},
			"group": func() error {
				_, err := s.CreateGroup(t.Context(), caller, model.CreateGroupInput{Title: "rollback", AgentIDs: []string{f.beta.ParticipantID}})
				return err
			},
			"direct": func() error {
				_, err := s.OpenDirect(t.Context(), caller, model.OpenDirectInput{AgentID: f.beta.ParticipantID})
				return err
			},
			"add": func() error {
				_, err := s.AddMember(t.Context(), caller, model.AddMemberInput{ConversationID: group.ConversationID, ParticipantID: f.beta.ParticipantID})
				return err
			},
			"remove": func() error {
				return s.RemoveMember(t.Context(), caller, model.RemoveMemberInput{ConversationID: group.ConversationID, ParticipantID: f.alpha.ParticipantID})
			},
			"message": func() error {
				_, err := s.SendMessage(t.Context(), caller, model.SendMessageInput{ConversationID: group.ConversationID, Content: "rollback"})
				return err
			},
			"dissolve": func() error { _, err := s.DissolveGroup(t.Context(), caller, group.ConversationID); return err },
		} {
			if err := call(); err == nil {
				t.Errorf("%s committed without its Trigger event", name)
			}
		}
		f.exec(t, "RENAME TABLE unavailable_outbox TO trigger_outbox")
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM participants"), participants)
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM participant_accounts"), accounts)
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversations"), int64(1))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversation_members WHERE conversation_id=?", group.ConversationID), int64(2))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversation_members WHERE conversation_id=? AND participant_id=?", group.ConversationID, f.alpha.ParticipantID), int64(1))
		equalValue(t, f.count(t, "SELECT last_message_seq FROM conversations WHERE conversation_id=?", group.ConversationID), int64(0))
		equalValue(t, f.count(t, "SELECT dissolved_at IS NULL FROM conversations WHERE conversation_id=?", group.ConversationID), int64(1))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM messages"), int64(0))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox"), before)
	})
	t.Run("retry_order_survives_restart_without_blocking_other_conversations", func(t *testing.T) {
		f := newIMFixture(t, instance)
		client := &recordingTrigger{}
		s := service.New(f.store, client)
		a, b := f.group(t, f.alpha), f.group(t, f.beta)
		drainTrigger(t, s)
		first := f.send(t, a.ConversationID, "one", f.human)
		second := f.send(t, a.ConversationID, "two", f.human)
		other := f.send(t, b.ConversationID, "other", f.human)
		var failed atomic.Bool
		client.hook = func(call triggerCall) error {
			if call.message.MessageID == first.MessageID && !failed.Swap(true) {
				return errors.New("response lost after Trigger accepted the message")
			}
			return nil
		}
		if processed, err := s.ProcessTriggerEvent(t.Context()); !processed || err == nil {
			t.Fatalf("failure was not retained for retry: %v %v", processed, err)
		}
		equalValue(t, f.count(t, "SELECT attempts FROM trigger_outbox WHERE operation='message' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.message_id'))=?", first.MessageID), int64(1))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox WHERE attempts=1 AND next_attempt_at>?", time.Now().UnixMilli()), int64(1))
		drainTrigger(t, s)
		var sent []string
		for _, call := range client.snapshot() {
			if call.operation == "message" {
				sent = append(sent, call.message.MessageID)
			}
		}
		equalValue(t, sent, []string{first.MessageID, other.MessageID})
		if err := f.store.Close(); err != nil {
			t.Fatal(err)
		}
		reopened, err := repository.Open(t.Context(), f.dsn)
		if err != nil {
			t.Fatal(err)
		}
		defer reopened.Close()
		f.exec(t, "UPDATE trigger_outbox SET next_attempt_at=0 WHERE attempts>0")
		drainTrigger(t, service.New(reopened, client))
		sent = nil
		for _, call := range client.snapshot() {
			if call.operation == "message" {
				sent = append(sent, call.message.MessageID)
			}
		}
		equalValue(t, sent, []string{first.MessageID, other.MessageID, first.MessageID, second.MessageID})
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox"), int64(0))
	})
	t.Run("uncommitted_events_are_not_dispatched", func(t *testing.T) {
		f := newIMFixture(t, instance)
		group := f.group(t)
		client := &recordingTrigger{}
		s := service.New(f.store, client)
		ready, release := make(chan struct{}), make(chan struct{})
		var once sync.Once
		defer once.Do(func() { close(release) })
		done := make(chan error, 1)
		go func() {
			done <- f.store.WithinTx(t.Context(), nil, func(q *repository.Queries) error {
				if err := q.EnqueueTrigger(t.Context(), &group.ConversationID, model.TriggerClear, model.TriggerSource{ChannelType: "im_group", ConversationID: group.ConversationID}); err != nil {
					return err
				}
				close(ready)
				<-release
				return nil
			})
		}()
		select {
		case <-ready:
		case err := <-done:
			t.Fatal(err)
		case <-time.After(5 * time.Second):
			t.Fatal("transaction did not start")
		}
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		if processed, err := s.ProcessTriggerEvent(ctx); processed || err != nil {
			t.Fatalf("uncommitted event dispatched: %v %v", processed, err)
		}
		equalValue(t, len(client.snapshot()), 0)
		once.Do(func() { close(release) })
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		drainTrigger(t, s)
		equalValue(t, len(client.snapshot()), 1)
	})
	t.Run("concurrent_workers_do_not_overtake_a_conversation", func(t *testing.T) {
		f := newIMFixture(t, instance)
		a := f.group(t, f.alpha)
		f.send(t, a.ConversationID, "wait", f.human)
		b := f.group(t, f.beta)
		started, release := make(chan struct{}), make(chan struct{})
		var once sync.Once
		defer once.Do(func() { close(release) })
		client := &recordingTrigger{hook: func(call triggerCall) error {
			if call.operation == "register" && call.agentID == f.alpha.ParticipantID {
				close(started)
				<-release
			}
			return nil
		}}
		s := service.New(f.store, client)
		done := make(chan error, 1)
		go func() { _, err := s.ProcessTriggerEvent(t.Context()); done <- err }()
		select {
		case <-started:
		case err := <-done:
			t.Fatal(err)
		case <-time.After(5 * time.Second):
			t.Fatal("first worker did not start")
		}
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		if processed, err := s.ProcessTriggerEvent(ctx); !processed || err != nil {
			t.Fatalf("other conversation was blocked: %v %v", processed, err)
		}
		for _, call := range client.snapshot() {
			if call.operation == "message" {
				t.Fatal("later message overtook an in-flight subscription")
			}
		}
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox WHERE conversation_id=?", b.ConversationID), int64(0))
		once.Do(func() { close(release) })
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		drainTrigger(t, s)
	})
}
