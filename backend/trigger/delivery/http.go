package delivery

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"yqx-team/backend/trigger/model"
)

// HTTP posts an envelope to the shared Agent adapter, which selects the agent by agent_id.
type HTTP struct {
	url    string
	client *http.Client
}

func NewHTTP(url string) *HTTP {
	return &HTTP{url: url, client: &http.Client{
		Timeout: 10 * time.Second,
		// A redirect must not turn this POST into a successful GET without delivering its body.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

func (h *HTTP) Deliver(ctx context.Context, delivery model.Delivery) error {
	body, err := json.Marshal(delivery)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, h.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := h.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("Agent endpoint returned HTTP %d", response.StatusCode)
	}
	return nil
}
