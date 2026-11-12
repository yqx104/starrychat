package tests

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

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
