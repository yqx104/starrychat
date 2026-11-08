package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"yqx-team/backend/trigger/model"
)

type Handler struct {
	service Service
	mux     *http.ServeMux
}

// New serves the internal API called by the co-located IM service.
func New(service Service) *Handler {
	h := &Handler{service: service, mux: http.NewServeMux()}
	h.mux.HandleFunc("GET /healthz", h.health)
	h.mux.HandleFunc("PUT /agents/{agent_id}", h.registerAgent)
	h.mux.HandleFunc("POST /channels/subscriptions", h.subscribe)
	h.mux.HandleFunc("DELETE /channels/{channel_type}/{conversation_id}/agents/{agent_id}", h.unsubscribe)
	h.mux.HandleFunc("DELETE /channels/{channel_type}/{conversation_id}", h.clearChannel)
	h.mux.HandleFunc("POST /messages", h.receiveMessage)
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mux.ServeHTTP(w, r)
}

func (h *Handler) health(w http.ResponseWriter, r *http.Request) {
	if err := h.service.Health(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, ErrorResponse{ErrorDetail{
			Code: "DATABASE_UNAVAILABLE", Message: "Database is unavailable.",
		}})
		return
	}
	writeJSON(w, http.StatusOK, HealthResponse{Status: "ok"})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	if err := json.NewDecoder(r.Body).Decode(value); err != nil {
		writeJSON(w, http.StatusBadRequest, ErrorResponse{ErrorDetail{Code: "INVALID_REQUEST", Message: "Invalid JSON body."}})
		return false
	}
	return true
}

func errorDetail(err error) (int, ErrorDetail) {
	var business *model.ServiceError
	if errors.As(err, &business) {
		status := map[string]int{
			"INVALID_REQUEST":      http.StatusBadRequest,
			"NOT_FOUND":            http.StatusNotFound,
			"DELIVERY_UNAVAILABLE": http.StatusServiceUnavailable,
			"DELIVERY_FAILED":      http.StatusBadGateway,
		}[business.Code]
		if status != 0 {
			return status, ErrorDetail{Code: business.Code, Message: business.Message}
		}
	}
	return http.StatusInternalServerError, ErrorDetail{Code: "INTERNAL_ERROR", Message: "Internal server error."}
}

func writeError(w http.ResponseWriter, err error) {
	status, detail := errorDetail(err)
	writeJSON(w, status, ErrorResponse{Error: detail})
}

func writeNoContent(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
