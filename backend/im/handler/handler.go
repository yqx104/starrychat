package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
)

type requestInput struct {
	request *http.Request
	caller  RequestContext
	params  []string
	query   url.Values
}

type operation struct {
	query []string
	run   func(requestInput) (any, int, error)
}

type route struct {
	path    *regexp.Regexp
	allow   string
	methods map[string]operation
}

type Handler struct {
	service Service
	routes  []route
}

// New requires a service implementation; it does not start an HTTP listener.
func New(service Service) *Handler {
	h := &Handler{service: service}
	h.routes = []route{
		{regexp.MustCompile(`^/participants/?$`), "GET", map[string]operation{
			"GET": {[]string{"kind"}, h.listParticipants},
		}},
		{regexp.MustCompile(`^/conversations/?$`), "GET, POST", map[string]operation{
			"GET": {nil, h.listConversations}, "POST": {nil, h.createGroup},
		}},
		{regexp.MustCompile(`^/conversations/direct/?$`), "POST", map[string]operation{
			"POST": {nil, h.openDirect},
		}},
		{regexp.MustCompile(`^/conversations/([^/]+)/?$`), "GET, PATCH", map[string]operation{
			"GET": {nil, h.getConversation}, "PATCH": {nil, h.renameGroup},
		}},
		{regexp.MustCompile(`^/conversations/([^/]+)/dissolve/?$`), "POST", map[string]operation{
			"POST": {nil, h.dissolveGroup},
		}},
		{regexp.MustCompile(`^/conversations/([^/]+)/members/?$`), "GET, POST", map[string]operation{
			"GET": {nil, h.listMembers}, "POST": {nil, h.addMember},
		}},
		{regexp.MustCompile(`^/conversations/([^/]+)/members/([^/]+)/?$`), "DELETE", map[string]operation{
			"DELETE": {nil, h.removeMember},
		}},
		{regexp.MustCompile(`^/conversations/([^/]+)/messages/?$`), "GET, POST", map[string]operation{
			"GET":  {[]string{"limit", "before_seq", "after_seq"}, h.listMessages},
			"POST": {nil, h.sendMessage},
		}},
	}
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	for _, route := range h.routes {
		match := route.path.FindStringSubmatch(r.URL.EscapedPath())
		if match == nil {
			continue
		}
		operation, ok := route.methods[r.Method]
		if !ok {
			w.Header().Set("Allow", route.allow)
			writeFailure(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed.")
			return
		}
		caller, ok := r.Context().Value(callerKey{}).(RequestContext)
		if !ok || !validID(caller.ParticipantID) {
			writeFailure(w, http.StatusUnauthorized, "UNAUTHORIZED", "Authentication required.")
			return
		}
		if err := r.Context().Err(); err != nil {
			writeError(w, err)
			return
		}
		query, err := queryParameters(r.URL.RawQuery, operation.query)
		if err != nil {
			writeError(w, err)
			return
		}
		result, status, err := operation.run(requestInput{r, caller, match[1:], query})
		if err != nil {
			writeError(w, err)
			return
		}
		if status == http.StatusNoContent {
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(status)
			return
		}
		writeJSON(w, status, result)
		return
	}
	writeFailure(w, http.StatusNotFound, "NOT_FOUND", "Route not found.")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		status = http.StatusInternalServerError
		data = []byte(`{"error":{"code":"INTERNAL_ERROR","message":"Internal server error."}}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func writeFailure(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, ErrorResponse{ErrorDetail{code, message}})
}

func writeError(w http.ResponseWriter, err error) {
	var inputError *httpError
	if errors.As(err, &inputError) && inputError != nil {
		writeFailure(w, inputError.status, inputError.code, inputError.message)
		return
	}
	var serviceError *ServiceError
	if errors.As(err, &serviceError) && serviceError != nil {
		status := map[string]int{"INVALID_REQUEST": 400, "UNAUTHORIZED": 401, "NOT_FOUND": 404, "FORBIDDEN": 403, "CONFLICT": 409, "INVALID_OPERATION": 422}[serviceError.Code]
		if status != 0 {
			writeFailure(w, status, serviceError.Code, serviceError.Message)
			return
		}
	}
	writeFailure(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error.")
}

func nonNil[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}
