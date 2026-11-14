package tests

import (
	"bufio"
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"starrychat/backend/trigger/connections"
	"starrychat/backend/trigger/handler"
	"starrychat/backend/trigger/imclient"
	"starrychat/backend/trigger/model"
	"starrychat/backend/trigger/repository"
	"starrychat/backend/trigger/service"
)

func eventually(t *testing.T, description string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("timed out: " + description)
}

func startChild(t *testing.T, command *exec.Cmd, prefix string) (string, func()) {
	t.Helper()
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			_ = command.Process.Signal(os.Interrupt)
			select {
			case <-done:
			case <-time.After(10 * time.Second):
				_ = command.Process.Kill()
				<-done
				t.Error("child shutdown timed out")
			}
		})
	}
	t.Cleanup(stop)
	ready := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if value, ok := strings.CutPrefix(scanner.Text(), prefix); ok {
				ready <- value
				return
			}
		}
		ready <- ""
	}()
	select {
	case address := <-ready:
		if address != "" {
			return address, stop
		}
	case <-time.After(15 * time.Second):
	}
	stop()
	t.Fatalf("child did not start: %s", stderr.String())
	return "", stop
}

func authJSON(t *testing.T, base, method, path, token string, body any, want int) map[string]any {
	t.Helper()
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	req, err := http.NewRequestWithContext(t.Context(), method, base+path, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result map[string]any
	if response.StatusCode != http.StatusNoContent {
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
	}
	if response.StatusCode != want {
		t.Fatalf("%s %s: status %d, want %d: %v", method, path, response.StatusCode, want, result)
	}
	return result
}

func TestAdaptorEndToEnd(t *testing.T) {
	instance := startMySQL(t)
	for name, path := range map[string]string{"adaptor_im": "../../im/sql/schema.sql", "adaptor_trigger": "../sql/schema.sql"} {
		schema, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if output, err := instance.query("CREATE DATABASE "+name+"; USE "+name+"; "+string(schema), ""); err != nil {
			t.Fatalf("schema: %v %s", err, output)
		}
	}
	directory := t.TempDir()
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	writeConfig := func(name string, value any) string {
		t.Helper()
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	imBinary := filepath.Join(directory, "im")
	if output, err := exec.CommandContext(t.Context(), "go", "build", "-o", imBinary, "../../im/cmd").CombinedOutput(); err != nil {
		t.Fatalf("build IM: %v %s", err, output)
	}
	triggerListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { triggerListener.Close() })
	imConfig := writeConfig("im.json", map[string]any{"mysql_dsn": fmt.Sprintf("root@unix(%s)/adaptor_im?charset=utf8mb4", instance.socket), "address": "127.0.0.1:0", "insecure_local_http": true, "trigger_base_url": "http://" + triggerListener.Addr().String()})
	imURL, stopIM := startChild(t, exec.Command(imBinary, "-config", imConfig), "IM 已就绪：")
	password := newID(t)
	authJSON(t, imURL, "POST", "/auth/register", "", map[string]any{"username": "human", "password": password, "name": "Human"}, 201)
	humanToken := authJSON(t, imURL, "POST", "/auth/login", "", map[string]any{"username": "human", "password": password, "transport": "bearer"}, 200)["token"].(string)
	dsn := fmt.Sprintf("root@unix(%s)/adaptor_trigger?charset=utf8mb4", instance.socket)
	startTrigger := func(address string) (*repository.Repository, *connections.Server, *httptest.Server) {
		t.Helper()
		store, err := repository.Open(t.Context(), dsn)
		if err != nil {
			t.Fatal(err)
		}
		sockets := connections.New(store, imclient.New(imURL))
		mux := http.NewServeMux()
		mux.Handle("GET /agent-connections", sockets)
		mux.Handle("/", handler.New(service.New(store)))
		server := httptest.NewUnstartedServer(mux)
		server.Listener.Close()
		if address == "" {
			server.Listener = triggerListener
		} else {
			server.Listener, err = net.Listen("tcp", address)
			if err != nil {
				t.Fatal(err)
			}
		}
		server.Start()
		t.Cleanup(func() { sockets.Close(); server.Close(); store.Close() })
		return store, sockets, server
	}
	store, sockets, trigger := startTrigger("")
	agent := authJSON(t, imURL, "POST", "/agents", humanToken, map[string]any{"username": "agent", "password": password, "name": "Pi Agent"}, 201)["agent"].(map[string]any)
	agentID := agent["participant_id"].(string)
	eventually(t, "Agent registered through IM outbox", func() bool {
		_, err := store.GetAgent(t.Context(), agentID)
		return err == nil
	})
	triggerURL := trigger.URL
	wsURL := "ws" + strings.TrimPrefix(triggerURL, "http") + "/agent-connections"
	backend, err := filepath.Abs("../../../../client/adaptor/backend")
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	config := writeConfig("adaptor.json", map[string]any{"address": address, "im_base_url": imURL, "trigger_ws_url": wsURL, "adaptor_id": newID(t), "sqlite_path": filepath.Join(directory, "adaptor.sqlite")})
	if output, err := exec.CommandContext(t.Context(), "node", filepath.Join(backend, "src/init-db.ts"), config).CombinedOutput(); err != nil {
		t.Fatalf("init sqlite: %v %s", err, output)
	}
	clientURL, stopClient := startChild(t, exec.Command("node", filepath.Join(backend, "src/main.ts"), config), "Adaptor 已就绪：")
	authJSON(t, clientURL, "POST", "/agents", "", map[string]string{"username": "human", "password": password}, 400)
	added := authJSON(t, clientURL, "POST", "/agents", "", map[string]string{"username": "agent", "password": password}, 201)["agent"].(map[string]any)
	if added["agent_id"] != agentID || added["token"] != nil {
		t.Fatal("incorrect or exposed Agent identity")
	}
	authJSON(t, clientURL, "POST", "/agents", "", map[string]string{"username": "agent", "password": password}, 409)
	state := func() string {
		return authJSON(t, clientURL, "GET", "/agents", "", nil, 200)["agents"].([]any)[0].(map[string]any)["connection_state"].(string)
	}
	eventually(t, "Agent online", func() bool { return state() == "online" })
	for token, want := range map[string]int{"": 401, humanToken: 403} {
		headers := http.Header{}
		if token != "" {
			headers.Set("Authorization", "Bearer "+token)
		}
		conn, response, err := websocket.DefaultDialer.Dial(wsURL, headers)
		if conn != nil {
			conn.Close()
		}
		if err == nil || response == nil || response.StatusCode != want {
			t.Fatal("WS identity check failed")
		}
		response.Body.Close()
	}
	agentToken := authJSON(t, imURL, "POST", "/auth/login", "", map[string]any{"username": "agent", "password": password, "transport": "bearer"}, 200)["token"].(string)
	conn, response, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Authorization": []string{"Bearer " + agentToken}})
	if conn != nil {
		conn.Close()
	}
	if err == nil || response == nil || response.StatusCode != 409 {
		t.Fatal("duplicate Agent connection accepted")
	}
	response.Body.Close()
	conversation := authJSON(t, imURL, "POST", "/conversations/direct", humanToken, map[string]any{"agent_id": agentID}, 200)["conversation"].(map[string]any)
	source := model.Source{ChannelType: model.IMDirect, ConversationID: conversation["conversation_id"].(string)}
	var subscription model.Channel
	eventually(t, "IM direct chat creates Trigger subscription", func() bool {
		channels, err := store.ListChannels(t.Context(), source)
		if err != nil || len(channels) != 1 {
			return false
		}
		subscription = channels[0]
		return subscription.AgentID == agentID
	})
	message := func(seq int64) model.Message {
		t.Helper()
		body := authJSON(t, imURL, "POST", "/conversations/"+source.ConversationID+"/messages", humanToken, map[string]any{"content": fmt.Sprintf("message %d", seq)}, 201)["message"]
		data, _ := json.Marshal(body)
		var result model.Message
		if err := json.Unmarshal(data, &result); err != nil {
			t.Fatal(err)
		}
		result.Source, result.SenderKind = source, "human"
		if result.MessageSeq != seq {
			t.Fatalf("message seq = %d, want %d", result.MessageSeq, seq)
		}
		return result
	}
	inbox := func() []any {
		return authJSON(t, clientURL, "GET", "/agents/"+agentID+"/inbox", "", nil, 200)["messages"].([]any)
	}
	first := message(1)
	eventually(t, "committed receipt and ACK", func() bool {
		_, err := store.NextDelivery(t.Context(), agentID, subscription.ChannelID)
		return len(inbox()) == 1 && errors.Is(err, sql.ErrNoRows)
	})
	requestJSON[handler.MessageResponse](t, triggerURL, "POST", "/messages", first, 202)
	// Model an ACK lost before Trigger persisted it; the local receipt must not duplicate.
	if _, err := instance.query("UPDATE deliveries SET acked_at=NULL", "adaptor_trigger"); err != nil {
		t.Fatal(err)
	}
	eventually(t, "duplicate delivery ACK", func() bool {
		_, err := store.NextDelivery(t.Context(), agentID, subscription.ChannelID)
		return errors.Is(err, sql.ErrNoRows)
	})
	if len(inbox()) != 1 {
		t.Fatal("duplicate receipt")
	}
	authJSON(t, clientURL, "PATCH", "/agents/"+agentID, "", map[string]bool{"enabled": false}, 200)
	message(2)
	if len(inbox()) != 1 {
		t.Fatal("disabled Agent received a message")
	}
	// Restart Trigger with the same database and address while delivery remains pending.
	listenAddress := trigger.Listener.Addr().String()
	sockets.Close()
	trigger.Close()
	store.Close()
	store, sockets, trigger = startTrigger(listenAddress)
	authJSON(t, clientURL, "PATCH", "/agents/"+agentID, "", map[string]bool{"enabled": true}, 200)
	eventually(t, "offline message after Trigger restart", func() bool { return len(inbox()) == 2 })
	stopClient()
	message(3)
	clientURL, _ = startChild(t, exec.Command("node", filepath.Join(backend, "src/main.ts"), config), "Adaptor 已就绪：")
	eventually(t, "client restart restores credentials and receipts", func() bool {
		_, err := store.NextDelivery(t.Context(), agentID, subscription.ChannelID)
		return len(inbox()) == 3 && errors.Is(err, sql.ErrNoRows)
	})
	for _, item := range inbox() {
		if item.(map[string]any)["state"] != "pending" {
			t.Fatal("receipt was incorrectly marked executed")
		}
	}
	// Break an enabled client's transport and let its automatic retry recover it.
	listenAddress = trigger.Listener.Addr().String()
	sockets.Close()
	trigger.Close()
	store.Close()
	message(4)
	eventually(t, "failed IM notification retained for retry", func() bool {
		count, err := instance.query("SELECT COUNT(*) FROM trigger_outbox WHERE attempts>0", "adaptor_im")
		return err == nil && count == "1"
	})
	stopIM()
	imConfig = writeConfig("im.json", map[string]any{"mysql_dsn": fmt.Sprintf("root@unix(%s)/adaptor_im?charset=utf8mb4", instance.socket), "address": strings.TrimPrefix(imURL, "http://"), "insecure_local_http": true, "trigger_base_url": triggerURL})
	imURL, _ = startChild(t, exec.Command(imBinary, "-config", imConfig), "IM 已就绪：")
	store, sockets, trigger = startTrigger(listenAddress)
	eventually(t, "IM outbox restart recovery and automatic WS reconnect", func() bool {
		_, err := store.NextDelivery(t.Context(), agentID, subscription.ChannelID)
		return len(inbox()) == 4 && errors.Is(err, sql.ErrNoRows)
	})

	// Group membership changes and @ messages also enter through IM's public API.
	group := authJSON(t, imURL, "POST", "/conversations", humanToken, map[string]any{"title": "Team", "agent_ids": []string{agentID}}, 201)["conversation"].(map[string]any)
	groupID := group["conversation_id"].(string)
	groupSource := model.Source{ChannelType: model.IMGroup, ConversationID: groupID}
	other := authJSON(t, imURL, "POST", "/agents", humanToken, map[string]any{"username": "second-agent", "password": password, "name": "Second"}, 201)["agent"].(map[string]any)
	otherID := other["participant_id"].(string)
	authJSON(t, imURL, "POST", "/conversations/"+groupID+"/members", humanToken, map[string]any{"participant_id": otherID}, 200)
	var groupChannelID string
	eventually(t, "IM group members subscribed", func() bool {
		channels, err := store.ListChannels(t.Context(), groupSource)
		if err != nil || len(channels) != 2 {
			return false
		}
		groupChannelID = channels[0].ChannelID
		return true
	})
	groupMessage := authJSON(t, imURL, "POST", "/conversations/"+groupID+"/messages", humanToken,
		map[string]any{"content": "@both", "mentioned_agent_ids": []string{agentID, otherID}}, 201)["message"].(map[string]any)
	eventually(t, "IM group @ delivery online and offline", func() bool {
		pending, err := store.NextDelivery(t.Context(), otherID, groupChannelID)
		return len(inbox()) == 5 && err == nil && pending.Message.MessageID == groupMessage["message_id"]
	})
	authJSON(t, imURL, "POST", "/conversations/"+groupID+"/messages", humanToken, map[string]any{"content": "no mention"}, 201)
	eventually(t, "group message without @ processed", func() bool {
		count, err := instance.query("SELECT COUNT(*) FROM trigger_outbox", "adaptor_im")
		return err == nil && count == "0"
	})
	if len(inbox()) != 5 {
		t.Fatal("group message without @ was delivered")
	}
	authJSON(t, imURL, "DELETE", "/conversations/"+groupID+"/members/"+agentID, humanToken, nil, 204)
	eventually(t, "removed Agent unsubscribed", func() bool {
		channels, err := store.ListChannels(t.Context(), groupSource)
		return err == nil && len(channels) == 1 && channels[0].AgentID == otherID
	})
	authJSON(t, imURL, "POST", "/conversations/"+groupID+"/dissolve", humanToken, nil, 200)
	eventually(t, "dissolved group subscriptions cleared", func() bool {
		channels, err := store.ListChannels(t.Context(), groupSource)
		return err == nil && len(channels) == 0
	})

	// A connected socket must not remain authorized beyond its validated expiry.
	shortID := newID(t)
	shortIM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-IM-Token", "short-lived-test-token")
		w.Header().Set("X-IM-Token-Expires-At", fmt.Sprint(time.Now().Add(time.Second).UnixMilli()))
		_ = json.NewEncoder(w).Encode(map[string]any{"participant": map[string]string{"participant_id": shortID, "kind": "agent"}})
	}))
	defer shortIM.Close()
	shortSockets := connections.New(store, imclient.New(shortIM.URL))
	shortServer := httptest.NewServer(shortSockets)
	defer shortServer.Close()
	defer shortSockets.Close()
	shortConn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(shortServer.URL, "http"), http.Header{"Authorization": []string{"Bearer test"}})
	if err != nil {
		t.Fatal(err)
	}
	defer shortConn.Close()
	shortConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var ready map[string]any
	if err := shortConn.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
	if _, _, err := shortConn.ReadMessage(); !websocket.IsCloseError(err, 4001) {
		t.Fatalf("expired WS remained authorized: %v", err)
	}
}
