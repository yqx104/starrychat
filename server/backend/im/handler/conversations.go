package handler

import "encoding/json"

func (h *Handler) listConversations(in requestInput) (any, int, error) {
	conversations, err := h.service.ListConversations(in.request.Context(), in.caller)
	return ConversationsResponse{nonNil(conversations)}, 200, err
}

func (h *Handler) createGroup(in requestInput) (any, int, error) {
	body, err := bodyObject(in.request, []string{"title", "agent_ids"}, false)
	if err != nil {
		return nil, 0, err
	}
	title, err := bodyText(body["title"], "title")
	if err != nil {
		return nil, 0, err
	}
	agentIDs, err := bodyIDs(body["agent_ids"], "agent_ids")
	if err != nil {
		return nil, 0, err
	}
	conversation, err := h.service.CreateGroup(in.request.Context(), in.caller, CreateGroupInput{Title: title, AgentIDs: agentIDs})
	return ConversationResponse{conversation}, 201, err
}

func (h *Handler) openDirect(in requestInput) (any, int, error) {
	body, err := bodyObject(in.request, []string{"agent_id"}, false)
	if err != nil {
		return nil, 0, err
	}
	agentID, err := bodyID(body["agent_id"], "agent_id")
	if err != nil {
		return nil, 0, err
	}
	conversation, err := h.service.OpenDirect(in.request.Context(), in.caller, OpenDirectInput{AgentID: agentID})
	return ConversationResponse{conversation}, 200, err
}

func (h *Handler) getConversation(in requestInput) (any, int, error) {
	id, err := pathID(in.params[0], "conversation_id")
	if err != nil {
		return nil, 0, err
	}
	conversation, err := h.service.GetConversation(in.request.Context(), in.caller, id)
	return ConversationResponse{conversation}, 200, err
}

func (h *Handler) setConversationVisibility(in requestInput) (any, int, error) {
	id, err := pathID(in.params[0], "conversation_id")
	if err != nil {
		return nil, 0, err
	}
	body, err := bodyObject(in.request, []string{"hidden"}, false)
	if err != nil {
		return nil, 0, err
	}
	var hidden *bool
	if err := json.Unmarshal(body["hidden"], &hidden); err != nil || hidden == nil {
		return nil, 0, invalid("hidden must be a boolean.")
	}
	conversation, err := h.service.SetConversationVisibility(in.request.Context(), in.caller, SetConversationVisibilityInput{ConversationID: id, Hidden: *hidden})
	return ConversationResponse{conversation}, 200, err
}

func (h *Handler) renameGroup(in requestInput) (any, int, error) {
	id, err := pathID(in.params[0], "conversation_id")
	if err != nil {
		return nil, 0, err
	}
	body, err := bodyObject(in.request, []string{"title"}, false)
	if err != nil {
		return nil, 0, err
	}
	title, err := bodyText(body["title"], "title")
	if err != nil {
		return nil, 0, err
	}
	conversation, err := h.service.RenameGroup(in.request.Context(), in.caller, RenameGroupInput{ConversationID: id, Title: title})
	return ConversationResponse{conversation}, 200, err
}

func (h *Handler) dissolveGroup(in requestInput) (any, int, error) {
	id, err := pathID(in.params[0], "conversation_id")
	if err != nil {
		return nil, 0, err
	}
	if _, err := bodyObject(in.request, nil, true); err != nil {
		return nil, 0, err
	}
	conversation, err := h.service.DissolveGroup(in.request.Context(), in.caller, id)
	return ConversationResponse{conversation}, 200, err
}
