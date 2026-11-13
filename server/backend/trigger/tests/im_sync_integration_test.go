package tests

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	imAuth "starrychat/backend/im/common/auth"
	imHandler "starrychat/backend/im/handler"
	imRepository "starrychat/backend/im/repository"
	imService "starrychat/backend/im/service"
	"starrychat/backend/im/triggerclient"
	"starrychat/backend/trigger/connections"
	"starrychat/backend/trigger/handler"
	"starrychat/backend/trigger/imclient"
	"starrychat/backend/trigger/model"
	"starrychat/backend/trigger/repository"
	"starrychat/backend/trigger/service"
)

// Runs the real services in the test process, without depending on OS execution
// policy for newly built server binaries. HTTP, MySQL and WS are still real.
func TestIMTriggerSyncEndToEnd(t *testing.T) {
	instance := startMySQL(t)
	for name, path := range map[string]string{"sync_im": "../../im/sql/schema.sql", "sync_trigger": "../sql/schema.sql"} {
		schema, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if output, err := instance.query("CREATE DATABASE "+name+"; USE "+name+"; "+string(schema), ""); err != nil {
			t.Fatalf("schema: %v %s", err, output)
		}
	}
	imDSN := fmt.Sprintf("root@unix(%s)/sync_im?charset=utf8mb4", instance.socket)
	imStore, err := imRepository.Open(t.Context(), imDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer imStore.Close()
	store, err := repository.Open(t.Context(), fmt.Sprintf("root@unix(%s)/sync_trigger?charset=utf8mb4", instance.socket))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	im := httptest.NewUnstartedServer(nil)
	sockets := connections.New(store, imclient.New("http://"+im.Listener.Addr().String()))
	defer sockets.Close()
	api := handler.New(service.New(store))
	var unavailable, loseRegistrationResponse, loseMessageResponse atomic.Bool
	mux := http.NewServeMux()
	mux.Handle("GET /agent-connections", sockets)
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if unavailable.Load() {
			http.Error(w, "offline", 503)
			return
		}
		if r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/agents/") && loseRegistrationResponse.CompareAndSwap(true, false) {
			received := httptest.NewRecorder()
			api.ServeHTTP(received, r)
			if received.Code != 200 {
				t.Errorf("Agent was not registered before simulated response loss: %d", received.Code)
			}
			http.Error(w, "response lost after commit", 503)
			return
		}
		if r.URL.Path == "/messages" && loseMessageResponse.CompareAndSwap(true, false) {
			received := httptest.NewRecorder()
			api.ServeHTTP(received, r)
			if received.Code != 202 {
				t.Errorf("message was not accepted before simulated response loss: %d", received.Code)
			}
			http.Error(w, "response lost after commit", 503)
			return
		}
		api.ServeHTTP(w, r)
	}))
	trigger := httptest.NewServer(mux)
	defer trigger.Close()
	client := triggerclient.New(trigger.URL)
	svc := imService.New(imStore, client)
	tokens, err := imAuth.NewTokens(make([]byte, 32), "sync-test", "sync-test", nil)
	if err != nil {
		t.Fatal(err)
	}
	im.Config.Handler = imHandler.NewAPI(svc, svc, tokens, imHandler.APIOptions{})
	im.Start()
	defer im.Close()
	startSync := func(s *imService.Service) func() {
		ctx, cancel := context.WithCancel(t.Context())
		var workers sync.WaitGroup
		for range 4 {
			workers.Add(1)
			go func() { defer workers.Done(); s.RunTriggerSync(ctx) }()
		}
		stop := func() { cancel(); workers.Wait() }
		t.Cleanup(stop)
		return stop
	}
	password := newID(t)
	authJSON(t, im.URL, "POST", "/auth/register", "", map[string]any{"username": "owner", "password": password, "name": "Owner", "kind": "human"}, 201)
	humanToken := authJSON(t, im.URL, "POST", "/auth/login", "", map[string]any{"username": "owner", "password": password, "transport": "bearer"}, 200)["token"].(string)
	createAgent := func(username string) string {
		t.Helper()
		return authJSON(t, im.URL, "POST", "/agents", humanToken, map[string]any{"username": username, "password": password, "name": username}, 201)["agent"].(map[string]any)["participant_id"].(string)
	}
	unavailable.Store(true)
	agentID, otherID := createAgent("alpha"), createAgent("beta")
	if count, err := instance.query("SELECT COUNT(*) FROM agents", "sync_trigger"); err != nil || count != "0" {
		t.Fatalf("Agents registered during Trigger outage: %s %v", count, err)
	}
	stop := startSync(svc)
	eventually(t, "registrations retained during outage", func() bool {
		count, err := instance.query("SELECT COUNT(*) FROM trigger_outbox WHERE operation='register_agent' AND attempts>0", "sync_im")
		return err == nil && count == "2"
	})
	stop()
	unavailable.Store(false)
	loseRegistrationResponse.Store(true)
	stop = startSync(svc)
	eventually(t, "registrations recovered before any WS connection", func() bool {
		count, err := instance.query("SELECT COUNT(*) FROM agents", "sync_trigger")
		pending, queryErr := instance.query("SELECT COUNT(*) FROM trigger_outbox", "sync_im")
		return err == nil && queryErr == nil && count == "2" && pending == "0" && !loseRegistrationResponse.Load()
	})
	agentToken := authJSON(t, im.URL, "POST", "/auth/login", "", map[string]any{"username": "alpha", "password": password, "transport": "bearer"}, 200)["token"].(string)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(trigger.URL, "http")+"/agent-connections", http.Header{"Authorization": []string{"Bearer " + agentToken}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var ready map[string]any
	if err := conn.ReadJSON(&ready); err != nil || ready["type"] != "ready" {
		t.Fatalf("ready: %v %v", ready, err)
	}
	readMessage := func(wantID string) {
		t.Helper()
		conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		var frame struct {
			Type string `json:"type"`
			model.Delivery
		}
		if err := conn.ReadJSON(&frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type != "delivery" || frame.AgentID != agentID || frame.Message.MessageID != wantID {
			t.Fatalf("unexpected delivery: %+v", frame)
		}
		if err := conn.WriteJSON(map[string]string{"type": "ack", "message_id": wantID}); err != nil {
			t.Fatal(err)
		}
	}
	unavailable.Store(true)
	direct := authJSON(t, im.URL, "POST", "/conversations/direct", humanToken, map[string]any{"agent_id": agentID}, 200)["conversation"].(map[string]any)["conversation_id"].(string)
	first := authJSON(t, im.URL, "POST", "/conversations/"+direct+"/messages", humanToken, map[string]any{"content": "one"}, 201)["message"].(map[string]any)["message_id"].(string)
	second := authJSON(t, im.URL, "POST", "/conversations/"+direct+"/messages", humanToken, map[string]any{"content": "two"}, 201)["message"].(map[string]any)["message_id"].(string)
	eventually(t, "outage retains notification", func() bool {
		count, err := instance.query("SELECT COUNT(*) FROM trigger_outbox WHERE attempts>0", "sync_im")
		return err == nil && count == "1"
	})
	stop()
	reopened, err := imRepository.Open(t.Context(), imDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	unavailable.Store(false)
	loseMessageResponse.Store(true)
	stop = startSync(imService.New(reopened, client))
	defer stop()
	readMessage(first)
	readMessage(second)
	eventually(t, "retry preserves IDs and ACKs", func() bool {
		count, err := instance.query("SELECT COUNT(*) FROM deliveries WHERE acked_at IS NOT NULL", "sync_trigger")
		return err == nil && count == "2"
	})
	group := authJSON(t, im.URL, "POST", "/conversations", humanToken, map[string]any{"title": "team", "agent_ids": []string{agentID}}, 201)["conversation"].(map[string]any)["conversation_id"].(string)
	path := "/conversations/" + group
	authJSON(t, im.URL, "POST", path+"/members", humanToken, map[string]any{"participant_id": otherID}, 200)
	groupSource := model.Source{ChannelType: model.IMGroup, ConversationID: group}
	var channelID string
	eventually(t, "group subscriptions", func() bool {
		channels, err := store.ListChannels(t.Context(), groupSource)
		if err != nil || len(channels) != 2 {
			return false
		}
		channelID = channels[0].ChannelID
		return true
	})
	mentioned := authJSON(t, im.URL, "POST", path+"/messages", humanToken, map[string]any{"content": "@alpha", "mentioned_agent_ids": []string{agentID}}, 201)["message"].(map[string]any)["message_id"].(string)
	readMessage(mentioned)
	reply := authJSON(t, im.URL, "POST", path+"/messages", agentToken, map[string]any{"content": "@beta", "mentioned_agent_ids": []string{otherID}, "quoted_message_id": mentioned}, 201)["message"].(map[string]any)["message_id"].(string)
	eventually(t, "Agent reply delivered to offline Agent", func() bool {
		pending, err := store.NextDelivery(t.Context(), otherID, channelID)
		return err == nil && pending.Message.MessageID == reply && pending.Message.SenderKind == "agent" && pending.Message.QuotedMessageID != nil && *pending.Message.QuotedMessageID == mentioned
	})
	authJSON(t, im.URL, "POST", path+"/messages", humanToken, map[string]any{"content": "no mention"}, 201)
	authJSON(t, im.URL, "DELETE", path+"/members/"+agentID, humanToken, nil, 204)
	eventually(t, "removed Agent unsubscribed", func() bool {
		channels, err := store.ListChannels(t.Context(), groupSource)
		return err == nil && len(channels) == 1 && channels[0].AgentID == otherID
	})
	authJSON(t, im.URL, "POST", path+"/dissolve", humanToken, nil, 200)
	eventually(t, "group cleared and outbox drained", func() bool {
		channels, err := store.ListChannels(t.Context(), groupSource)
		count, queryErr := instance.query("SELECT COUNT(*) FROM trigger_outbox", "sync_im")
		return err == nil && queryErr == nil && len(channels) == 0 && count == "0"
	})
	if count, err := instance.query("SELECT COUNT(*) FROM deliveries", "sync_trigger"); err != nil || count != "4" {
		t.Fatalf("unexpected duplicate or unmentioned delivery: %s %v", count, err)
	}
	// Existing queued messages remain available after unsubscribe/clear.
	if _, err := store.NextDelivery(t.Context(), otherID, channelID); err != nil {
		t.Fatal(err)
	}
}
