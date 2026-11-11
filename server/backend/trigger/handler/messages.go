package handler

import (
	"net/http"

	"starrychat/backend/trigger/model"
)

func (h *Handler) receiveMessage(w http.ResponseWriter, r *http.Request) {
	var message model.Message
	if !decodeJSON(w, r, &message) {
		return
	}
	result, err := h.service.ReceiveMessage(r.Context(), message)
	if err != nil {
		writeError(w, err)
		return
	}
	status := http.StatusOK
	if len(result.QueuedAgentIDs) > 0 {
		status = http.StatusAccepted
	}
	writeJSON(w, status, MessageResponse{MessageResult: result})
}
