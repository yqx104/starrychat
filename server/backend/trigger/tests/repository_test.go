package tests

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"starrychat/backend/trigger/config"
	"starrychat/backend/trigger/handler"
	"starrychat/backend/trigger/repository"
	"starrychat/backend/trigger/service"
)

// Opt-in and read-only: use the existing private config without creating data or changing schema.
func TestMySQLHealthLifecycle(t *testing.T) {
	path := os.Getenv("TRIGGER_TEST_CONFIG")
	if path == "" {
		t.Skip("set TRIGGER_TEST_CONFIG to an absolute private config path for the read-only MySQL check")
	}
	c, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	store, err := repository.Open(ctx, c.MySQLDSN)
	if err != nil {
		t.Fatal("open configured MySQL failed")
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.CheckSchema(ctx); err != nil {
		t.Fatalf("configured schema is not ready: %v", err)
	}
	server := httptest.NewServer(handler.New(service.New(store)))
	defer server.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	check := func(want int) {
		t.Helper()
		response, err := client.Get(server.URL + "/healthz")
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != want {
			t.Fatalf("health status = %d, want %d", response.StatusCode, want)
		}
	}
	check(http.StatusOK)
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	check(http.StatusServiceUnavailable)
}
