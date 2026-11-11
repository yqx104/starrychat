package tests

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"starrychat/backend/trigger/common"
	"starrychat/backend/trigger/handler"
	"starrychat/backend/trigger/model"
	"starrychat/backend/trigger/repository"
	"starrychat/backend/trigger/service"
)

func newID(t *testing.T) string {
	t.Helper()
	id, err := common.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func requestJSON[T any](t *testing.T, base, method, path string, body any, want int) T {
	t.Helper()
	var input []byte
	if body != nil {
		var err error
		input, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	request, err := http.NewRequestWithContext(t.Context(), method, base+path, bytes.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != want {
		t.Fatalf("%s %s: HTTP %d, want %d: %s", method, path, response.StatusCode, want, data)
	}
	var result T
	if want == http.StatusNoContent {
		if len(data) != 0 {
			t.Fatalf("204 included a response body: %s", data)
		}
		return result
	}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("decode response: %v: %s", err, data)
	}
	return result
}

func TestTriggerAPI(t *testing.T) {
	instance := startMySQL(t)
	if output, err := instance.query("CREATE DATABASE trigger_api_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin", ""); err != nil {
		t.Fatalf("create isolated database: %v %s", err, output)
	}
	schema, err := os.ReadFile(filepath.Join("..", "sql", "schema.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if output, err := instance.query(string(schema), "trigger_api_test"); err != nil {
		t.Fatalf("apply schema: %v %s", err, output)
	}
	dsn := fmt.Sprintf("root@unix(%s)/trigger_api_test?charset=utf8mb4", instance.socket)
	store, err := repository.Open(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	svc := service.New(store)
	api := httptest.NewServer(handler.New(svc))
	t.Cleanup(api.Close)
	agents := []string{newID(t), newID(t), newID(t)}
	for _, id := range agents {
		requestJSON[handler.AgentResponse](t, api.URL, "PUT", "/agents/"+id, nil, 200)
	}
	source := func(kind model.ChannelType) model.Source {
		return model.Source{ChannelType: kind, ConversationID: newID(t)}
	}
	subscribe := func(t *testing.T, src model.Source, ids ...string) model.SubscriptionResult {
		t.Helper()
		return requestJSON[model.SubscriptionResult](t, api.URL, "POST", "/channels/subscriptions", model.SubscribeInput{Source: src, AgentIDs: ids}, 200)
	}
	path := func(src model.Source) string {
		return "/channels/" + string(src.ChannelType) + "/" + src.ConversationID
	}
	message := func(src model.Source) model.Message {
		return model.Message{Source: src, MessageID: newID(t), MessageSeq: 7, SenderID: newID(t), SenderKind: "human",
			Content: "测试消息\n原样传递", MentionedAgentIDs: []string{}, CreatedAt: time.Now().UnixMilli()}
	}
	send := func(t *testing.T, msg model.Message, status int) handler.MessageResponse {
		t.Helper()
		return requestJSON[handler.MessageResponse](t, api.URL, "POST", "/messages", msg, status)
	}
	checkDeliveryCount := func(t *testing.T, channelID string, want int) {
		t.Helper()
		count, err := instance.query("SELECT COUNT(*) FROM deliveries WHERE channel_id='"+channelID+"'", "trigger_api_test")
		if err != nil || count != fmt.Sprint(want) {
			t.Fatalf("delivery count = %s, want %d: %v", count, want, err)
		}
	}

	t.Run("registration_preserves_original_timestamp", func(t *testing.T) {
		if output, err := instance.query("UPDATE agents SET created_at=1234 WHERE agent_id='"+agents[0]+"'", "trigger_api_test"); err != nil {
			t.Fatalf("set known registration time: %v %s", err, output)
		}
		got := requestJSON[handler.AgentResponse](t, api.URL, "PUT", "/agents/"+agents[0], nil, 200).Agent
		if got.AgentID != agents[0] || got.CreatedAt != 1234 {
			t.Fatalf("registration changed identity or time: %+v", got)
		}
		body := requestJSON[handler.ErrorResponse](t, api.URL, "PUT", "/agents/not-a-uuid", nil, 400)
		if body.Error.Code != "INVALID_REQUEST" {
			t.Fatalf("invalid ID: %+v", body)
		}
	})

	t.Run("batch_subscription_reuses_channel_and_is_atomic", func(t *testing.T) {
		src := source(model.IMGroup)
		failed := requestJSON[handler.ErrorResponse](t, api.URL, "POST", "/channels/subscriptions",
			model.SubscribeInput{Source: src, AgentIDs: []string{agents[0], newID(t)}}, 404)
		if failed.Error.Code != "NOT_FOUND" {
			t.Fatalf("missing registration error: %+v", failed)
		}
		rows, err := store.ListChannels(t.Context(), src)
		if err != nil || len(rows) != 0 {
			t.Fatalf("failed batch left subscriptions: %+v %v", rows, err)
		}
		first := subscribe(t, src, agents[0], agents[1], agents[0])
		if len(first.Channels) != 2 || !common.ValidID(first.ChannelID) {
			t.Fatalf("invalid batch result: %+v", first)
		}
		for _, channel := range first.Channels {
			if channel.ChannelID != first.ChannelID {
				t.Fatal("subscribers do not share channel ID")
			}
		}
		repeated := subscribe(t, src, agents[0], agents[1])
		if !reflect.DeepEqual(first, repeated) {
			t.Fatalf("repeat changed subscription: %+v / %+v", first, repeated)
		}
		added := subscribe(t, src, agents[2])
		if added.ChannelID != first.ChannelID || len(added.Channels) != 1 {
			t.Fatalf("new member did not reuse channel ID: %+v", added)
		}
		other := subscribe(t, source(model.IMDirect), agents[0])
		if other.ChannelID == first.ChannelID {
			t.Fatal("different conversations share channel ID")
		}
	})

	t.Run("concurrent_first_subscriptions_share_one_uuid", func(t *testing.T) {
		src := source(model.IMGroup)
		const count = 24
		results := make([]model.SubscriptionResult, count)
		errs := make([]error, count)
		var pending sync.WaitGroup
		for i := range count {
			pending.Go(func() {
				results[i], errs[i] = svc.Subscribe(t.Context(), model.SubscribeInput{Source: src, AgentIDs: []string{agents[i%len(agents)]}})
			})
		}
		pending.Wait()
		for i, err := range errs {
			if err != nil || results[i].ChannelID != results[0].ChannelID {
				t.Fatalf("concurrent subscribe %d: %+v %v", i, results[i], err)
			}
		}
		rows, err := store.ListChannels(t.Context(), src)
		if err != nil || len(rows) != len(agents) {
			t.Fatalf("duplicate or missing subscriptions: %+v %v", rows, err)
		}
	})

	t.Run("unsubscribe_and_clear_are_repeatable_and_scoped", func(t *testing.T) {
		src, otherSource := source(model.IMGroup), source(model.IMGroup)
		first := subscribe(t, src, agents...)
		other := subscribe(t, otherSource, agents[0])
		for range 2 {
			requestJSON[struct{}](t, api.URL, "DELETE", path(src)+"/agents/"+agents[0], nil, 204)
		}
		rows, err := store.ListChannels(t.Context(), src)
		if err != nil || len(rows) != 2 {
			t.Fatalf("single unsubscribe: %+v %v", rows, err)
		}
		for range 2 {
			requestJSON[struct{}](t, api.URL, "DELETE", path(src), nil, 204)
		}
		rows, err = store.ListChannels(t.Context(), src)
		if err != nil || len(rows) != 0 {
			t.Fatalf("clear did not delete subscriptions: %+v %v", rows, err)
		}
		if again := subscribe(t, otherSource, agents[0]); !reflect.DeepEqual(again, other) {
			t.Fatal("clear changed another conversation")
		}
		if again := subscribe(t, src, agents[0]); again.ChannelID == first.ChannelID {
			t.Fatal("empty channel mapping unexpectedly retained")
		}
	})

	t.Run("direct_queue_preserves_message_deduplicates_and_does_not_echo_sender", func(t *testing.T) {
		src := source(model.IMDirect)
		sub := subscribe(t, src, agents[0])
		msg := message(src)
		quote := newID(t)
		msg.QuotedMessageID = &quote
		result := send(t, msg, 202)
		if !reflect.DeepEqual(result.QueuedAgentIDs, agents[:1]) || result.ChannelID != sub.ChannelID {
			t.Fatalf("direct targets: %+v", result)
		}
		item, err := store.NextDelivery(t.Context(), agents[0], sub.ChannelID)
		if err != nil || item.AgentID != agents[0] || item.ChannelID != sub.ChannelID || !reflect.DeepEqual(item.Message, msg) {
			t.Fatalf("wrong queued envelope: %+v %v", item, err)
		}
		send(t, msg, 202)
		checkDeliveryCount(t, sub.ChannelID, 1)
		msg.MessageID = newID(t)
		msg.SenderID, msg.SenderKind = agents[0], "agent"
		if result := send(t, msg, 200); result.QueuedAgentIDs == nil || len(result.QueuedAgentIDs) != 0 {
			t.Fatal("direct reply echoed back to its sender")
		}
		checkDeliveryCount(t, sub.ChannelID, 1)
	})

	t.Run("agent_mentions_trigger_subscribers_without_sender_restrictions", func(t *testing.T) {
		src := source(model.IMGroup)
		sub := subscribe(t, src, agents[0], agents[1])
		msg := message(src)
		msg.SenderID, msg.SenderKind = agents[0], "agent"
		msg.MentionedAgentIDs = []string{agents[1], agents[1], agents[2]}
		result := send(t, msg, 202)
		if !reflect.DeepEqual(result.QueuedAgentIDs, agents[1:2]) {
			t.Fatalf("Agent-to-Agent targets or duplicate mentions: %+v", result)
		}
		checkDeliveryCount(t, sub.ChannelID, 1)
		msg.MessageID = newID(t)
		msg.MentionedAgentIDs = []string{agents[0]}
		if result := send(t, msg, 202); !reflect.DeepEqual(result.QueuedAgentIDs, agents[:1]) {
			t.Fatalf("group sender was additionally restricted: %+v", result)
		}
		msg.MessageID = newID(t)
		msg.MentionedAgentIDs = nil
		if result := send(t, msg, 200); len(result.QueuedAgentIDs) != 0 {
			t.Fatal("group without mentions dispatched")
		}
		requestJSON[struct{}](t, api.URL, "DELETE", path(src)+"/agents/"+agents[1], nil, 204)
		msg.MentionedAgentIDs = []string{agents[1]}
		if result := send(t, msg, 200); len(result.QueuedAgentIDs) != 0 {
			t.Fatal("removed member still received a message")
		}
		if result := send(t, message(source(model.IMGroup)), 200); len(result.QueuedAgentIDs) != 0 {
			t.Fatal("unsubscribed conversation dispatched")
		}
		checkDeliveryCount(t, sub.ChannelID, 2)
	})

	t.Run("queues_all_recipients_while_offline", func(t *testing.T) {
		src := source(model.IMGroup)
		sub := subscribe(t, src, agents[0], agents[1])
		msg := message(src)
		msg.MentionedAgentIDs = agents[:2]
		result := send(t, msg, 202)
		if !reflect.DeepEqual(result.QueuedAgentIDs, agents[:2]) {
			t.Fatalf("offline recipients were not queued: %+v", result)
		}
		checkDeliveryCount(t, sub.ChannelID, 2)
		for _, agentID := range agents[:2] {
			item, err := store.NextDelivery(t.Context(), agentID, sub.ChannelID)
			if err != nil || !reflect.DeepEqual(item.Message, msg) {
				t.Fatalf("missing recipient message: %+v %v", item, err)
			}
		}
	})

	t.Run("enqueue_failure_rolls_back_all_recipients", func(t *testing.T) {
		src := source(model.IMGroup)
		sub := subscribe(t, src, agents[0], agents[1])
		// Fail the second recipient's insert in this isolated test database.
		statement := "CREATE TRIGGER fail_delivery BEFORE INSERT ON deliveries FOR EACH ROW SET NEW.message_id=IF(NEW.agent_id='" + agents[1] + "', NULL, NEW.message_id)"
		if output, err := instance.query(statement, "trigger_api_test"); err != nil {
			t.Fatalf("install insert failure: %v %s", err, output)
		}
		t.Cleanup(func() {
			if _, err := instance.query("DROP TRIGGER fail_delivery", "trigger_api_test"); err != nil {
				t.Error(err)
			}
		})
		msg := message(src)
		msg.MentionedAgentIDs = agents[:2]
		result := requestJSON[handler.ErrorResponse](t, api.URL, "POST", "/messages", msg, 500)
		if result.Error.Code != "INTERNAL_ERROR" {
			t.Fatalf("enqueue failure result: %+v", result)
		}
		checkDeliveryCount(t, sub.ChannelID, 0)
	})

	t.Run("subscriptions_survive_a_new_repository_and_service", func(t *testing.T) {
		src := source(model.IMGroup)
		before := subscribe(t, src, agents[0])
		reopened, err := repository.Open(t.Context(), dsn)
		if err != nil {
			t.Fatal(err)
		}
		defer reopened.Close()
		after, err := service.New(reopened).Subscribe(t.Context(), model.SubscribeInput{Source: src, AgentIDs: agents[:1]})
		if err != nil || !reflect.DeepEqual(before, after) {
			t.Fatalf("subscription changed after reopening: %+v %v", after, err)
		}
	})

	t.Run("basic_request_errors", func(t *testing.T) {
		for _, input := range []any{
			json.RawMessage(`null`),
			model.SubscribeInput{Source: source(model.IMGroup)},
			model.SubscribeInput{Source: model.Source{ChannelType: "unknown", ConversationID: newID(t)}, AgentIDs: agents},
			model.SubscribeInput{Source: source(model.IMGroup), AgentIDs: []string{"bad-id"}},
		} {
			requestJSON[handler.ErrorResponse](t, api.URL, "POST", "/channels/subscriptions", input, 400)
		}
		msg := message(source(model.IMDirect))
		msg.MessageID = "bad-id"
		requestJSON[handler.ErrorResponse](t, api.URL, "POST", "/messages", msg, 400)
		response, err := http.Post(api.URL+"/messages", "application/json", bytes.NewBufferString("{"))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != 400 {
			t.Fatalf("malformed JSON status %d", response.StatusCode)
		}
	})
}
