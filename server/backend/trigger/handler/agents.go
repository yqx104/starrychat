package handler

import "net/http"

func (h *Handler) registerAgent(w http.ResponseWriter, r *http.Request) {
	agent, err := h.service.RegisterAgent(r.Context(), r.PathValue("agent_id"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, AgentResponse{Agent: agent})
}
