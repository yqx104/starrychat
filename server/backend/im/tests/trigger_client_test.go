package tests

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"starrychat/backend/im/model"
	"starrychat/backend/im/triggerclient"
)

func TestTriggerClientRegistersOnlyAgentID(t *testing.T) {
	id := testID(1)
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		body, err := io.ReadAll(r.Body)
		if err != nil || len(body) != 0 || r.Header.Get("Authorization") != "" ||
			r.Method != http.MethodPut || r.URL.Path != "/internal/agents/"+id {
			t.Error("registration must send only a PUT with the Agent ID in its path")
		}
		fmt.Fprintf(w, `{"agent":{"agent_id":%q,"created_at":1}}`, id)
	}))
	defer server.Close()
	client := triggerclient.New(server.URL + "/internal/")
	for range 2 {
		if err := client.RegisterAgent(t.Context(), id); err != nil {
			t.Fatal(err)
		}
	}
	equalValue(t, calls.Load(), int64(2))
	if err := client.RegisterAgent(t.Context(), "../invalid"); err == nil {
		t.Fatal("invalid Agent ID accepted")
	}
	equalValue(t, calls.Load(), int64(2))
}

func TestTriggerClientRejectsFailedRegistration(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"unavailable", 503, `{"error":"unavailable"}`},
		{"redirect", 307, ""},
		{"missing_confirmation", 204, ""},
		{"invalid_json", 200, "not JSON"},
		{"different_agent", 200, fmt.Sprintf(`{"agent":{"agent_id":%q}}`, testID(2))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path == "/redirected" {
					fmt.Fprintf(w, `{"agent":{"agent_id":%q}}`, testID(1))
					return
				}
				w.Header().Set("Location", "/redirected")
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer server.Close()
			if err := triggerclient.New(server.URL).RegisterAgent(t.Context(), testID(1)); err == nil {
				t.Fatal("failed registration accepted")
			}
			equalValue(t, calls.Load(), int64(1))
		})
	}
}

func TestTriggerClientHonorsRequestDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	if err := triggerclient.New(server.URL).RegisterAgent(ctx, testID(1)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("registration did not respect request deadline: %v", err)
	}
}

func TestTriggerClientSubscriptionsAndMessages(t *testing.T) {
	source := model.TriggerSource{ChannelType: "im_group", ConversationID: testID(10)}
	agentID, channelID := testID(1), testID(2)
	message := model.TriggerMessage{ChannelType: source.ChannelType, SenderKind: model.Agent,
		Message: model.Message{ConversationID: source.ConversationID, MessageID: testID(3), MessageSeq: 7,
			SenderID: testID(4), Content: "Hello", MentionedAgentIDs: []string{agentID}, QuotedMessageID: &channelID, CreatedAt: 123}}
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "" {
			t.Error("internal calls must not include Agent credentials")
		}
		switch r.Method + " " + r.URL.Path {
		case "POST /internal/channels/subscriptions":
			var input model.TriggerSubscription
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.TriggerSource != source || len(input.AgentIDs) != 1 || input.AgentIDs[0] != agentID {
				t.Errorf("incorrect subscription: %+v, %v", input, err)
			}
			fmt.Fprintf(w, `{"channel_id":%q,"channels":[{"channel_id":%q,"channel_type":%q,"conversation_id":%q,"agent_id":%q}]}`,
				channelID, channelID, source.ChannelType, source.ConversationID, agentID)
		case "DELETE /internal/channels/im_group/" + source.ConversationID,
			"DELETE /internal/channels/im_group/" + source.ConversationID + "/agents/" + agentID:
			body, _ := io.ReadAll(r.Body)
			if len(body) != 0 {
				t.Error("delete must not have a body")
			}
			w.WriteHeader(http.StatusNoContent)
		case "POST /internal/messages":
			var got model.TriggerMessage
			if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
				t.Error(err)
			}
			want := message
			if len(got.MentionedAgentIDs) == 0 {
				want.MentionedAgentIDs = []string{}
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("message payload = %+v, want %+v", got, want)
			}
			if len(got.MentionedAgentIDs) == 0 {
				fmt.Fprint(w, `{"queued_agent_ids":[]}`)
			} else {
				w.WriteHeader(http.StatusAccepted)
				fmt.Fprintf(w, `{"channel_id":%q,"queued_agent_ids":[%q]}`, channelID, agentID)
			}
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	client := triggerclient.New(server.URL + "/internal/")
	for _, call := range []func() error{
		func() error {
			return client.Subscribe(t.Context(), model.TriggerSubscription{TriggerSource: source, AgentIDs: []string{agentID}})
		},
		func() error { return client.SendMessage(t.Context(), message) },
		func() error { return client.Unsubscribe(t.Context(), source, agentID) },
		func() error { return client.ClearChannel(t.Context(), source) },
	} {
		if err := call(); err != nil {
			t.Fatal(err)
		}
	}
	withoutMentions := message
	withoutMentions.MentionedAgentIDs = []string{}
	if err := client.SendMessage(t.Context(), withoutMentions); err != nil {
		t.Fatal(err)
	}
	equalValue(t, calls.Load(), int64(5))
}

func TestTriggerClientRejectsFailedSync(t *testing.T) {
	source := model.TriggerSource{ChannelType: "im_direct", ConversationID: testID(10)}
	for _, status := range []int{307, 500, 200} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var calls atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Location", "/redirected")
				w.WriteHeader(status)
				fmt.Fprint(w, `{}`)
			}))
			defer server.Close()
			client := triggerclient.New(server.URL)
			for name, call := range map[string]func() error{
				"subscribe": func() error {
					return client.Subscribe(t.Context(), model.TriggerSubscription{TriggerSource: source, AgentIDs: []string{testID(1)}})
				},
				"unsubscribe": func() error { return client.Unsubscribe(t.Context(), source, testID(1)) },
				"clear":       func() error { return client.ClearChannel(t.Context(), source) },
				"message": func() error {
					return client.SendMessage(t.Context(), model.TriggerMessage{ChannelType: source.ChannelType, Message: model.Message{ConversationID: source.ConversationID}})
				},
			} {
				if err := call(); err == nil {
					t.Errorf("%s accepted an unconfirmed operation", name)
				}
			}
			equalValue(t, calls.Load(), int64(4))
		})
	}
}
