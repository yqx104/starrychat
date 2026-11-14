package handler

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"starrychat/backend/im/common/auth"
	"starrychat/backend/im/model"
)

const TokenCookie = "im_token"

type AuthService interface {
	Register(context.Context, model.RegisterInput) (model.Participant, error)
	Login(context.Context, string, string) (model.Participant, error)
	AuthenticatedParticipant(context.Context, string) (model.Participant, error)
	ListAgents(context.Context, model.RequestContext) ([]model.AgentAccount, error)
	CreateAgent(context.Context, model.RequestContext, model.CreateAgentInput) (model.CreateAgentResult, error)
	UpdateAgent(context.Context, model.RequestContext, model.UpdateAgentInput) (model.AgentAccount, error)
}

type APIOptions struct {
	// Only for HTTP on loopback. HTTPS always uses Secure cookies.
	InsecureLocalHTTP bool
}

type API struct {
	chat     *Handler
	accounts AuthService
	tokens   *auth.Tokens
	options  APIOptions
}

func NewAPI(chat Service, accounts AuthService, tokens *auth.Tokens, options APIOptions) *API {
	return &API{chat: New(chat), accounts: accounts, tokens: tokens, options: options}
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !sameOrigin(r) {
		writeFailure(w, 403, "FORBIDDEN", "A same-origin request is required.")
		return
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	if strings.HasPrefix(path, "/auth/") {
		method := map[string]string{"/auth/register": "POST", "/auth/login": "POST", "/auth/me": "GET", "/auth/logout": "POST"}[path]
		if method == "" {
			writeFailure(w, 404, "NOT_FOUND", "Route not found.")
			return
		}
		if r.Method != method {
			w.Header().Set("Allow", method)
			writeFailure(w, 405, "METHOD_NOT_ALLOWED", "Method not allowed.")
			return
		}
		if _, err := queryParameters(r.URL.RawQuery, nil); err != nil {
			writeError(w, err)
			return
		}
	}
	switch path {
	case "/auth/login", "/auth/register":
		if path == "/auth/login" {
			a.login(w, r)
		} else {
			a.register(w, r)
		}
		return
	case "/auth/logout":
		_, transport, err := credentials(r)
		if err != nil {
			writeError(w, err)
			return
		}
		if transport == "cookie" && !cookieMutation(r) {
			writeFailure(w, 403, "FORBIDDEN", "A same-origin request is required.")
			return
		}
		if _, err := bodyObject(r, nil, true); err != nil {
			writeError(w, err)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: TokenCookie, Value: "", Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: a.cookieSecure(r), MaxAge: -1, Expires: time.Unix(1, 0)})
		w.WriteHeader(http.StatusNoContent)
		return
	}
	participant, transport, err := a.authenticate(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if _, _, err := a.renew(w, r, participant.ParticipantID, transport); err != nil {
		writeError(w, err)
		return
	}
	if path == "/auth/me" {
		writeJSON(w, 200, map[string]any{"participant": participant})
		return
	}
	if path == "/agents" || strings.HasPrefix(path, "/agents/") {
		a.agents(w, r, RequestContext{ParticipantID: participant.ParticipantID})
		return
	}
	a.chat.ServeHTTP(w, r.WithContext(WithCaller(r.Context(), RequestContext{ParticipantID: participant.ParticipantID})))
}

func (a *API) register(w http.ResponseWriter, r *http.Request) {
	body, err := bodyObject(r, []string{"username", "password", "name"}, false)
	if err != nil {
		writeError(w, err)
		return
	}
	input := model.RegisterInput{}
	for key, target := range map[string]*string{"username": &input.Username, "password": &input.Password, "name": &input.Name} {
		*target, err = bodyText(body[key], key)
		if err != nil {
			writeError(w, err)
			return
		}
	}
	participant, err := a.accounts.Register(r.Context(), input)
	if err != nil {
		writeError(w, err)
		return
	}
	// Registration never replaces the caller's credential with the new participant's token.
	writeJSON(w, 201, map[string]any{"participant": participant})
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	body, err := bodyObject(r, []string{"username", "password", "transport"}, false)
	if err != nil {
		writeError(w, err)
		return
	}
	fields := map[string]string{}
	for _, key := range []string{"username", "password", "transport"} {
		fields[key], err = bodyText(body[key], key)
		if err != nil {
			writeError(w, err)
			return
		}
	}
	transport := fields["transport"]
	if transport != "cookie" && transport != "bearer" {
		writeError(w, invalid("Transport must be cookie or bearer."))
		return
	}
	if transport == "cookie" && !a.cookieAllowed(r) {
		writeFailure(w, 400, "INVALID_REQUEST", "Cookie login requires HTTPS or explicit local HTTP development mode.")
		return
	}
	participant, err := a.accounts.Login(r.Context(), fields["username"], fields["password"])
	if err != nil {
		writeError(w, err)
		return
	}
	token, expires, err := a.renew(w, r, participant.ParticipantID, transport)
	if err != nil {
		writeError(w, err)
		return
	}
	response := map[string]any{"participant": participant, "expires_at": expires.UnixMilli()}
	if transport == "bearer" {
		response["token"] = token
	}
	writeJSON(w, 200, response)
}

func credentials(r *http.Request) (string, string, error) {
	unauthorized := &httpError{401, "UNAUTHORIZED", "Authentication required."}
	headers := r.Header.Values("Authorization")
	cookies := r.CookiesNamed(TokenCookie)
	if len(headers) > 1 || len(cookies) > 1 || (len(headers) != 0 && len(cookies) != 0) {
		return "", "", unauthorized
	}
	if len(headers) == 1 {
		parts := strings.Fields(headers[0])
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			return "", "", unauthorized
		}
		return parts[1], "bearer", nil
	}
	if len(cookies) == 1 {
		return cookies[0].Value, "cookie", nil
	}
	return "", "", nil
}

func (a *API) authenticate(r *http.Request) (model.Participant, string, error) {
	raw, transport, err := credentials(r)
	if err != nil {
		return model.Participant{}, "", err
	}
	id, err := a.tokens.Verify(raw)
	if err != nil {
		return model.Participant{}, "", &httpError{401, "UNAUTHORIZED", "Authentication required."}
	}
	if transport == "cookie" && (!a.cookieAllowed(r) || !cookieMutation(r)) {
		return model.Participant{}, "", &httpError{403, "FORBIDDEN", "A secure same-origin request is required."}
	}
	participant, err := a.accounts.AuthenticatedParticipant(r.Context(), id)
	return participant, transport, err
}

func (a *API) renew(w http.ResponseWriter, r *http.Request, id string, transport string) (string, time.Time, error) {
	token, expires, err := a.tokens.Issue(id)
	if err != nil {
		return "", time.Time{}, err
	}
	if transport == "cookie" {
		http.SetCookie(w, &http.Cookie{Name: TokenCookie, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: a.cookieSecure(r), MaxAge: int(auth.Lifetime.Seconds()), Expires: expires})
	} else {
		w.Header().Set("X-IM-Token", token)
		w.Header().Set("X-IM-Token-Expires-At", strconv.FormatInt(expires.UnixMilli(), 10))
	}
	return token, expires, nil
}

func (a *API) cookieSecure(r *http.Request) bool { return r.TLS != nil || !a.options.InsecureLocalHTTP }
func (a *API) cookieAllowed(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if !a.options.InsecureLocalHTTP {
		return false
	}
	host := r.Host
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	}
	ip := net.ParseIP(host)
	return host == "localhost" || (ip != nil && ip.IsLoopback())
}

func safeMethod(method string) bool {
	return method == "GET" || method == "HEAD" || method == "OPTIONS"
}

func cookieMutation(r *http.Request) bool {
	return safeMethod(r.Method) || r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Site") == "same-origin"
}

// Compare the actual Host/TLS state. Forwarded headers never establish trust.
func sameOrigin(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	origins := r.Header.Values("Origin")
	if len(origins) == 0 {
		return true
	}
	if len(origins) != 1 {
		return false
	}
	origin, err := url.Parse(origins[0])
	if err != nil || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return origin.Scheme == scheme && strings.EqualFold(origin.Host, r.Host)
}
