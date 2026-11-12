package imclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"starrychat/backend/trigger/common"
)

var (
	ErrUnauthorized = errors.New("IM rejected the credential")
	ErrForbidden    = errors.New("IM identity is not a valid Agent")
)

type Identity struct {
	AgentID   string
	Token     string
	ExpiresAt int64
}

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

// Authenticate validates an Agent's Bearer credential and returns IM's renewed credential.
func (c *Client) Authenticate(ctx context.Context, token string) (Identity, error) {
	var who Identity
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/auth/me", nil)
	if err != nil {
		return who, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := c.http.Do(request)
	if err != nil {
		return who, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return who, ErrUnauthorized
	}
	if response.StatusCode != http.StatusOK {
		return who, fmt.Errorf("IM authentication returned HTTP %d", response.StatusCode)
	}
	var body struct {
		Participant struct {
			ID   string `json:"participant_id"`
			Kind string `json:"kind"`
		} `json:"participant"`
	}
	if json.NewDecoder(response.Body).Decode(&body) != nil {
		return who, errors.New("invalid IM identity response")
	}
	if body.Participant.Kind != "agent" || !common.ValidID(body.Participant.ID) {
		return who, ErrForbidden
	}
	expires, err := strconv.ParseInt(response.Header.Get("X-IM-Token-Expires-At"), 10, 64)
	renewedToken := response.Header.Get("X-IM-Token")
	if err != nil || expires <= time.Now().UnixMilli() || renewedToken == "" {
		return who, errors.New("invalid IM renewed credential")
	}
	return Identity{AgentID: body.Participant.ID, Token: renewedToken, ExpiresAt: expires}, nil
}
