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
		status, detail := errorDetail(err)
		if detail.Code == "DELIVERY_UNAVAILABLE" || detail.Code == "DELIVERY_FAILED" {
			writeJSON(w, status, MessageResponse{MessageResult: result, Error: &detail})
		} else {
			writeError(w, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, MessageResponse{MessageResult: result})
}
