package tests

import (
	"reflect"
	"testing"

	"starrychat/backend/im/handler"
)

func TestOptionalQuotedMessageID(t *testing.T) {
	for _, tc := range []struct {
		name, field string
		want        *string
	}{
		{"omitted", "", nil},
		{"null", `,"quoted_message_id":null`, nil},
		{"null_with_whitespace", ",\"quoted_message_id\": \n null \t ", nil},
		{"uuid", `,"quoted_message_id":"00000000-0000-7000-8000-000000000001"`, ptr(testID(1))},
		{"business_validation_deferred", `,"quoted_message_id":"00000000-0000-7000-8000-00000000270f"`, ptr(testID(9999))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			h := newHandler(t, func(call serviceCall) (any, error) {
				calls++
				want := handler.SendMessageInput{ConversationID: testID(7), Content: "  Reply\n", MentionedAgentIDs: []string{testID(2), testID(3), testID(2)}, QuotedMessageID: tc.want}
				if call.method != "SendMessage" || call.caller.ParticipantID != testID(1) || !reflect.DeepEqual(call.input, want) {
					t.Fatalf("unexpected service call: %+v", call)
				}
				return handler.Message{MessageSeq: 1, MessageID: testID(11), ConversationID: testID(7), SenderID: call.caller.ParticipantID,
					Content: want.Content, CreatedAt: 1700000000000, MentionedAgentIDs: want.MentionedAgentIDs, QuotedMessageID: want.QuotedMessageID}, nil
			})
			body := `{"content":"  Reply\n","mentioned_agent_ids":["00000000-0000-7000-8000-000000000002","00000000-0000-7000-8000-000000000003","00000000-0000-7000-8000-000000000002"]` + tc.field + `}`
			assertJSON(t, serve(h, request("POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", body)), 201, map[string]any{
				"message": map[string]any{"message_seq": 1, "message_id": testID(11), "conversation_id": testID(7), "sender_id": testID(1),
					"content": "  Reply\n", "created_at": int64(1700000000000), "mentioned_agent_ids": []string{testID(2), testID(3), testID(2)}, "quoted_message_id": tc.want},
			})
			if calls != 1 {
				t.Fatalf("service calls = %d, want 1", calls)
			}
		})
	}
}

func TestInvalidQuotedMessageIDsNeverReachService(t *testing.T) {
	h := newHandler(t, func(serviceCall) (any, error) { t.Fatal("invalid quote reached service"); return nil, nil })
	for _, value := range []string{`0`, `-1`, `1.5`, `9007199254740992`, `1e400`, `"1"`, `""`, `true`, `false`, `[]`, `{}`} {
		t.Run(value, func(t *testing.T) {
			body := `{"content":"Reply","quoted_message_id":` + value + `}`
			assertError(t, serve(h, request("POST", "/conversations/00000000-0000-7000-8000-000000000007/messages", body)), 400, "INVALID_REQUEST")
		})
	}
}

func TestCreationTimesAndQuotesInResponses(t *testing.T) {
	participant := handler.Participant{ParticipantID: testID(2), Kind: handler.Agent, Name: "Agent", CreatedAt: 1700000000000}
	conversation := handler.Conversation{ConversationID: testID(7), Kind: "group", Title: ptr("Team"), CreatedAt: 1700000000100}
	h := newHandler(t, func(call serviceCall) (any, error) {
		switch call.method {
		case "ListParticipants", "ListMembers":
			return []handler.Participant{participant}, nil
		case "GetConversation":
			return conversation, nil
		case "ListMessages":
			return handler.MessagePage{Messages: []handler.Message{
				{MessageSeq: 1, MessageID: testID(10), ConversationID: testID(7), SenderID: testID(1), Content: "Original", CreatedAt: 1700000000200},
				{MessageSeq: 1, MessageID: testID(11), ConversationID: testID(7), SenderID: testID(2), Content: "Reply", CreatedAt: 1700000000300, QuotedMessageID: ptr(testID(10))},
			}}, nil
		default:
			t.Fatalf("unexpected call: %s", call.method)
			return nil, nil
		}
	})
	participantJSON := map[string]any{"participant_id": testID(2), "kind": "agent", "name": "Agent", "created_at": int64(1700000000000)}
	assertJSON(t, serve(h, request("GET", "/participants", "")), 200, map[string]any{"participants": []any{participantJSON}})
	// Member responses remain participants; their created_at is not a join timestamp.
	assertJSON(t, serve(h, request("GET", "/conversations/00000000-0000-7000-8000-000000000007/members", "")), 200, map[string]any{"members": []any{participantJSON}})
	assertJSON(t, serve(h, request("GET", "/conversations/00000000-0000-7000-8000-000000000007", "")), 200, map[string]any{
		"conversation": map[string]any{"conversation_id": testID(7), "kind": "group", "title": "Team", "created_at": int64(1700000000100), "dissolved_at": nil},
	})
	assertJSON(t, serve(h, request("GET", "/conversations/00000000-0000-7000-8000-000000000007/messages", "")), 200, map[string]any{
		"messages": []any{
			map[string]any{"message_seq": 1, "message_id": testID(10), "conversation_id": testID(7), "sender_id": testID(1), "content": "Original", "created_at": int64(1700000000200), "quoted_message_id": nil, "mentioned_agent_ids": []any{}},
			map[string]any{"message_seq": 1, "message_id": testID(11), "conversation_id": testID(7), "sender_id": testID(2), "content": "Reply", "created_at": int64(1700000000300), "quoted_message_id": testID(10), "mentioned_agent_ids": []any{}},
		},
		"has_more": false,
	})
}
