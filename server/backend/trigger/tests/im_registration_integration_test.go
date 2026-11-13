package tests

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"

	"starrychat/backend/trigger/handler"
	"starrychat/backend/trigger/repository"
	"starrychat/backend/trigger/service"
)

func TestIMRegistersAgentsWithTrigger(t *testing.T) {
	instance := startMySQL(t)
	for name, path := range map[string]string{"registration_im": "../../im/sql/schema.sql", "registration_trigger": "../sql/schema.sql"} {
		schema, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if output, err := instance.query("CREATE DATABASE "+name+"; USE "+name+"; "+string(schema), ""); err != nil {
			t.Fatalf("schema: %v %s", err, output)
		}
	}
	store, err := repository.Open(t.Context(), fmt.Sprintf("root@unix(%s)/registration_trigger?charset=utf8mb4", instance.socket))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	var unavailable atomic.Bool
	api := handler.New(service.New(store))
	trigger := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if unavailable.Load() {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		api.ServeHTTP(w, r)
	}))
	t.Cleanup(trigger.Close)
	directory := t.TempDir()
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(directory, "im")
	if output, err := exec.CommandContext(t.Context(), "go", "build", "-race", "-o", binary, "../../im/cmd").CombinedOutput(); err != nil {
		t.Fatalf("build IM: %v %s", err, output)
	}
	config, _ := json.Marshal(map[string]any{
		"mysql_dsn": fmt.Sprintf("root@unix(%s)/registration_im?charset=utf8mb4", instance.socket),
		"address":   "127.0.0.1:0", "trigger_base_url": trigger.URL,
	})
	configPath := filepath.Join(directory, "im.json")
	if err := os.WriteFile(configPath, config, 0600); err != nil {
		t.Fatal(err)
	}
	imURL, _ := startChild(t, exec.Command(binary, "-config", configPath), "IM 已就绪：")
	password := newID(t)
	human := authJSON(t, imURL, "POST", "/auth/register", "", map[string]any{"username": "owner", "password": password, "name": "Owner", "kind": "human"}, 201)["participant"].(map[string]any)
	if _, err := store.GetAgent(t.Context(), human["participant_id"].(string)); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("human was registered with Trigger: %v", err)
	}
	token := authJSON(t, imURL, "POST", "/auth/login", "", map[string]any{"username": "owner", "password": password, "transport": "bearer"}, 200)["token"].(string)
	queryCount := func(t *testing.T, query, database, want string) {
		t.Helper()
		if got, err := instance.query(query, database); err != nil || got != want {
			t.Fatalf("count in %s: got %q, want %q, error %v", database, got, want, err)
		}
	}
	count := 0
	for _, route := range []struct{ path, field, username string }{
		{"/agents", "agent", "managed-agent"},
		{"/auth/register", "participant", "legacy-agent"},
	} {
		t.Run(route.path, func(t *testing.T) {
			input := map[string]any{"username": route.username, "password": password, "name": "Agent"}
			if route.path == "/auth/register" {
				input["kind"] = "agent"
			}
			// Creation commits locally while Trigger is unavailable; the worker retries.
			unavailable.Store(true)
			created := authJSON(t, imURL, "POST", route.path, token, input, 201)[route.field].(map[string]any)
			id := created["participant_id"].(string)
			queryCount(t, "SELECT COUNT(*) FROM participant_accounts WHERE username='"+route.username+"'", "registration_im", "1")
			queryCount(t, "SELECT COUNT(*) FROM participants WHERE kind='agent'", "registration_im", strconv.Itoa(count+1))
			eventually(t, "registration retained for retry", func() bool {
				pending, err := instance.query("SELECT COUNT(*) FROM trigger_outbox WHERE operation='register_agent' AND attempts>0", "registration_im")
				return err == nil && pending == "1"
			})
			unavailable.Store(false)
			eventually(t, "Agent registered without a WS connection", func() bool {
				_, err := store.GetAgent(t.Context(), id)
				pending, queryErr := instance.query("SELECT COUNT(*) FROM trigger_outbox", "registration_im")
				return err == nil && queryErr == nil && pending == "0"
			})
			registered, err := store.GetAgent(t.Context(), id)
			if err != nil || registered.AgentID != id {
				t.Fatalf("new IM Agent missing from Trigger before any WS connection: %v", err)
			}
			// The registration endpoint remains safe for duplicate calls and WS registration.
			repeated := requestJSON[handler.AgentResponse](t, trigger.URL, "PUT", "/agents/"+id, nil, 200)
			if repeated.Agent != registered {
				t.Fatal("duplicate registration changed the Trigger Agent")
			}
			authJSON(t, imURL, "POST", route.path, token, input, 409)
			count++
			queryCount(t, "SELECT COUNT(*) FROM agents", "registration_trigger", strconv.Itoa(count))
			queryCount(t, "SELECT COUNT(*) FROM participants WHERE kind='agent'", "registration_im", strconv.Itoa(count))
		})
	}
}
