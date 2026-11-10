package handler

import (
	"net/http"
	"strings"
	"starrychat/backend/im/model"
)

func (a *API) agents(w http.ResponseWriter, r *http.Request, caller RequestContext) {
	path := strings.TrimSuffix(r.URL.EscapedPath(), "/")
	collection := path == "/agents"
	var id string
	if !collection {
		value, ok := strings.CutPrefix(path, "/agents/")
		if !ok || strings.Contains(value, "/") {
			writeFailure(w, 404, "NOT_FOUND", "Route not found.")
			return
		}
		var err error
		id, err = pathID(value, "participant_id")
		if err != nil {
			writeError(w, err)
			return
		}
	}
	if (collection && r.Method != "GET" && r.Method != "POST") || (!collection && r.Method != "PATCH") {
		allow := "PATCH"
		if collection {
			allow = "GET, POST"
		}
		w.Header().Set("Allow", allow)
		writeFailure(w, 405, "METHOD_NOT_ALLOWED", "Method not allowed.")
		return
	}
	if _, err := queryParameters(r.URL.RawQuery, nil); err != nil {
		writeError(w, err)
		return
	}
	if r.Method == "GET" {
		agents, err := a.accounts.ListAgents(r.Context(), caller)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"agents": nonNil(agents)})
		return
	}
	body, err := bodyObject(r, []string{"name", "username", "password"}, false)
	if err != nil {
		writeError(w, err)
		return
	}
	if len(body) == 0 {
		writeError(w, invalid("At least one account field is required."))
		return
	}
	values := map[string]*string{}
	for _, key := range []string{"name", "username", "password"} {
		if _, present := body[key]; !present && r.Method == "PATCH" {
			continue
		}
		value, err := bodyText(body[key], key)
		if err != nil {
			writeError(w, err)
			return
		}
		values[key] = &value
	}
	if r.Method == "POST" {
		agent, err := a.accounts.CreateAgent(r.Context(), caller, model.CreateAgentInput{Name: *values["name"], Username: *values["username"], Password: *values["password"]})
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, 201, map[string]any{"agent": agent})
		return
	}
	agent, err := a.accounts.UpdateAgent(r.Context(), caller, model.UpdateAgentInput{ParticipantID: id, Name: values["name"], Username: values["username"], Password: values["password"]})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"agent": agent})
}
