package tests

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"

	"github.com/go-sql-driver/mysql"

	"yqx-team/backend/im/handler"
	"yqx-team/backend/im/model"
	"yqx-team/backend/im/repository"
	"yqx-team/backend/im/service"
)

var databaseSequence atomic.Int64
var _ handler.Service = (*service.Service)(nil)

type imFixture struct {
	conversationIDs              []string
	dsn                          string
	store                        *repository.Repository
	db                           *sql.DB
	handle                       *handler.Handler
	human, alpha, beta, outsider model.Participant
}

func newIMFixture(t *testing.T, instance *mysqlInstance) *imFixture {
	t.Helper()
	database := fmt.Sprintf("im_business_%d", databaseSequence.Add(1))
	if output, err := instance.query("CREATE DATABASE "+database+" CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin", ""); err != nil {
		t.Fatalf("create test database: %v %s", err, output)
	}
	schema, err := os.ReadFile(filepath.Join("..", "sql", "schema.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if output, err := instance.query(string(schema), database); err != nil {
		t.Fatalf("apply test schema: %v %s", err, output)
	}
	config := mysql.NewConfig()
	config.User, config.Net, config.Addr, config.DBName = "root", "unix", instance.socket, database
	f := &imFixture{dsn: config.FormatDSN()}
	f.store, err = repository.Open(t.Context(), f.dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.store.Close() })
	if err := f.store.CheckSchema(t.Context()); err != nil {
		t.Fatal(err)
	}
	f.db, err = sql.Open("mysql", f.dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.db.Close() })
	err = f.store.WithinTx(t.Context(), nil, func(q *repository.Queries) error {
		for _, seed := range []struct {
			target *model.Participant
			kind   model.ParticipantKind
			name   string
		}{
			{&f.human, model.Human, "用户"}, {&f.alpha, model.Agent, "Alpha"},
			{&f.beta, model.Agent, "Beta"}, {&f.outsider, model.Agent, "Outsider"},
		} {
			participant, err := q.InsertParticipant(t.Context(), seed.kind, seed.name, 1700000000000)
			if err != nil {
				return err
			}
			*seed.target = participant
			var ownerID *string
			if participant.Kind == model.Agent {
				owner := f.human.ParticipantID
				ownerID = &owner
			}
			if err := q.InsertAccount(t.Context(), model.ParticipantAccount{ParticipantID: participant.ParticipantID, Kind: participant.Kind, OwnerParticipantID: ownerID, Username: fmt.Sprintf("fixture-%s", participant.ParticipantID), Password: "business-fixture-password", CreatedAt: participant.CreatedAt}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	f.handle = handler.New(service.New(f.store))
	return f
}

func (f *imFixture) request(ctx context.Context, method, path string, body any, caller string) *httptest.ResponseRecorder {
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			panic(err)
		}
	}
	r := httptest.NewRequestWithContext(ctx, method, "http://im.local"+path, bytes.NewReader(data))
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	r = r.WithContext(handler.WithCaller(r.Context(), model.RequestContext{ParticipantID: caller}))
	return serve(f.handle, r)
}

type apiOptions struct {
	method string
	body   any
	caller string
	status int
}

func apiJSON[T any](t *testing.T, f *imFixture, path string, options ...apiOptions) T {
	t.Helper()
	opt := apiOptions{}
	if len(options) != 0 {
		opt = options[0]
	}
	if opt.method == "" {
		opt.method = "GET"
	}
	if opt.caller == "" {
		opt.caller = f.human.ParticipantID
	}
	if opt.status == 0 {
		opt.status = 200
	}
	w := f.request(t.Context(), opt.method, path, opt.body, opt.caller)
	if w.Code != opt.status {
		t.Fatalf("%s %s: status %d, want %d: %s", opt.method, path, w.Code, opt.status, w.Body)
	}
	var value T
	if opt.status != http.StatusNoContent {
		if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
			t.Fatalf("decode response: %v: %s", err, w.Body)
		}
	}
	if response, ok := any(value).(handler.ConversationResponse); ok && opt.method == "POST" && (path == "/conversations" || path == "/conversations/direct") {
		found := false
		for _, id := range f.conversationIDs {
			if id == response.Conversation.ConversationID {
				found = true
			}
		}
		if !found {
			f.conversationIDs = append(f.conversationIDs, response.Conversation.ConversationID)
		}
	}
	return value
}

func (f *imFixture) group(t *testing.T, agents ...model.Participant) model.Conversation {
	t.Helper()
	ids := make([]string, len(agents))
	for i, agent := range agents {
		ids[i] = agent.ParticipantID
	}
	return apiJSON[handler.ConversationResponse](t, f, "/conversations", apiOptions{method: "POST", status: 201, body: map[string]any{"title": "Team", "agent_ids": ids}}).Conversation
}

func (f *imFixture) send(t *testing.T, conversationID string, content string, sender model.Participant) model.Message {
	t.Helper()
	return apiJSON[handler.MessageResponse](t, f, fmt.Sprintf("/conversations/%s/messages", conversationID), apiOptions{method: "POST", status: 201, caller: sender.ParticipantID, body: map[string]any{"content": content}}).Message
}

func (f *imFixture) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := f.db.ExecContext(t.Context(), query, args...); err != nil {
		t.Fatal(err)
	}
}

func (f *imFixture) count(t *testing.T, query string, args ...any) int64 {
	t.Helper()
	var value int64
	if err := f.db.QueryRowContext(t.Context(), query, args...).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func equalValue(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v; want %#v", got, want)
	}
}

// conversationID names the nth conversation created by this fixture, preserving its server-generated UUID.
func (f *imFixture) conversationID(index int) string {
	if index > 0 && index <= len(f.conversationIDs) {
		return f.conversationIDs[index-1]
	}
	return testID(int64(index))
}
