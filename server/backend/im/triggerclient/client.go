package triggerclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"starrychat/backend/im/common"
	"starrychat/backend/im/model"
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

func validateSource(source model.TriggerSource) error {
	if (source.ChannelType != "im_direct" && source.ChannelType != "im_group") || !common.ValidID(source.ConversationID) {
		return errors.New("invalid Trigger source")
	}
	return nil
}

func (c *Client) request(ctx context.Context, method, path string, input, output any, statuses ...int) error {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return err
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if !slices.Contains(statuses, response.StatusCode) {
		return fmt.Errorf("Trigger %s %s returned HTTP %d", method, path, response.StatusCode)
	}
	if output != nil {
		if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output); err != nil {
			return errors.New("invalid Trigger response")
		}
	}
	return nil
}

func (c *Client) Subscribe(ctx context.Context, input model.TriggerSubscription) error {
	if err := validateSource(input.TriggerSource); err != nil {
		return err
	}
	want := make(map[string]bool, len(input.AgentIDs))
	for _, id := range input.AgentIDs {
		if !common.ValidID(id) {
			return errors.New("invalid Agent ID")
		}
		want[id] = true
	}
	if len(want) == 0 {
		return errors.New("subscription requires at least one Agent")
	}
	var result struct {
		ChannelID string `json:"channel_id"`
		Channels  []struct {
			model.TriggerSource
			AgentID   string `json:"agent_id"`
			ChannelID string `json:"channel_id"`
		} `json:"channels"`
	}
	if err := c.request(ctx, http.MethodPost, "/channels/subscriptions", input, &result, http.StatusOK); err != nil {
		return err
	}
	if !common.ValidID(result.ChannelID) || len(result.Channels) != len(want) {
		return errors.New("invalid Trigger subscription confirmation")
	}
	for _, channel := range result.Channels {
		if !want[channel.AgentID] || channel.TriggerSource != input.TriggerSource || channel.ChannelID != result.ChannelID {
			return errors.New("invalid Trigger subscription confirmation")
		}
		delete(want, channel.AgentID)
	}
	return nil
}

func (c *Client) Unsubscribe(ctx context.Context, source model.TriggerSource, agentID string) error {
	if err := validateSource(source); err != nil {
		return err
	}
	if !common.ValidID(agentID) {
		return errors.New("invalid Agent ID")
	}
	return c.request(ctx, http.MethodDelete, "/channels/"+source.ChannelType+"/"+source.ConversationID+"/agents/"+agentID, nil, nil, http.StatusNoContent)
}

func (c *Client) ClearChannel(ctx context.Context, source model.TriggerSource) error {
	if err := validateSource(source); err != nil {
		return err
	}
	return c.request(ctx, http.MethodDelete, "/channels/"+source.ChannelType+"/"+source.ConversationID, nil, nil, http.StatusNoContent)
}

func (c *Client) SendMessage(ctx context.Context, message model.TriggerMessage) error {
	if err := validateSource(model.TriggerSource{ChannelType: message.ChannelType, ConversationID: message.ConversationID}); err != nil {
		return err
	}
	var result struct {
		ChannelID      string   `json:"channel_id"`
		QueuedAgentIDs []string `json:"queued_agent_ids"`
	}
	if err := c.request(ctx, http.MethodPost, "/messages", message, &result, http.StatusOK, http.StatusAccepted); err != nil {
		return err
	}
	if result.QueuedAgentIDs == nil || (len(result.QueuedAgentIDs) > 0 && !common.ValidID(result.ChannelID)) {
		return errors.New("invalid Trigger message confirmation")
	}
	for _, id := range result.QueuedAgentIDs {
		if !common.ValidID(id) {
			return errors.New("invalid Trigger recipient")
		}
	}
	return nil
}
