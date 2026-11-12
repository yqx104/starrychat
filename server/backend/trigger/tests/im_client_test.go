package tests

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"starrychat/backend/trigger/connections"
	"starrychat/backend/trigger/imclient"
)

func TestIMClientAuthenticatesAndRenews(t *testing.T) {
	id := newID(t)
	expires := time.Now().Add(time.Hour).UnixMilli()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil || len(body) != 0 || r.Method != http.MethodGet || r.URL.Path != "/im/auth/me" ||
			r.Header.Get("Authorization") != "Bearer original-token" {
			t.Error("authentication must send a GET with the Agent's Bearer credential")
		}
		w.Header().Set("X-IM-Token", "renewed-token")
		w.Header().Set("X-IM-Token-Expires-At", strconv.FormatInt(expires, 10))
		fmt.Fprintf(w, `{"participant":{"participant_id":%q,"kind":"agent"}}`, id)
	}))
	defer server.Close()
	who, err := imclient.New(server.URL+"/im/").Authenticate(t.Context(), "original-token")
	if err != nil {
		t.Fatal(err)
	}
	if who.AgentID != id || who.Token != "renewed-token" || who.ExpiresAt != expires {
		t.Fatalf("incorrect identity or renewed credential: %+v", who)
	}
}

func TestConnectionRejectsInvalidIMIdentity(t *testing.T) {
	id := newID(t)
	body := fmt.Sprintf(`{"participant":{"participant_id":%q,"kind":"agent"}}`, id)
	expires := strconv.FormatInt(time.Now().Add(time.Hour).UnixMilli(), 10)
	for _, tc := range []struct {
		name       string
		status     int
		body       string
		token      string
		expires    string
		wantStatus int
	}{
		{"unauthorized", 401, "", "", "", 401},
		{"forbidden_credential", 403, "", "", "", 401},
		{"unavailable", 503, "", "", "", 503},
		{"redirect", 307, "", "", "", 503},
		{"missing_identity", 204, "", "", "", 503},
		{"invalid_json", 200, "not JSON", "renewed", expires, 503},
		{"missing_participant", 200, `{}`, "renewed", expires, 403},
		{"human", 200, fmt.Sprintf(`{"participant":{"participant_id":%q,"kind":"human"}}`, id), "", "", 403},
		{"invalid_agent_id", 200, `{"participant":{"participant_id":"invalid","kind":"agent"}}`, "renewed", expires, 403},
		{"missing_token", 200, body, "", expires, 503},
		{"missing_expiry", 200, body, "renewed", "", 503},
		{"invalid_expiry", 200, body, "renewed", "invalid", 503},
		{"expired", 200, body, "renewed", strconv.FormatInt(time.Now().Add(-time.Hour).UnixMilli(), 10), 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int64
			im := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Location", "/redirected")
				w.Header().Set("X-IM-Token", tc.token)
				w.Header().Set("X-IM-Token-Expires-At", tc.expires)
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer im.Close()
			request := httptest.NewRequest(http.MethodGet, "/agent-connections", nil)
			request.Header.Set("Authorization", "bEaReR original-token")
			response := httptest.NewRecorder()
			// Rejected identities must fail before accessing the database or upgrading to WS.
			connections.New(nil, imclient.New(im.URL)).ServeHTTP(response, request)
			if response.Code != tc.wantStatus {
				t.Fatalf("handshake status = %d, want %d", response.Code, tc.wantStatus)
			}
			if calls.Load() != 1 {
				t.Fatalf("IM calls = %d, want 1 without redirects", calls.Load())
			}
		})
	}
}

func TestConnectionRejectsMalformedBearerBeforeCallingIM(t *testing.T) {
	var calls atomic.Int64
	im := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer im.Close()
	sockets := connections.New(nil, imclient.New(im.URL))
	for _, header := range []string{"", "Basic test", "Bearer", "Bearer test extra"} {
		request := httptest.NewRequest(http.MethodGet, "/agent-connections", nil)
		request.Header.Set("Authorization", header)
		response := httptest.NewRecorder()
		sockets.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("malformed Authorization %q returned %d", header, response.Code)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("malformed Bearer headers caused %d IM calls", calls.Load())
	}
}

func TestIMClientHonorsRequestDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	if _, err := imclient.New(server.URL).Authenticate(ctx, "original-token"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("authentication did not respect request deadline: %v", err)
	}
}
