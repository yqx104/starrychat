package triggerclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"starrychat/backend/im/common"
)

type Client struct {
	baseURL string
	http    *http.Client
}

func New(baseURL string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		http: &http.Client{
			Timeout: 5 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

func (c *Client) RegisterAgent(ctx context.Context, id string) error {
	if !common.ValidID(id) {
		return errors.New("invalid Agent ID")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, c.baseURL+"/agents/"+id, nil)
	if err != nil {
		return err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Trigger registration returned HTTP %d", response.StatusCode)
	}
	var result struct {
		Agent struct {
			ID string `json:"agent_id"`
		} `json:"agent"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&result); err != nil {
		return errors.New("invalid Trigger registration response")
	}
	if result.Agent.ID != id {
		return errors.New("Trigger registration returned a different Agent ID")
	}
	return nil
}
