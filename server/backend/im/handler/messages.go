package handler

import "strings"

func (h *Handler) listMessages(in requestInput) (any, int, error) {
	id, err := pathID(in.params[0], "conversation_id")
	if err != nil {
		return nil, 0, err
	}
	query, err := messageQuery(id, in.query)
	if err != nil {
		return nil, 0, err
	}
	page, err := h.service.ListMessages(in.request.Context(), in.caller, query)
	// Normalize nil arrays without changing service-owned slices or message order.
	messages := make([]Message, len(page.Messages))
	for index, message := range page.Messages {
		message.MentionedAgentIDs = nonNil(message.MentionedAgentIDs)
		messages[index] = message
	}
	return MessagePage{Messages: messages, HasMore: page.HasMore}, 200, err
}

func (h *Handler) sendMessage(in requestInput) (any, int, error) {
	id, err := pathID(in.params[0], "conversation_id")
	if err != nil {
		return nil, 0, err
	}
	body, err := bodyObject(in.request, []string{"content", "mentioned_agent_ids", "quoted_message_id"}, false)
	if err != nil {
		return nil, 0, err
	}
	content, err := bodyText(body["content"], "content")
	if err != nil {
		return nil, 0, err
	}
	mentions := []string{}
	if raw, exists := body["mentioned_agent_ids"]; exists {
		mentions, err = bodyIDs(raw, "mentioned_agent_ids")
		if err != nil {
			return nil, 0, err
		}
	}
	var quotedMessageID *string
	if raw, exists := body["quoted_message_id"]; exists && strings.TrimSpace(string(raw)) != "null" {
		id, err := bodyID(raw, "quoted_message_id")
		if err != nil {
			return nil, 0, err
		}
		quotedMessageID = &id
	}
	message, err := h.service.SendMessage(in.request.Context(), in.caller, SendMessageInput{
		ConversationID: id, Content: content, MentionedAgentIDs: mentions, QuotedMessageID: quotedMessageID,
	})
	message.MentionedAgentIDs = nonNil(message.MentionedAgentIDs)
	return MessageResponse{message}, 201, err
}
