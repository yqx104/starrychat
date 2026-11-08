package tests

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"yqx-team/backend/im/auth"
	"yqx-team/backend/im/handler"
	"yqx-team/backend/im/model"
	"yqx-team/backend/im/repository"
	"yqx-team/backend/im/service"
)

const testPassword = "only-isolated-tests-123"

type authFixture struct {
	*imFixture
	api    *handler.API
	tokens *auth.Tokens
	clock  *atomic.Int64
}

type loginResult struct {
	Participant model.Participant `json:"participant"`
	Token       string            `json:"token"`
	ExpiresAt   int64             `json:"expires_at"`
}

type authRequest struct {
	bearer, cookie, origin, host string
	secure                       bool
	headers                      http.Header
}

func newAuthFixture(t *testing.T, instance *mysqlInstance) *authFixture {
	t.Helper()
	f := &authFixture{imFixture: newIMFixture(t, instance)}
	f.exec(t, "DELETE FROM participant_accounts")
	f.exec(t, "DELETE FROM participants")
	f.tokens, f.clock, _ = testTokens(t)
	s := service.New(f.store)
	f.api = handler.NewAPI(s, s, f.tokens, handler.APIOptions{InsecureLocalHTTP: true})
	return f
}

func (f *authFixture) call(method, path string, body any, options ...authRequest) *httptest.ResponseRecorder {
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	opt := authRequest{}
	if len(options) > 0 {
		opt = options[0]
	}
	host := opt.host
	if host == "" {
		host = "localhost:4180"
	}
	r := httptest.NewRequest(method, "http://"+host+path, bytes.NewReader(data))
	if opt.secure {
		r.TLS = &tls.ConnectionState{}
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if opt.bearer != "" {
		r.Header.Set("Authorization", "Bearer "+opt.bearer)
	}
	if opt.cookie != "" {
		r.AddCookie(&http.Cookie{Name: handler.TokenCookie, Value: opt.cookie})
	}
	if opt.origin != "" {
		r.Header.Set("Origin", opt.origin)
	}
	for key, values := range opt.headers {
		r.Header[key] = values
	}
	w := httptest.NewRecorder()
	f.api.ServeHTTP(w, r)
	return w
}

func registration(username, kind string) map[string]any {
	return map[string]any{"username": username, "password": testPassword, "name": "Test " + username, "kind": kind}
}
func loginBody(username, transport string) map[string]any {
	return map[string]any{"username": username, "password": testPassword, "transport": transport}
}

func (f *authFixture) humanLogin(t *testing.T) loginResult {
	t.Helper()
	responseValue[map[string]any](t, f.call("POST", "/auth/register", registration("owner", "human")), 201)
	return responseValue[loginResult](t, f.call("POST", "/auth/login", loginBody("owner", "bearer")), 200)
}

func noRenewal(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if w.Header().Get("X-IM-Token") != "" || w.Header().Get("Set-Cookie") != "" {
		t.Fatal("unexpected token renewal")
	}
}

func TestMySQLAuthentication(t *testing.T) {
	instance := startMySQL(t)
	t.Run("registration_is_atomic_and_never_exposes_credentials", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		w := f.call("POST", "/auth/register", registration("owner", "human"))
		created := responseValue[struct {
			Participant model.Participant `json:"participant"`
		}](t, w, 201).Participant
		noRenewal(t, w)
		for _, secret := range []string{testPassword, "password", "username", "token"} {
			if strings.Contains(w.Body.String(), secret) {
				t.Fatal("registration leaked credentials")
			}
		}
		account, err := f.store.GetAccountByUsername(t.Context(), "owner")
		if err != nil {
			t.Fatal(err)
		}
		if account.Password != testPassword {
			t.Fatal("stored password differs from registration input")
		}
		equalValue(t, account.ParticipantID, created.ParticipantID)
		assertError(t, f.call("POST", "/auth/register", registration("owner", "human")), 409, "CONFLICT")
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM participants"), int64(1))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM participant_accounts"), int64(1))
		owner := responseValue[loginResult](t, f.call("POST", "/auth/login", loginBody("owner", "bearer")), 200)
		assertError(t, f.call("POST", "/auth/register", registration("owner", "agent"), authRequest{bearer: owner.Token}), 409, "CONFLICT")
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM participants"), int64(1))
		input := registration("agent", "agent")
		input["participant_id"] = created.ParticipantID
		assertError(t, f.call("POST", "/auth/register", input, authRequest{bearer: owner.Token}), 400, "INVALID_REQUEST")
	})
	t.Run("agents_require_human_and_registration_keeps_callers_identity", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		owner := f.humanLogin(t)
		assertError(t, f.call("POST", "/auth/register", registration("alpha", "agent")), 401, "UNAUTHORIZED")
		w := f.call("POST", "/auth/register", registration("alpha", "agent"), authRequest{cookie: owner.Token, origin: "http://localhost:4180"})
		agent := responseValue[struct {
			Participant model.Participant `json:"participant"`
		}](t, w, 201).Participant
		cookies := w.Result().Cookies()
		if len(cookies) != 1 {
			t.Fatal("authenticated human was not renewed")
		}
		id, err := f.tokens.Verify(cookies[0].Value)
		if err != nil || id != owner.Participant.ParticipantID || id == agent.ParticipantID {
			t.Fatal("registration switched identity")
		}
		logged := responseValue[loginResult](t, f.call("POST", "/auth/login", loginBody("alpha", "bearer")), 200)
		equalValue(t, logged.Participant, agent)
		assertError(t, f.call("POST", "/auth/register", registration("nested", "agent"), authRequest{bearer: logged.Token}), 403, "FORBIDDEN")
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM participants"), int64(2))
	})
	t.Run("login_failure_does_not_renew_old_credentials", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		owner := f.humanLogin(t)
		for _, username := range []string{"owner", "unknown"} {
			body := loginBody(username, "bearer")
			body["password"] = "wrong-password"
			w := f.call("POST", "/auth/login", body, authRequest{bearer: owner.Token, cookie: owner.Token})
			assertError(t, w, 401, "UNAUTHORIZED")
			noRenewal(t, w)
			if !strings.Contains(w.Body.String(), "Invalid username or password.") {
				t.Fatal("credentials disclosed")
			}
		}
		// Explicit login uses only the submitted credentials, even with stale headers.
		responseValue[loginResult](t, f.call("POST", "/auth/login", loginBody("owner", "bearer"), authRequest{bearer: "stale", cookie: "stale"}), 200)
	})
	t.Run("cookie_and_bearer_contract_and_rolling_expiry", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		owner := f.humanLogin(t)
		w := f.call("POST", "/auth/login", loginBody("owner", "cookie"), authRequest{origin: "http://localhost:4180"})
		result := responseValue[loginResult](t, w, 200)
		if result.Token != "" || strings.Contains(w.Body.String(), "\"token\"") {
			t.Fatal("cookie token exposed to JavaScript")
		}
		cookies := w.Result().Cookies()
		if len(cookies) != 1 {
			t.Fatal("cookie absent")
		}
		cookie := cookies[0]
		if cookie.Name != "im_token" || !cookie.HttpOnly || cookie.Secure || cookie.Path != "/" || cookie.SameSite != http.SameSiteStrictMode || cookie.MaxAge != 604800 {
			t.Fatal("incorrect cookie attributes")
		}
		equalValue(t, cookie.Expires.UnixMilli(), result.ExpiresAt)
		f.clock.Add(604799)
		w = f.call("GET", "/auth/me", nil, authRequest{cookie: cookie.Value})
		me := responseValue[struct {
			Participant model.Participant `json:"participant"`
		}](t, w, 200)
		equalValue(t, me.Participant, owner.Participant)
		renewed := w.Result().Cookies()[0]
		equalValue(t, renewed.Expires.Unix(), f.clock.Load()+604800)
		if renewed.Value == cookie.Value {
			t.Fatal("cookie token was not replaced")
		}
		w = f.call("GET", "/participants", nil, authRequest{bearer: owner.Token})
		responseValue[handler.ParticipantsResponse](t, w, 200)
		newBearer := w.Header().Get("X-IM-Token")
		if newBearer == "" || newBearer == owner.Token || w.Header().Get("X-IM-Token-Expires-At") != fmt.Sprint((f.clock.Load()+604800)*1000) {
			t.Fatal("bearer renewal missing")
		}
		f.clock.Add(1)
		for _, request := range []authRequest{{cookie: cookie.Value}, {bearer: owner.Token}} {
			w = f.call("GET", "/auth/me", nil, request)
			assertError(t, w, 401, "UNAUTHORIZED")
			noRenewal(t, w)
		}
		responseValue[map[string]any](t, f.call("GET", "/auth/me", nil, authRequest{cookie: renewed.Value}), 200)
		responseValue[map[string]any](t, f.call("GET", "/auth/me", nil, authRequest{bearer: newBearer}), 200)
	})
	t.Run("logout_clears_only_client_token_and_does_not_renew", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		owner := f.humanLogin(t)
		w := f.call("POST", "/auth/logout", nil, authRequest{cookie: owner.Token, origin: "http://localhost:4180"})
		responseValue[any](t, w, 204)
		cookies := w.Result().Cookies()
		if len(cookies) != 1 || cookies[0].MaxAge != -1 || cookies[0].Value != "" || !cookies[0].HttpOnly {
			t.Fatal("logout did not clear cookie")
		}
		if w.Header().Get("X-IM-Token") != "" {
			t.Fatal("logout renewed token")
		}
		responseValue[map[string]any](t, f.call("GET", "/auth/me", nil, authRequest{bearer: owner.Token}), 200)
		responseValue[any](t, f.call("POST", "/auth/logout", nil, authRequest{bearer: "expired"}), 204)
	})
	t.Run("unauthenticated_dual_and_ambiguous_credentials_rejected", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		owner := f.humanLogin(t)
		for _, path := range []string{"/auth/me", "/participants", "/conversations", "/conversations/1/messages"} {
			w := f.call("GET", path, nil)
			assertError(t, w, 401, "UNAUTHORIZED")
			noRenewal(t, w)
		}
		for _, req := range []authRequest{
			{bearer: owner.Token, cookie: owner.Token},
			{headers: http.Header{"Authorization": []string{"Bearer " + owner.Token, "Bearer " + owner.Token}}},
			{headers: http.Header{"Cookie": []string{"im_token=" + owner.Token + "; im_token=" + owner.Token}}},
			{headers: http.Header{"Authorization": []string{"Basic " + owner.Token}}},
			{bearer: "invalid"},
		} {
			w := f.call("GET", "/auth/me", nil, req)
			assertError(t, w, 401, "UNAUTHORIZED")
			noRenewal(t, w)
		}
		raw, _, err := f.tokens.Issue(model.MaxID)
		if err != nil {
			t.Fatal(err)
		}
		w := f.call("GET", "/auth/me", nil, authRequest{bearer: raw})
		assertError(t, w, 401, "UNAUTHORIZED")
		noRenewal(t, w)
	})
	t.Run("origin_checks_ignore_forwarded_headers_and_https_uses_secure_cookie", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		owner := f.humanLogin(t)
		for _, req := range []authRequest{
			{origin: "http://attacker.example"}, {origin: "null"},
			{origin: "http://attacker.example", headers: http.Header{"X-Forwarded-Host": []string{"attacker.example"}}},
			{origin: "https://localhost:4180", headers: http.Header{"X-Forwarded-Proto": []string{"https"}}},
			{headers: http.Header{"Sec-Fetch-Site": []string{"cross-site"}}},
		} {
			w := f.call("POST", "/auth/login", loginBody("owner", "cookie"), req)
			assertError(t, w, 403, "FORBIDDEN")
			noRenewal(t, w)
		}
		assertError(t, f.call("POST", "/conversations", map[string]any{"title": "No origin", "agent_ids": []int64{}}, authRequest{cookie: owner.Token}), 403, "FORBIDDEN")
		w := f.call("POST", "/auth/login", loginBody("owner", "cookie"), authRequest{secure: true, host: "im.example", origin: "https://im.example"})
		responseValue[loginResult](t, w, 200)
		if !w.Result().Cookies()[0].Secure {
			t.Fatal("HTTPS cookie missing Secure")
		}
		assertError(t, f.call("POST", "/auth/login", loginBody("owner", "cookie"), authRequest{host: "im.example"}), 400, "INVALID_REQUEST")
	})
	t.Run("credential_validation_no_cache_and_repeated_login_requests", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		for _, change := range []map[string]any{{"username": "x"}, {"username": "bad name"}, {"password": "short"}, {"password": strings.Repeat("x", 73)}, {"kind": "admin"}, {"name": strings.Repeat("人", 101)}, {"unknown": true}} {
			body := registration("owner", "human")
			for k, v := range change {
				body[k] = v
			}
			w := f.call("POST", "/auth/register", body)
			assertError(t, w, 400, "INVALID_REQUEST")
			noRenewal(t, w)
		}
		for i := 0; i < 31; i++ {
			w := f.call("POST", "/auth/login", map[string]any{"username": "x"})
			assertError(t, w, 400, "INVALID_REQUEST")
			noRenewal(t, w)
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("login response must not be cached")
			}
		}
		responseValue[map[string]any](t, f.call("POST", "/auth/register", registration("owner", "human")), 201)
	})
	t.Run("parallel_logins_all_succeed", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		owner := f.humanLogin(t)
		responses := parallelResponses(t, 8, func(_ context.Context, _ int) *httptest.ResponseRecorder {
			return f.call("POST", "/auth/login", loginBody("owner", "bearer"))
		})
		for _, response := range responses {
			equalValue(t, responseValue[loginResult](t, response, 200).Participant, owner.Participant)
		}
	})
	t.Run("concurrent_registration_across_pools_is_atomic", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		other, err := repository.Open(t.Context(), f.dsn)
		if err != nil {
			t.Fatal(err)
		}
		defer other.Close()
		services := []*service.Service{service.New(f.store), service.New(other)}
		var workers sync.WaitGroup
		results := make(chan error, 2)
		start := make(chan struct{})
		for _, s := range services {
			workers.Go(func() {
				<-start
				_, err := s.Register(t.Context(), model.RequestContext{}, model.RegisterInput{Username: "same-human", Password: testPassword, Name: "Human", Kind: model.Human})
				results <- err
			})
		}
		close(start)
		workers.Wait()
		close(results)
		success := 0
		for err := range results {
			if err == nil {
				success++
			} else if e, ok := err.(*model.ServiceError); !ok || e.Code != "CONFLICT" {
				t.Fatal(err)
			}
		}
		equalValue(t, success, 1)
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM participants"), int64(1))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM participant_accounts"), int64(1))
	})
	t.Run("existing_human_requires_explicit_local_binding", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		p, err := f.store.InsertParticipant(t.Context(), model.Human, "Existing", 1700000000000)
		if err != nil {
			t.Fatal(err)
		}
		attempt := registration("owner", "human")
		attempt["participant_id"] = p.ParticipantID
		assertError(t, f.call("POST", "/auth/register", attempt), 400, "INVALID_REQUEST")
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM participant_accounts"), int64(0))
		bound, err := service.New(f.store).BindHumanAccount(t.Context(), p.ParticipantID, "owner", testPassword)
		if err != nil {
			t.Fatal(err)
		}
		equalValue(t, bound, p)
		if _, err := service.New(f.store).BindHumanAccount(t.Context(), p.ParticipantID, "other", testPassword); err == nil {
			t.Fatal("account rebound")
		}
		logged := responseValue[loginResult](t, f.call("POST", "/auth/login", loginBody("owner", "bearer")), 200)
		equalValue(t, logged.Participant, p)
	})
	t.Run("authenticated_parallel_business_requests_keep_identity_and_commit", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		owner := f.humanLogin(t)
		responseValue[map[string]any](t, f.call("POST", "/auth/register", registration("alpha", "agent"), authRequest{bearer: owner.Token}), 201)
		agent := responseValue[loginResult](t, f.call("POST", "/auth/login", loginBody("alpha", "bearer")), 200)
		group := responseValue[handler.ConversationResponse](t, f.call("POST", "/conversations", map[string]any{"title": "Authenticated", "agent_ids": []int64{agent.Participant.ParticipantID}}, authRequest{bearer: owner.Token}), 201).Conversation
		responses := parallelResponses(t, 32, func(_ context.Context, i int) *httptest.ResponseRecorder {
			token := owner.Token
			if i%2 == 1 {
				token = agent.Token
			}
			return f.call("POST", fmt.Sprintf("/conversations/%d/messages", group.ConversationID), map[string]any{"content": fmt.Sprint(i)}, authRequest{bearer: token})
		})
		for i, w := range responses {
			m := responseValue[handler.MessageResponse](t, w, 201).Message
			expected := owner.Participant.ParticipantID
			if i%2 == 1 {
				expected = agent.Participant.ParticipantID
			}
			equalValue(t, m.SenderID, expected)
			id, err := f.tokens.Verify(w.Header().Get("X-IM-Token"))
			if err != nil || id != expected {
				t.Fatal("renewed wrong identity")
			}
		}
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM messages"), int64(32))
	})
}
