package tests

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"yqx-team/backend/trigger/handler"
)

type healthService struct {
	handler.Service
	err    error
	called bool
}

func (s *healthService) Health(context.Context) error {
	s.called = true
	return s.err
}

func TestHealthChecksDatabaseWithoutAuthentication(t *testing.T) {
	for _, test := range []struct {
		name   string
		err    error
		status int
	}{
		{"ready", nil, http.StatusOK},
		{"database_unavailable", errors.New("database is offline"), http.StatusServiceUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &healthService{err: test.err}
			response := httptest.NewRecorder()
			handler.New(service).ServeHTTP(response, httptest.NewRequest("GET", "/healthz", nil))
			if !service.called || response.Code != test.status {
				t.Fatalf("health called=%v, status=%d, want %d", service.called, response.Code, test.status)
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("health response must reflect current database availability")
			}
			if test.err == nil {
				var body handler.HealthResponse
				if err := json.NewDecoder(response.Body).Decode(&body); err != nil || body.Status != "ok" {
					t.Fatalf("invalid health response: %+v, %v", body, err)
				}
			} else {
				var body handler.ErrorResponse
				if err := json.NewDecoder(response.Body).Decode(&body); err != nil || body.Error.Code != "DATABASE_UNAVAILABLE" {
					t.Fatalf("invalid error response: %+v, %v", body, err)
				}
			}
		})
	}
}
