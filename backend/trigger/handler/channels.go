package handler

import (
	"net/http"

	"yqx-team/backend/trigger/model"
)

func (h *Handler) subscribe(w http.ResponseWriter, r *http.Request) {
	var input model.SubscribeInput
	if !decodeJSON(w, r, &input) {
		return
	}
	result, err := h.service.Subscribe(r.Context(), input)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func sourceFromPath(r *http.Request) model.Source {
	return model.Source{ChannelType: model.ChannelType(r.PathValue("channel_type")), ConversationID: r.PathValue("conversation_id")}
}

func (h *Handler) unsubscribe(w http.ResponseWriter, r *http.Request) {
	if err := h.service.Unsubscribe(r.Context(), sourceFromPath(r), r.PathValue("agent_id")); err != nil {
		writeError(w, err)
		return
	}
	writeNoContent(w)
}

func (h *Handler) clearChannel(w http.ResponseWriter, r *http.Request) {
	if err := h.service.ClearChannel(r.Context(), sourceFromPath(r)); err != nil {
		writeError(w, err)
		return
	}
	writeNoContent(w)
}
