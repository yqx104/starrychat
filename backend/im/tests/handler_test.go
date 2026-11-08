package tests

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"yqx-team/backend/im/handler"
)

type serviceCall struct {
	method string
	ctx    context.Context
	caller handler.RequestContext
	input  any
}

type serviceStub struct {
	run func(serviceCall) (any, error)
}

func invoke[T any](s *serviceStub, method string, ctx context.Context, caller handler.RequestContext, input any) (T, error) {
	var zero T
	value, err := s.run(serviceCall{method, ctx, caller, input})
	if err != nil || value == nil {
		return zero, err
	}
	return value.(T), nil
}

func (s *serviceStub) ListParticipants(c context.Context, a handler.RequestContext, q handler.ParticipantsQuery) ([]handler.Participant, error) {
	return invoke[[]handler.Participant](s, "ListParticipants", c, a, q)
}
func (s *serviceStub) ListConversations(c context.Context, a handler.RequestContext) ([]handler.Conversation, error) {
	return invoke[[]handler.Conversation](s, "ListConversations", c, a, nil)
}
func (s *serviceStub) CreateGroup(c context.Context, a handler.RequestContext, i handler.CreateGroupInput) (handler.Conversation, error) {
	return invoke[handler.Conversation](s, "CreateGroup", c, a, i)
}
func (s *serviceStub) OpenDirect(c context.Context, a handler.RequestContext, i handler.OpenDirectInput) (handler.Conversation, error) {
	return invoke[handler.Conversation](s, "OpenDirect", c, a, i)
}
func (s *serviceStub) GetConversation(c context.Context, a handler.RequestContext, id string) (handler.Conversation, error) {
	return invoke[handler.Conversation](s, "GetConversation", c, a, id)
}
func (s *serviceStub) RenameGroup(c context.Context, a handler.RequestContext, i handler.RenameGroupInput) (handler.Conversation, error) {
	return invoke[handler.Conversation](s, "RenameGroup", c, a, i)
}
func (s *serviceStub) DissolveGroup(c context.Context, a handler.RequestContext, id string) (handler.Conversation, error) {
	return invoke[handler.Conversation](s, "DissolveGroup", c, a, id)
}
func (s *serviceStub) ListMembers(c context.Context, a handler.RequestContext, id string) ([]handler.Participant, error) {
	return invoke[[]handler.Participant](s, "ListMembers", c, a, id)
}
func (s *serviceStub) AddMember(c context.Context, a handler.RequestContext, i handler.AddMemberInput) (handler.Participant, error) {
	return invoke[handler.Participant](s, "AddMember", c, a, i)
}
func (s *serviceStub) RemoveMember(c context.Context, a handler.RequestContext, i handler.RemoveMemberInput) error {
	_, err := s.run(serviceCall{"RemoveMember", c, a, i})
	return err
}
func (s *serviceStub) ListMessages(c context.Context, a handler.RequestContext, q handler.MessagePageQuery) (handler.MessagePage, error) {
	return invoke[handler.MessagePage](s, "ListMessages", c, a, q)
}
func (s *serviceStub) SendMessage(c context.Context, a handler.RequestContext, i handler.SendMessageInput) (handler.Message, error) {
	return invoke[handler.Message](s, "SendMessage", c, a, i)
}

var _ handler.Service = (*serviceStub)(nil)

func ptr[T any](value T) *T { return &value }

func newHandler(t *testing.T, run func(serviceCall) (any, error)) *handler.Handler {
	t.Helper()
	return handler.New(&serviceStub{run: run})
}

func request(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, "http://im.local"+path, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	return r.WithContext(handler.WithCaller(r.Context(), handler.RequestContext{ParticipantID: testID(1)}))
}

func serve(h http.Handler, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func assertJSON(t *testing.T, w *httptest.ResponseRecorder, status int, expected any) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status = %d, want %d; body = %s", w.Code, status, w.Body)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("missing no-store header")
	}
	if status == 204 {
		if w.Body.Len() != 0 {
			t.Fatalf("204 response has a body: %s", w.Body)
		}
		return
	}
	if w.Header().Get("Content-Type") != "application/json" {
		t.Fatal("missing JSON content type")
	}
	var actualJSON, expectedJSON any
	if err := json.Unmarshal(w.Body.Bytes(), &actualJSON); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(expected)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &expectedJSON); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actualJSON, expectedJSON) {
		t.Fatalf("JSON = %s, want %s", w.Body, data)
	}
}

func assertError(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var payload handler.ErrorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Error.Code != code || payload.Error.Message == "" {
		t.Fatalf("unexpected error: %s", w.Body)
	}
	assertJSON(t, w, status, payload)
}

func TestRoutes(t *testing.T) {
	agent := handler.Participant{ParticipantID: testID(2), Kind: handler.Agent, Name: "Agent", CreatedAt: 1700000000000}
	group := handler.Conversation{ConversationID: testID(7), Kind: "group", Title: ptr("Team"), CreatedAt: 1700000000010}
	direct := handler.Conversation{ConversationID: testID(8), Kind: "direct", CreatedAt: 1700000000020}
	renamed := handler.Conversation{ConversationID: testID(7), Kind: "group", Title: ptr("Renamed"), CreatedAt: group.CreatedAt}
	dissolved := handler.Conversation{ConversationID: testID(7), Kind: "group", Title: ptr("Team"), CreatedAt: group.CreatedAt, DissolvedAt: ptr(int64(1700000000100))}
	message := handler.Message{MessageID: testID(11), ConversationID: testID(7), SenderID: testID(1), Content: "Hello", QuotedMessageID: ptr(testID(10)), CreatedAt: 1700000000030, MentionedAgentIDs: []string{testID(2), testID(3)}}
	page := handler.MessagePage{Messages: []handler.Message{message}, HasMore: true}
	cases := []struct {
		method, path, body, serviceMethod string
		input, result, response           any
		status                            int
	}{
		{"GET", "/participants?kind=agent", "", "ListParticipants", handler.ParticipantsQuery{Kind: handler.Agent}, []handler.Participant{agent}, handler.ParticipantsResponse{Participants: []handler.Participant{agent}}, 200},
		{"GET", "/conversations", "", "ListConversations", nil, []handler.Conversation{group, direct}, handler.ConversationsResponse{Conversations: []handler.Conversation{group, direct}}, 200},
		{"POST", "/conversations", `{"title":"Team","agent_ids":["00000000-0000-7000-8000-000000000002","00000000-0000-7000-8000-000000000003","00000000-0000-7000-8000-000000000002"]}`, "CreateGroup", handler.CreateGroupInput{Title: "Team", AgentIDs: []string{testID(2), testID(3), testID(2)}}, group, handler.ConversationResponse{Conversation: group}, 201},
		{"POST", "/conversations/direct", `{"agent_id":"00000000-0000-7000-8000-000000000002"}`, "OpenDirect", handler.OpenDirectInput{AgentID: testID(2)}, direct, handler.ConversationResponse{Conversation: direct}, 200},
		{"GET", "/conversations/%30" + testID(7)[1:] + "/", "", "GetConversation", testID(7), group, handler.ConversationResponse{Conversation: group}, 200},
		{"PATCH", "/conversations/00000000-0000-7000-8000-000000000007", `{"title":"Renamed"}`, "RenameGroup", handler.RenameGroupInput{ConversationID: testID(7), Title: "Renamed"}, renamed, handler.ConversationResponse{Conversation: renamed}, 200},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/dissolve", "", "DissolveGroup", testID(7), dissolved, handler.ConversationResponse{Conversation: dissolved}, 200},
		{"GET", "/conversations/00000000-0000-7000-8000-000000000007/members", "", "ListMembers", testID(7), []handler.Participant{agent}, handler.MembersResponse{Members: []handler.Participant{agent}}, 200},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/members", `{"participant_id":"00000000-0000-7000-8000-000000000002"}`, "AddMember", handler.AddMemberInput{ConversationID: testID(7), ParticipantID: testID(2)}, agent, handler.MemberResponse{Member: agent}, 200},
		{"DELETE", "/conversations/00000000-0000-7000-8000-000000000007/members/00000000-0000-7000-8000-000000000002", "", "RemoveMember", handler.RemoveMemberInput{ConversationID: testID(7), ParticipantID: testID(2)}, nil, nil, 204},
		{"GET", "/conversations/00000000-0000-7000-8000-000000000007/messages", "", "ListMessages", handler.MessagePageQuery{ConversationID: testID(7), Limit: 50}, page, page, 200},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":"Hello","mentioned_agent_ids":["00000000-0000-7000-8000-000000000002","00000000-0000-7000-8000-000000000003","00000000-0000-7000-8000-000000000002"],"quoted_message_id":"00000000-0000-7000-8000-00000000000a"}`, "SendMessage", handler.SendMessageInput{ConversationID: testID(7), Content: "Hello", MentionedAgentIDs: []string{testID(2), testID(3), testID(2)}, QuotedMessageID: ptr(testID(10))}, message, handler.MessageResponse{Message: message}, 201},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			r := request(tc.method, tc.path, tc.body)
			calls := 0
			h := newHandler(t, func(call serviceCall) (any, error) {
				calls++
				if call.method != tc.serviceMethod || !reflect.DeepEqual(call.input, tc.input) || call.caller.ParticipantID != testID(1) || call.ctx != r.Context() {
					t.Fatalf("unexpected service call: %+v; want %s %+v", call, tc.serviceMethod, tc.input)
				}
				return tc.result, nil
			})
			assertJSON(t, serve(h, r), tc.status, tc.response)
			if calls != 1 {
				t.Fatalf("service calls = %d, want 1", calls)
			}
		})
	}
}

func TestServiceErrors(t *testing.T) {
	for code, status := range map[string]int{"NOT_FOUND": 404, "FORBIDDEN": 403, "CONFLICT": 409, "INVALID_OPERATION": 422} {
		t.Run(code, func(t *testing.T) {
			h := newHandler(t, func(serviceCall) (any, error) {
				return nil, fmt.Errorf("internal wrapper: %w", &handler.ServiceError{Code: code, Message: "Public business error"})
			})
			assertJSON(t, serve(h, request("GET", "/conversations/00000000-0000-7000-8000-000000000007", "")), status, handler.ErrorResponse{Error: handler.ErrorDetail{Code: code, Message: "Public business error"}})
		})
	}
}

func TestUnknownFailuresDoNotExposeDetails(t *testing.T) {
	for _, failure := range []error{errors.New("service not implemented; internal details"), &handler.ServiceError{Code: "UNKNOWN_CODE", Message: "Internal details"}} {
		h := newHandler(t, func(serviceCall) (any, error) { return nil, failure })
		assertJSON(t, serve(h, request("GET", "/conversations", "")), 500, handler.ErrorResponse{Error: handler.ErrorDetail{Code: "INTERNAL_ERROR", Message: "Internal server error."}})
	}
}

func TestCallerIsRequiredAndNeverInferred(t *testing.T) {
	h := newHandler(t, func(serviceCall) (any, error) { t.Fatal("must not call service"); return nil, nil })
	contexts := []context.Context{context.Background(), context.WithValue(context.Background(), "participant_id", int64(1))}
	for _, id := range []string{"", "1", "00000000-0000-4000-8000-000000000001"} {
		contexts = append(contexts, handler.WithCaller(context.Background(), handler.RequestContext{ParticipantID: id}))
	}
	for _, ctx := range contexts {
		r := request("GET", "/conversations", "").WithContext(ctx)
		r.Header.Set("X-Participant-ID", "1")
		r.Header.Set("Authorization", "Bearer 1")
		assertError(t, serve(h, r), 401, "UNAUTHORIZED")
	}
}

func TestRoutingErrors(t *testing.T) {
	h := newHandler(t, func(serviceCall) (any, error) { t.Fatal("must not call service"); return nil, nil })
	for _, tc := range []struct {
		path, method string
		status       int
		allow        string
	}{
		{"/unknown", "GET", 404, ""}, {"/participants/00000000-0000-7000-8000-000000000002", "DELETE", 404, ""},
		{"/conversations/00000000-0000-7000-8000-000000000007/messages/extra", "GET", 404, ""},
		{"/participants", "POST", 405, "GET"}, {"/participants", "HEAD", 405, "GET"},
		{"/conversations", "DELETE", 405, "GET, POST"}, {"/conversations/direct", "GET", 405, "POST"},
		{"/conversations/00000000-0000-7000-8000-000000000007", "PUT", 405, "GET, PATCH"}, {"/conversations/00000000-0000-7000-8000-000000000007/dissolve", "GET", 405, "POST"},
		{"/conversations/00000000-0000-7000-8000-000000000007/members", "PUT", 405, "GET, POST"}, {"/conversations/00000000-0000-7000-8000-000000000007/members/00000000-0000-7000-8000-000000000002", "GET", 405, "DELETE"},
		{"/conversations/00000000-0000-7000-8000-000000000007/messages", "PUT", 405, "GET, POST"},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			w := serve(h, request(tc.method, tc.path, ""))
			code := "NOT_FOUND"
			if tc.status == 405 {
				code = "METHOD_NOT_ALLOWED"
			}
			assertError(t, w, tc.status, code)
			if w.Header().Get("Allow") != tc.allow {
				t.Fatalf("Allow = %q, want %q", w.Header().Get("Allow"), tc.allow)
			}
		})
	}
}

func TestInvalidInputsNeverReachService(t *testing.T) {
	h := newHandler(t, func(serviceCall) (any, error) { t.Fatal("must not call service"); return nil, nil })
	cases := []struct{ method, path, body string }{
		{"GET", "/participants?kind=bot", ""}, {"GET", "/participants?kind=", ""},
		{"GET", "/participants?kind=agent&kind=human", ""}, {"GET", "/participants?unknown=1", ""},
		{"GET", "/conversations?limit=20", ""},
		{"POST", "/conversations", `{"title":"  ","agent_ids":[]}`},
		{"POST", "/conversations", `{"title":"Team","agent_ids":"2"}`},
		{"POST", "/conversations", `{"title":"Team"}`},
		{"POST", "/conversations", `{"title":"Team","agent_ids":null}`},
		{"POST", "/conversations", `{"title":"Team","agent_ids":["2"]}`},
		{"POST", "/conversations", `{"title":"Team","agent_ids":[],"created_at":123}`},
		{"POST", "/conversations/direct", `{"agent_id":0}`},
		{"POST", "/conversations/direct", `{"agent_id":"2"}`},
		{"POST", "/conversations/direct", `{"agent_id":null}`},
		{"POST", "/conversations/direct", `{"agent_id":9007199254740992}`},
		{"POST", "/conversations/direct", `{"agent_id":1e400}`},
		{"POST", "/conversations/direct", `{}`},
		{"POST", "/conversations/direct", `{"agent_id":"00000000-0000-7000-8000-000000000002","created_at":123}`},
		{"PATCH", "/conversations/00000000-0000-7000-8000-000000000007", `{"title":123}`},
		{"PATCH", "/conversations/00000000-0000-7000-8000-000000000007", `{"title":"Team","created_at":123}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/members", `{"participant_id":-2}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/members", `{"participant_id":"00000000-0000-7000-8000-000000000002","created_at":123}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/dissolve", `{"dissolved_at":123}`},
		{"DELETE", "/conversations/00000000-0000-7000-8000-000000000007/members/00000000-0000-7000-8000-000000000002", `{"force":true}`},
		{"DELETE", "/conversations/00000000-0000-7000-8000-000000000007/members/0", ""},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":"  "}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":"\ufeff\u2003"}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":123}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":null}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"Content":"Hello"}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":"Hello","mentioned_agent_ids":null}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":"Hello","mentioned_agent_ids":{}}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":"Hello","mentioned_agent_ids":["2"]}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":"Hello","mentioned_agent_ids":[0]}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":"Hello","mentioned_agent_ids":[1.5]}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":"Hello","mentioned_agent_ids":[9007199254740992]}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":"Hello","message_id":12}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":"Hello","created_at":123}`},
		{"POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":"Hello","sender_id":2}`},
	}
	for _, id := range []string{"nope", "0", "-1", "1.2", "1e2", "9007199254740992", "%2F", "%2537", "%E0%A4%A0"} {
		cases = append(cases, struct{ method, path, body string }{"GET", "/conversations/" + id, ""})
	}
	for _, query := range []string{
		"limit=0", "limit=51", "limit=-1", "limit=1.5", "limit=1e1", "limit=", "limit=%2531",
		"limit=20&limit=50", "limit=20&%6cimit=50", "before_seq=0", "after_seq=-1",
		"after_seq=9007199254740992", "before_seq=10&after_seq=20",
		"before_seq=&after_seq=20", "before_id=10", "limit=%ZZ",
	} {
		cases = append(cases, struct{ method, path, body string }{"GET", "/conversations/00000000-0000-7000-8000-000000000007/messages?" + query, ""})
	}
	for index, tc := range cases {
		t.Run(fmt.Sprintf("%02d %s %s", index, tc.method, tc.path), func(t *testing.T) {
			assertError(t, serve(h, request(tc.method, tc.path, tc.body)), 400, "INVALID_REQUEST")
		})
	}
	// Go's HTTP parser normally rejects invalid percent escapes before routing.
	r := request("GET", "/conversations/00000000-0000-7000-8000-000000000007", "")
	r.URL = &url.URL{Path: "/conversations/%E0%A4%A"}
	assertError(t, serve(h, r), 400, "INVALID_REQUEST")
}

type brokenBody struct{}

func (brokenBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func (brokenBody) Close() error             { return nil }

func TestBodyFormatAndMediaType(t *testing.T) {
	calls := 0
	h := newHandler(t, func(call serviceCall) (any, error) {
		calls++
		input := call.input.(handler.SendMessageInput)
		if !reflect.DeepEqual(input, handler.SendMessageInput{ConversationID: testID(7), Content: "Hello", MentionedAgentIDs: []string{}}) {
			t.Fatalf("unexpected send: %+v", input)
		}
		return handler.Message{MessageID: testID(11), Content: input.Content, MentionedAgentIDs: input.MentionedAgentIDs}, nil
	})
	for _, body := range []string{"{bad", "null", "[]", "123", "", `"text"`, `{"content":"Hello"} {}`, `{"content":"Hello"} trailing`} {
		assertError(t, serve(h, request("POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", body)), 400, "INVALID_REQUEST")
	}
	for _, mediaType := range []string{"", "text/plain", "application/problem+json"} {
		r := request("POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":"Hello"}`)
		r.Header.Set("Content-Type", mediaType)
		assertError(t, serve(h, r), 415, "UNSUPPORTED_MEDIA_TYPE")
	}
	r := request("POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", "")
	r.Body = brokenBody{}
	assertError(t, serve(h, r), 400, "INVALID_REQUEST")
	if calls != 0 {
		t.Fatal("invalid bodies invoked service")
	}
	for _, mediaType := range []string{"application/json; charset=utf-8", "APPLICATION/JSON", "  Application/Json ; charset=utf-8"} {
		r = request("POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":"Hello"}`)
		r.Header.Set("Content-Type", mediaType)
		if w := serve(h, r); w.Code != 201 {
			t.Fatalf("valid media type %q failed: %s", mediaType, w.Body)
		}
	}
	if calls != 3 {
		t.Fatalf("calls = %d, want 3", calls)
	}
}

func TestPaginationForwardsDirectionsWithoutReordering(t *testing.T) {
	page := handler.MessagePage{Messages: []handler.Message{
		{MessageID: testID(12), MentionedAgentIDs: []string{}}, {MessageID: testID(11), MentionedAgentIDs: []string{}},
	}, HasMore: true}
	for _, tc := range []struct {
		query string
		want  handler.MessagePageQuery
	}{
		{"limit=20&before_seq=40", handler.MessagePageQuery{ConversationID: testID(7), Limit: 20, BeforeSeq: ptr(int64(40))}},
		{"limit=1&after_seq=11", handler.MessagePageQuery{ConversationID: testID(7), Limit: 1, AfterSeq: ptr(int64(11))}},
		{"limit=50&after_seq=9007199254740991", handler.MessagePageQuery{ConversationID: testID(7), Limit: 50, AfterSeq: ptr(handler.MaxSeq)}},
	} {
		h := newHandler(t, func(call serviceCall) (any, error) {
			if !reflect.DeepEqual(call.input, tc.want) {
				t.Fatalf("query = %+v, want %+v", call.input, tc.want)
			}
			return page, nil
		})
		assertJSON(t, serve(h, request("GET", "/conversations/00000000-0000-7000-8000-000000000007/messages?"+tc.query, "")), 200, page)
	}
}

func TestRawTextMentionsAndUnknownIDsReachService(t *testing.T) {
	want := handler.SendMessageInput{ConversationID: testID(9999), Content: "  Hello\n", MentionedAgentIDs: []string{testID(9999), testID(2), testID(9999)}}
	h := newHandler(t, func(call serviceCall) (any, error) {
		if !reflect.DeepEqual(call.input, want) {
			t.Fatalf("input = %+v, want %+v", call.input, want)
		}
		return handler.Message{Content: want.Content, MentionedAgentIDs: want.MentionedAgentIDs}, nil
	})
	w := serve(h, request("POST", "/conversations/00000000-0000-7000-8000-00000000270f/messages", `{"content":"  Hello\n","mentioned_agent_ids":["00000000-0000-7000-8000-00000000270f","00000000-0000-7000-8000-000000000002","00000000-0000-7000-8000-00000000270f"]}`))
	if w.Code != 201 {
		t.Fatalf("status = %d: %s", w.Code, w.Body)
	}
	for _, numericID := range []string{"2", "2.0", "2e0", "9007199254740991"} {
		h := newHandler(t, func(serviceCall) (any, error) { t.Fatal("numeric ID reached service"); return nil, nil })
		assertError(t, serve(h, request("POST", "/conversations/direct", `{"agent_id":`+numericID+`}`)), 400, "INVALID_REQUEST")
	}

}

func TestEmptyGroupAndCompleteParticipantDirectory(t *testing.T) {
	h := newHandler(t, func(call serviceCall) (any, error) {
		switch call.method {
		case "CreateGroup":
			if !reflect.DeepEqual(call.input, handler.CreateGroupInput{Title: "Team", AgentIDs: []string{}}) {
				t.Fatalf("input = %+v", call.input)
			}
			return handler.Conversation{Kind: "group", Title: ptr("Team")}, nil
		case "ListParticipants":
			if !reflect.DeepEqual(call.input, handler.ParticipantsQuery{}) {
				t.Fatalf("query = %+v", call.input)
			}
			return []handler.Participant{}, nil
		default:
			t.Fatalf("unexpected call: %s", call.method)
			return nil, nil
		}
	})
	if w := serve(h, request("POST", "/conversations", `{"title":"Team","agent_ids":[]}`)); w.Code != 201 {
		t.Fatalf("empty group rejected: %s", w.Body)
	}
	assertJSON(t, serve(h, request("GET", "/participants", "")), 200, handler.ParticipantsResponse{Participants: []handler.Participant{}})
}

func TestEmptyOperationBodies(t *testing.T) {
	for _, body := range []string{"", " \n", "{}"} {
		calls := 0
		h := newHandler(t, func(call serviceCall) (any, error) {
			calls++
			if call.method == "RemoveMember" {
				return nil, nil
			}
			return handler.Conversation{ConversationID: testID(7)}, nil
		})
		if w := serve(h, request("POST", "/conversations/00000000-0000-7000-8000-000000000007/dissolve", body)); w.Code != 200 {
			t.Fatalf("empty dissolve: %s", w.Body)
		}
		assertJSON(t, serve(h, request("DELETE", "/conversations/00000000-0000-7000-8000-000000000007/members/00000000-0000-7000-8000-000000000002", body)), 204, nil)
		if calls != 2 {
			t.Fatalf("calls = %d, want 2", calls)
		}
	}
}

func TestNilSlicesSerializeAsArraysWithoutMutatingServiceData(t *testing.T) {
	page := handler.MessagePage{Messages: []handler.Message{{MessageID: testID(11)}}}
	h := newHandler(t, func(call serviceCall) (any, error) {
		if call.method == "ListMessages" {
			return page, nil
		}
		if call.method == "SendMessage" {
			return page.Messages[0], nil
		}
		return nil, nil
	})
	for path, expected := range map[string]any{
		"/participants":  map[string]any{"participants": []any{}},
		"/conversations": map[string]any{"conversations": []any{}},
		"/conversations/00000000-0000-7000-8000-000000000007/members": map[string]any{"members": []any{}},
	} {
		assertJSON(t, serve(h, request("GET", path, "")), 200, expected)
	}
	for _, r := range []*http.Request{request("GET", "/conversations/00000000-0000-7000-8000-000000000007/messages", ""), request("POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", `{"content":"Hi"}`)} {
		w := serve(h, r)
		if !strings.Contains(w.Body.String(), `"mentioned_agent_ids":[]`) {
			t.Fatalf("nil mentions: %s", w.Body)
		}
	}
	if page.Messages[0].MentionedAgentIDs != nil {
		t.Fatal("handler mutated service-owned data")
	}
	empty := newHandler(t, func(serviceCall) (any, error) { return handler.MessagePage{}, nil })
	assertJSON(t, serve(empty, request("GET", "/conversations/00000000-0000-7000-8000-000000000007/messages", "")), 200, handler.MessagePage{Messages: []handler.Message{}})
}

func TestRequestCancellationAndValuesReachService(t *testing.T) {
	type traceKey struct{}
	ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), traceKey{}, "trace"), 2*time.Second)
	defer cancel()
	ctx = handler.WithCaller(ctx, handler.RequestContext{ParticipantID: testID(9)})
	started := make(chan struct{})
	h := newHandler(t, func(call serviceCall) (any, error) {
		if call.ctx != ctx || call.ctx.Value(traceKey{}) != "trace" || call.caller.ParticipantID != testID(9) {
			return nil, errors.New("context was not preserved")
		}
		close(started)
		<-call.ctx.Done()
		return nil, call.ctx.Err()
	})
	r := request("GET", "/conversations", "").WithContext(ctx)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- serve(h, r) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("service did not receive the request context")
	}
	cancel()
	select {
	case w := <-done:
		assertError(t, w, 500, "INTERNAL_ERROR")
	case <-time.After(time.Second):
		t.Fatal("service did not observe cancellation")
	}
	never := newHandler(t, func(serviceCall) (any, error) { t.Fatal("cancelled request reached service"); return nil, nil })
	assertError(t, serve(never, r), 500, "INTERNAL_ERROR")
}

func TestConcurrentRequestsKeepCallerAndInputsSeparate(t *testing.T) {
	var calls atomic.Int64
	h := newHandler(t, func(call serviceCall) (any, error) {
		calls.Add(1)
		input := call.input.(handler.SendMessageInput)
		return handler.Message{MessageID: input.ConversationID, ConversationID: input.ConversationID, SenderID: call.caller.ParticipantID, Content: input.Content, MentionedAgentIDs: input.MentionedAgentIDs}, nil
	})
	var wg sync.WaitGroup
	for id := int64(1); id <= 64; id++ {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			body := fmt.Sprintf(`{"content":"request-%s","mentioned_agent_ids":["00000000-0000-7000-8000-000000000002","00000000-0000-7000-8000-000000000003","00000000-0000-7000-8000-000000000002"]}`, id)
			r := request("POST", fmt.Sprintf("/conversations/%s/messages", id), body)
			r = r.WithContext(handler.WithCaller(r.Context(), handler.RequestContext{ParticipantID: id}))
			r.Header.Set("X-Participant-ID", "9999")
			w := serve(h, r)
			var response handler.MessageResponse
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Error(err)
				return
			}
			message := response.Message
			if w.Code != 201 || message.ConversationID != id || message.SenderID != id || message.Content != fmt.Sprintf("request-%s", id) || !reflect.DeepEqual(message.MentionedAgentIDs, []string{testID(2), testID(3), testID(2)}) {
				t.Errorf("request %s received wrong response: %s", id, w.Body)
			}
		}(testID(id))
	}
	wg.Wait()
	if calls.Load() != 64 {
		t.Fatalf("calls = %d, want 64", calls.Load())
	}
}
