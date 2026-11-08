package tests

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"starrychat/backend/trigger/delivery"
	"starrychat/backend/trigger/model"
)

func TestDeliveryDoesNotFollowRedirectsOrIgnoreCancellation(t *testing.T) {
	var redirected atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "/success", http.StatusFound)
			return
		}
		redirected.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	if err := delivery.NewHTTP(server.URL+"/redirect").Deliver(t.Context(), model.Delivery{}); err == nil {
		t.Fatal("redirect reported as a successful delivery")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := delivery.NewHTTP(server.URL+"/success").Deliver(ctx, model.Delivery{}); err == nil {
		t.Fatal("canceled delivery reported as successful")
	}
	if redirected.Load() != 0 {
		t.Fatal("unexpected request after redirect or cancellation")
	}
}
