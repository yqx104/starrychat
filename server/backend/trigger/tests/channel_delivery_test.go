package tests

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"starrychat/backend/trigger/connections"
	"starrychat/backend/trigger/imclient"
	"starrychat/backend/trigger/model"
	"starrychat/backend/trigger/repository"
)

func TestChannelDeliveryOrderACKAndRecovery(t *testing.T) {
	instance := startMySQL(t)
	schema, err := os.ReadFile("../sql/schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	if output, err := instance.query("CREATE DATABASE channel_delivery; USE channel_delivery; "+string(schema), ""); err != nil {
		t.Fatalf("schema: %v %s", err, output)
	}
	agentID := newID(t)
	im := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-IM-Token", "test-token")
		w.Header().Set("X-IM-Token-Expires-At", fmt.Sprint(time.Now().Add(time.Hour).UnixMilli()))
		_ = json.NewEncoder(w).Encode(map[string]any{"participant": map[string]string{"participant_id": agentID, "kind": "agent"}})
	}))
	defer im.Close()
	startTrigger := func() (*repository.Repository, *httptest.Server, func()) {
		t.Helper()
		store, err := repository.Open(t.Context(), fmt.Sprintf("root@unix(%s)/channel_delivery?charset=utf8mb4", instance.socket))
		if err != nil {
			t.Fatal(err)
		}
		sockets := connections.New(store, imclient.New(im.URL))
		server := httptest.NewServer(sockets)
		stop := func() { sockets.Close(); server.Close(); store.Close() }
		t.Cleanup(stop)
		return store, server, stop
	}
	store, server, stop := startTrigger()
	delivery := func(channelID string, seq int64) model.Delivery {
		return model.Delivery{AgentID: agentID, ChannelID: channelID, Message: model.Message{
			Source:    model.Source{ChannelType: model.IMDirect, ConversationID: channelID},
			MessageID: newID(t), MessageSeq: seq, SenderID: newID(t), SenderKind: "human",
			Content: fmt.Sprintf("message %d", seq), CreatedAt: time.Now().UnixMilli(),
		}}
	}
	enqueue := func(items ...model.Delivery) {
		t.Helper()
		if err := store.Enqueue(t.Context(), items); err != nil {
			t.Fatal(err)
		}
	}
	connect := func() *websocket.Conn {
		t.Helper()
		conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), http.Header{"Authorization": []string{"Bearer test-token"}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.Close() })
		conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		var ready struct {
			Type    string `json:"type"`
			AgentID string `json:"agent_id"`
		}
		if err := conn.ReadJSON(&ready); err != nil {
			t.Fatal(err)
		}
		if ready.Type != "ready" || ready.AgentID != agentID {
			t.Fatal("missing Agent ready frame")
		}
		return conn
	}
	read := func(conn *websocket.Conn) model.Delivery {
		t.Helper()
		conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		var frame struct {
			Type string `json:"type"`
			model.Delivery
		}
		if err := conn.ReadJSON(&frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type != "delivery" || frame.AgentID != agentID {
			t.Fatal("invalid delivery frame")
		}
		return frame.Delivery
	}
	expect := func(conn *websocket.Conn, want model.Delivery) {
		t.Helper()
		got := read(conn)
		if got.ChannelID != want.ChannelID || got.Message.MessageID != want.Message.MessageID || got.Message.MessageSeq != want.Message.MessageSeq {
			t.Fatalf("got channel %s seq %d (%s), want channel %s seq %d (%s)", got.ChannelID, got.Message.MessageSeq, got.Message.MessageID, want.ChannelID, want.Message.MessageSeq, want.Message.MessageID)
		}
	}
	expectHeads := func(conn *websocket.Conn, items ...model.Delivery) {
		t.Helper()
		want := make(map[string]model.Delivery)
		for _, item := range items {
			want[item.ChannelID] = item
		}
		for range items {
			got := read(conn)
			item, ok := want[got.ChannelID]
			if !ok || got.Message.MessageID != item.Message.MessageID || got.Message.MessageSeq != item.Message.MessageSeq {
				t.Fatalf("unexpected channel head: %+v", got)
			}
			delete(want, got.ChannelID)
		}
	}
	ack := func(conn *websocket.Conn, item model.Delivery) {
		t.Helper()
		if err := conn.WriteJSON(map[string]string{"type": "ack", "message_id": item.Message.MessageID}); err != nil {
			t.Fatal(err)
		}
	}
	drained := func() bool {
		channels, err := store.PendingChannels(t.Context(), agentID)
		return err == nil && len(channels) == 0
	}

	x, y := newID(t), newID(t)
	x3, x7 := delivery(x, 3), delivery(x, 7)
	y2, y9 := delivery(y, 2), delivery(y, 9)
	// Existing queue rows must be ordered by source seq, not insertion ID.
	// Gaps are valid: an Agent does not receive every message in a conversation.
	enqueue(x7, y9, x3, y2, x3)
	otherAgent := delivery(x, 1)
	otherAgent.AgentID = newID(t)
	enqueue(otherAgent)
	conn := connect()
	expectHeads(conn, x3, y2)
	ack(conn, y2)
	expect(conn, y9) // X has not ACKed, but Y can advance.
	ack(conn, y9)
	ack(conn, y2) // Duplicate ACK must not advance another channel.
	ack(conn, x7) // An ACK for a message not yet sent must be ignored.

	// Discover a new channel while an existing one is waiting for ACK.
	z4 := delivery(newID(t), 4)
	enqueue(z4)
	expect(conn, z4)
	ack(conn, z4)
	expect(conn, x3) // Only X's unacknowledged head is retried after five seconds.
	ack(conn, x3)
	expect(conn, x7)

	// Drop the in-memory pending state and reopen the same database.
	stop()
	conn.Close()
	store, server, stop = startTrigger()
	x10, y15 := delivery(x, 10), delivery(y, 15)
	enqueue(x10, y15)
	conn = connect()
	expectHeads(conn, x7, y15)
	ack(conn, y15)
	ack(conn, x7)
	expect(conn, x10)
	ack(conn, x10)
	eventually(t, "all channel ACKs persisted", drained)

	// Acknowledged messages stay deduplicated, including across a restart.
	stop()
	conn.Close()
	store, server, _ = startTrigger()
	enqueue(x3, x7, x10, y2, y9, y15, z4)
	if !drained() {
		t.Fatal("acknowledged messages were queued again")
	}
	item, err := store.NextDelivery(t.Context(), otherAgent.AgentID, x)
	if err != nil || item.Message.MessageID != otherAgent.Message.MessageID {
		t.Fatalf("another Agent's queue was affected: %v", err)
	}
}
