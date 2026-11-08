package tests

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"

	"yqx-team/backend/im/handler"
	"yqx-team/backend/im/model"
	"yqx-team/backend/im/repository"
	"yqx-team/backend/im/service"
)

func TestMySQLBusiness(t *testing.T) {
	instance := startMySQL(t)
	t.Run("directory_and_group_lifecycle", func(t *testing.T) {
		f := newIMFixture(t, instance)
		equalValue(t, apiJSON[handler.ParticipantsResponse](t, f, "/participants").Participants, []model.Participant{f.human, f.alpha, f.beta, f.outsider})
		equalValue(t, apiJSON[handler.ParticipantsResponse](t, f, "/participants?kind=human").Participants, []model.Participant{f.human})
		equalValue(t, apiJSON[handler.ParticipantsResponse](t, f, "/participants?kind=agent").Participants, []model.Participant{f.alpha, f.beta, f.outsider})
		equalValue(t, apiJSON[handler.ConversationsResponse](t, f, "/conversations").Conversations, []model.Conversation{})
		before := time.Now().UnixMilli()
		group := f.group(t, f.alpha, f.beta, f.alpha)
		if group.CreatedAt < before || group.CreatedAt > time.Now().UnixMilli() {
			t.Fatalf("invalid creation time: %+v", group)
		}
		equalValue(t, apiJSON[handler.ConversationResponse](t, f, "/conversations/1").Conversation, group)
		equalValue(t, apiJSON[handler.MembersResponse](t, f, "/conversations/1/members").Members, []model.Participant{f.human, f.alpha, f.beta})
		for _, caller := range []model.Participant{f.human, f.alpha, f.beta} {
			equalValue(t, apiJSON[handler.ConversationsResponse](t, f, "/conversations", apiOptions{caller: caller.ParticipantID}).Conversations, []model.Conversation{group})
		}
		equalValue(t, apiJSON[handler.ConversationsResponse](t, f, "/conversations", apiOptions{caller: f.outsider.ParticipantID}).Conversations, []model.Conversation{})
		title := "Team'); DROP TABLE messages; --"
		renamed := apiJSON[handler.ConversationResponse](t, f, "/conversations/1", apiOptions{method: "PATCH", caller: f.alpha.ParticipantID, body: map[string]any{"title": title}}).Conversation
		group.Title = &title
		equalValue(t, renamed, group)
		equalValue(t, f.send(t, 1, "消息仍可保存", f.human).Content, "消息仍可保存")
		empty := f.group(t)
		equalValue(t, apiJSON[handler.MembersResponse](t, f, fmt.Sprintf("/conversations/%d/members", empty.ConversationID)).Members, []model.Participant{f.human})
	})
	t.Run("direct_reuse_and_fixed_membership", func(t *testing.T) {
		f := newIMFixture(t, instance)
		input := apiOptions{method: "POST", body: map[string]any{"agent_id": f.alpha.ParticipantID}}
		first := apiJSON[handler.ConversationResponse](t, f, "/conversations/direct", input).Conversation
		equalValue(t, apiJSON[handler.ConversationResponse](t, f, "/conversations/direct", input).Conversation, first)
		if first.Kind != "direct" || first.Title != nil || first.DissolvedAt != nil {
			t.Fatalf("invalid direct: %+v", first)
		}
		other := apiJSON[handler.ConversationResponse](t, f, "/conversations/direct", apiOptions{method: "POST", body: map[string]any{"agent_id": f.beta.ParticipantID}}).Conversation
		if first.ConversationID == other.ConversationID {
			t.Fatal("different pairs reused the same chat")
		}
		for _, op := range []struct {
			path, method string
			body         any
		}{
			{"/conversations/1", "PATCH", map[string]any{"title": "Changed"}},
			{"/conversations/1/dissolve", "POST", nil},
			{"/conversations/1/members", "POST", map[string]any{"participant_id": f.beta.ParticipantID}},
			{fmt.Sprintf("/conversations/1/members/%d", f.alpha.ParticipantID), "DELETE", nil},
		} {
			equalValue(t, apiJSON[handler.ErrorResponse](t, f, op.path, apiOptions{method: op.method, body: op.body, status: 422}).Error.Code, "INVALID_OPERATION")
		}
		equalValue(t, apiJSON[handler.MembersResponse](t, f, "/conversations/1/members").Members, []model.Participant{f.human, f.alpha})
		message := f.send(t, 1, "Agent reply", f.alpha)
		equalValue(t, message.SenderID, f.alpha.ParticipantID)
		equalValue(t, apiJSON[handler.MessagePage](t, f, "/conversations/1/messages", apiOptions{caller: f.alpha.ParticipantID}).Messages, []model.Message{message})
		apiJSON[handler.ErrorResponse](t, f, "/conversations/direct", apiOptions{method: "POST", body: map[string]any{"agent_id": f.alpha.ParticipantID}, caller: f.alpha.ParticipantID, status: 403})
		apiJSON[handler.ErrorResponse](t, f, "/conversations/direct", apiOptions{method: "POST", body: map[string]any{"agent_id": f.human.ParticipantID}, status: 422})
		apiJSON[handler.ErrorResponse](t, f, "/conversations/direct", apiOptions{method: "POST", body: map[string]any{"agent_id": 9999}, status: 404})
	})
	t.Run("member_changes_preserve_timestamps_participants_and_history", func(t *testing.T) {
		f := newIMFixture(t, instance)
		f.group(t, f.alpha)
		oldMessage := f.send(t, 1, "Before removal", f.alpha)
		add := apiOptions{method: "POST", body: map[string]any{"participant_id": f.beta.ParticipantID}}
		equalValue(t, apiJSON[handler.MemberResponse](t, f, "/conversations/1/members", add).Member, f.beta)
		membership, err := f.store.GetMembership(t.Context(), 1, f.beta.ParticipantID)
		if err != nil {
			t.Fatal(err)
		}
		if membership.CreatedAt <= f.beta.CreatedAt {
			t.Fatal("membership reused participant registration time")
		}
		f.exec(t, "UPDATE conversation_members SET created_at=? WHERE conversation_id=1 AND participant_id=?", int64(1700000000100), f.beta.ParticipantID)
		equalValue(t, apiJSON[handler.MemberResponse](t, f, "/conversations/1/members", add).Member, f.beta)
		membership, err = f.store.GetMembership(t.Context(), 1, f.beta.ParticipantID)
		if err != nil {
			t.Fatal(err)
		}
		equalValue(t, membership.CreatedAt, int64(1700000000100))
		apiJSON[handler.ErrorResponse](t, f, "/conversations/1/members", apiOptions{method: "POST", body: map[string]any{"participant_id": f.human.ParticipantID}, status: 422})
		apiJSON[handler.ErrorResponse](t, f, fmt.Sprintf("/conversations/1/members/%d", f.human.ParticipantID), apiOptions{method: "DELETE", status: 422})
		apiJSON[handler.ErrorResponse](t, f, "/conversations/1/members", apiOptions{method: "POST", body: map[string]any{"participant_id": 9999}, status: 404})
		removePath := fmt.Sprintf("/conversations/1/members/%d", f.alpha.ParticipantID)
		apiJSON[any](t, f, removePath, apiOptions{method: "DELETE", status: 204})
		apiJSON[handler.ErrorResponse](t, f, removePath, apiOptions{method: "DELETE", status: 404})
		participant, err := f.store.GetParticipant(t.Context(), f.alpha.ParticipantID)
		if err != nil {
			t.Fatal(err)
		}
		equalValue(t, participant, f.alpha)
		equalValue(t, apiJSON[handler.MessagePage](t, f, "/conversations/1/messages").Messages, []model.Message{oldMessage})
		equalValue(t, apiJSON[handler.ConversationsResponse](t, f, "/conversations", apiOptions{caller: f.alpha.ParticipantID}).Conversations, []model.Conversation{})
		apiJSON[handler.ErrorResponse](t, f, "/conversations/1/messages", apiOptions{caller: f.alpha.ParticipantID, status: 403})
		apiJSON[handler.ErrorResponse](t, f, "/conversations/1/messages", apiOptions{method: "POST", caller: f.alpha.ParticipantID, body: map[string]any{"content": "Too late"}, status: 403})
		quote := apiJSON[handler.MessageResponse](t, f, "/conversations/1/messages", apiOptions{method: "POST", status: 201, body: map[string]any{"content": "History quote", "quoted_message_id": oldMessage.MessageID}}).Message
		equalValue(t, quote.QuotedMessageID, &oldMessage.MessageID)
		equalValue(t, quote.MentionedAgentIDs, []int64{})
		apiJSON[handler.ErrorResponse](t, f, "/conversations/1/messages", apiOptions{method: "POST", body: map[string]any{"content": "Removed mention", "mentioned_agent_ids": []int64{f.alpha.ParticipantID}}, status: 422})
		apiJSON[handler.MemberResponse](t, f, "/conversations/1/members", apiOptions{method: "POST", body: map[string]any{"participant_id": f.alpha.ParticipantID}})
		equalValue(t, len(apiJSON[handler.MessagePage](t, f, "/conversations/1/messages", apiOptions{caller: f.alpha.ParticipantID}).Messages), 2)
	})
	t.Run("mentions_and_quotes_validate_without_partial_writes", func(t *testing.T) {
		f := newIMFixture(t, instance)
		f.group(t, f.alpha, f.beta)
		f.group(t, f.alpha)
		foreign := f.send(t, 2, "Other conversation", f.human)
		original := f.send(t, 1, "Original", f.alpha)
		content := "  回复\n'); DELETE FROM messages; --"
		before := time.Now().UnixMilli()
		message := apiJSON[handler.MessageResponse](t, f, "/conversations/1/messages", apiOptions{method: "POST", status: 201, body: map[string]any{"content": content, "mentioned_agent_ids": []int64{f.beta.ParticipantID, f.alpha.ParticipantID, f.beta.ParticipantID}, "quoted_message_id": original.MessageID}}).Message
		equalValue(t, message.Content, content)
		equalValue(t, message.MentionedAgentIDs, []int64{f.beta.ParticipantID, f.alpha.ParticipantID})
		equalValue(t, message.QuotedMessageID, &original.MessageID)
		if message.CreatedAt < before || message.CreatedAt > time.Now().UnixMilli() || message.MessageID <= original.MessageID {
			t.Fatal("message IDs/timestamps are not server generated")
		}
		for _, tc := range []struct {
			body   any
			status int
		}{
			{map[string]any{"content": "Bad", "mentioned_agent_ids": []int64{f.alpha.ParticipantID, f.human.ParticipantID}}, 422},
			{map[string]any{"content": "Bad", "mentioned_agent_ids": []int64{f.alpha.ParticipantID, f.outsider.ParticipantID}}, 422},
			{map[string]any{"content": "Bad", "mentioned_agent_ids": []int64{f.alpha.ParticipantID, 9999}}, 404},
			{map[string]any{"content": "Bad", "quoted_message_id": foreign.MessageID}, 422},
			{map[string]any{"content": "Bad", "quoted_message_id": 9999}, 404},
		} {
			apiJSON[handler.ErrorResponse](t, f, "/conversations/1/messages", apiOptions{method: "POST", body: tc.body, status: tc.status})
		}
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM messages"), int64(3))
		noQuote := apiJSON[handler.MessageResponse](t, f, "/conversations/1/messages", apiOptions{method: "POST", caller: f.alpha.ParticipantID, status: 201, body: map[string]any{"content": "No quote", "quoted_message_id": nil}}).Message
		if noQuote.QuotedMessageID != nil {
			t.Fatal("null quote became a target")
		}
		equalValue(t, noQuote.MentionedAgentIDs, []int64{})
		equalValue(t, noQuote.SenderID, f.alpha.ParticipantID)
	})
	runRemainingBusinessTests(t, instance)
}

func runRemainingBusinessTests(t *testing.T, instance *mysqlInstance) {
	t.Run("all_operations_validate_caller_and_current_membership", func(t *testing.T) {
		f := newIMFixture(t, instance)
		f.group(t, f.alpha, f.beta)
		operations := []struct {
			path, method string
			body         any
		}{
			{"/participants", "GET", nil}, {"/conversations", "GET", nil},
			{"/conversations", "POST", map[string]any{"title": "Team", "agent_ids": []int64{f.alpha.ParticipantID}}},
			{"/conversations/direct", "POST", map[string]any{"agent_id": f.alpha.ParticipantID}},
			{"/conversations/1", "GET", nil}, {"/conversations/1", "PATCH", map[string]any{"title": "Changed"}},
			{"/conversations/1/dissolve", "POST", nil}, {"/conversations/1/members", "GET", nil},
			{"/conversations/1/members", "POST", map[string]any{"participant_id": f.outsider.ParticipantID}},
			{fmt.Sprintf("/conversations/1/members/%d", f.alpha.ParticipantID), "DELETE", nil},
			{"/conversations/1/messages", "GET", nil}, {"/conversations/1/messages", "POST", map[string]any{"content": "Hello"}},
		}
		for _, op := range operations {
			equalValue(t, apiJSON[handler.ErrorResponse](t, f, op.path, apiOptions{method: op.method, body: op.body, caller: 9999, status: 403}).Error.Code, "FORBIDDEN")
			if strings.HasPrefix(op.path, "/conversations/1") {
				apiJSON[handler.ErrorResponse](t, f, op.path, apiOptions{method: op.method, body: op.body, caller: f.outsider.ParticipantID, status: 403})
				apiJSON[handler.ErrorResponse](t, f, strings.Replace(op.path, "/conversations/1", "/conversations/9999", 1), apiOptions{method: op.method, body: op.body, status: 404})
			}
		}
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversations"), int64(1))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversation_members"), int64(3))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM messages"), int64(0))
		conversation := apiJSON[handler.ConversationResponse](t, f, "/conversations/1").Conversation
		if conversation.DissolvedAt != nil || *conversation.Title != "Team" {
			t.Fatal("failed requests changed group")
		}
	})
	t.Run("dissolution_keeps_history_and_rejects_mutations", func(t *testing.T) {
		f := newIMFixture(t, instance)
		f.group(t, f.alpha, f.beta)
		message := f.send(t, 1, "History", f.alpha)
		closed := apiJSON[handler.ConversationResponse](t, f, "/conversations/1/dissolve", apiOptions{method: "POST"}).Conversation
		if closed.DissolvedAt == nil {
			t.Fatal("dissolution time missing")
		}
		previous := *closed.DissolvedAt - 1000
		f.exec(t, "UPDATE conversations SET dissolved_at=? WHERE conversation_id=1", previous)
		closed.DissolvedAt = &previous
		equalValue(t, apiJSON[handler.ConversationResponse](t, f, "/conversations/1/dissolve", apiOptions{method: "POST"}).Conversation, closed)
		for _, op := range []struct {
			path, method string
			body         any
		}{
			{"/conversations/1", "PATCH", map[string]any{"title": "Closed"}},
			{"/conversations/1/members", "POST", map[string]any{"participant_id": f.outsider.ParticipantID}},
			{fmt.Sprintf("/conversations/1/members/%d", f.alpha.ParticipantID), "DELETE", nil},
			{"/conversations/1/messages", "POST", map[string]any{"content": "Too late"}},
		} {
			equalValue(t, apiJSON[handler.ErrorResponse](t, f, op.path, apiOptions{method: op.method, body: op.body, status: 409}).Error.Code, "CONFLICT")
		}
		for _, caller := range []model.Participant{f.human, f.alpha, f.beta} {
			equalValue(t, apiJSON[handler.ConversationResponse](t, f, "/conversations/1", apiOptions{caller: caller.ParticipantID}).Conversation, closed)
			equalValue(t, apiJSON[handler.MessagePage](t, f, "/conversations/1/messages", apiOptions{caller: caller.ParticipantID}), handler.MessagePage{Messages: []model.Message{message}})
			equalValue(t, apiJSON[handler.MembersResponse](t, f, "/conversations/1/members", apiOptions{caller: caller.ParticipantID}).Members, []model.Participant{f.human, f.alpha, f.beta})
			equalValue(t, apiJSON[handler.ConversationsResponse](t, f, "/conversations", apiOptions{caller: caller.ParticipantID}).Conversations, []model.Conversation{closed})
		}
	})
	t.Run("invalid_group_targets_leave_no_orphans", func(t *testing.T) {
		f := newIMFixture(t, instance)
		for _, tc := range []struct {
			ids    []int64
			status int
		}{
			{[]int64{f.alpha.ParticipantID, 9999}, 404},
			{[]int64{f.alpha.ParticipantID, f.human.ParticipantID}, 422},
		} {
			apiJSON[handler.ErrorResponse](t, f, "/conversations", apiOptions{method: "POST", body: map[string]any{"title": "Invalid", "agent_ids": tc.ids}, status: tc.status})
		}
		apiJSON[handler.ErrorResponse](t, f, "/conversations", apiOptions{method: "POST", body: map[string]any{"title": "Invalid", "agent_ids": []int64{}}, caller: f.alpha.ParticipantID, status: 403})
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversations"), int64(0))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversation_members"), int64(0))
	})
	t.Run("stable_cursor_pagination_with_equal_times_and_interleaved_chats", func(t *testing.T) {
		f := newIMFixture(t, instance)
		f.group(t, f.alpha)
		f.group(t, f.beta)
		seed := f.send(t, 2, "Other cursor", f.human)
		messages := []model.Message{}
		for i := 0; i < 53; i++ {
			messages = append(messages, f.send(t, 1, fmt.Sprintf("Message %d", i), f.human))
			f.send(t, 2, fmt.Sprintf("Other %d", i), f.human)
		}
		f.exec(t, "UPDATE messages SET created_at=1700000000000")
		for i := range messages {
			messages[i].CreatedAt = 1700000000000
		}
		equalValue(t, apiJSON[handler.MessagePage](t, f, "/conversations/1/messages"), handler.MessagePage{Messages: messages[3:], HasMore: true})
		equalValue(t, apiJSON[handler.MessagePage](t, f, "/conversations/1/messages?limit=1"), handler.MessagePage{Messages: messages[52:], HasMore: true})
		backward := []model.Message{}
		before := ""
		for i := 0; i < 10; i++ {
			page := apiJSON[handler.MessagePage](t, f, "/conversations/1/messages?limit=20"+before)
			backward = append(page.Messages, backward...)
			if !page.HasMore {
				break
			}
			before = fmt.Sprintf("&before_message_id=%d", page.Messages[0].MessageID)
		}
		equalValue(t, backward, messages)
		forward := []model.Message{}
		after := seed.MessageID
		for i := 0; i < 10; i++ {
			page := apiJSON[handler.MessagePage](t, f, fmt.Sprintf("/conversations/1/messages?limit=20&after_message_id=%d", after))
			forward = append(forward, page.Messages...)
			if !page.HasMore {
				break
			}
			after = page.Messages[len(page.Messages)-1].MessageID
		}
		equalValue(t, forward, messages)
		last := messages[len(messages)-1].MessageID
		equalValue(t, apiJSON[handler.MessagePage](t, f, fmt.Sprintf("/conversations/1/messages?after_message_id=%d", last)), handler.MessagePage{Messages: []model.Message{}})
		added := f.send(t, 1, "Incremental", f.alpha)
		equalValue(t, apiJSON[handler.MessagePage](t, f, fmt.Sprintf("/conversations/1/messages?after_message_id=%d", last)), handler.MessagePage{Messages: []model.Message{added}})
		equalValue(t, apiJSON[handler.MessagePage](t, f, "/conversations/1/messages?before_message_id=1"), handler.MessagePage{Messages: []model.Message{}})
		equalValue(t, apiJSON[handler.MessagePage](t, f, fmt.Sprintf("/conversations/1/messages?after_message_id=%d", model.MaxID)), handler.MessagePage{Messages: []model.Message{}})
		empty := f.group(t)
		equalValue(t, apiJSON[handler.MessagePage](t, f, fmt.Sprintf("/conversations/%d/messages", empty.ConversationID)), handler.MessagePage{Messages: []model.Message{}})
	})
	t.Run("transactions_roll_back_partial_writes_errors_and_cancellation", func(t *testing.T) {
		f := newIMFixture(t, instance)
		err := f.store.WithinTx(t.Context(), nil, func(q *repository.Queries) error {
			conversation, err := q.InsertConversation(t.Context(), "group", ptr("Rollback"), 1700000000000)
			if err != nil {
				return err
			}
			if err := q.InsertMember(t.Context(), conversation.ConversationID, f.human.ParticipantID, 1700000000000); err != nil {
				return err
			}
			return q.InsertMember(t.Context(), conversation.ConversationID, f.human.ParticipantID, 1700000000000)
		})
		var sqlError *mysql.MySQLError
		if !errors.As(err, &sqlError) || sqlError.Number != 1062 {
			t.Fatalf("expected real duplicate-key failure: %v", err)
		}
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversations"), int64(0))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversation_members"), int64(0))
		f.exec(t, "ALTER TABLE conversations AUTO_INCREMENT=9007199254740992")
		failure := apiJSON[handler.ErrorResponse](t, f, "/conversations", apiOptions{method: "POST", status: 500, body: map[string]any{"title": "Unsafe ID", "agent_ids": []int64{f.alpha.ParticipantID}}})
		equalValue(t, failure.Error, handler.ErrorDetail{Code: "INTERNAL_ERROR", Message: "Internal server error."})
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversations"), int64(0))
		f.exec(t, "ALTER TABLE conversations AUTO_INCREMENT=1")
		group := f.group(t, f.alpha)
		f.exec(t, "ALTER TABLE messages AUTO_INCREMENT=9007199254740992")
		apiJSON[handler.ErrorResponse](t, f, fmt.Sprintf("/conversations/%d/messages", group.ConversationID), apiOptions{method: "POST", status: 500, body: map[string]any{"content": "Unsafe ID"}})
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM messages"), int64(0))
		f.exec(t, "ALTER TABLE messages AUTO_INCREMENT=1")
		f.send(t, group.ConversationID, "After rollback", f.human)
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		err = f.store.WithinTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted}, func(q *repository.Queries) error {
			if _, err := q.InsertParticipant(ctx, model.Agent, "Cancelled", 1700000000000); err != nil {
				return err
			}
			cancel()
			return nil
		})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("transaction cancellation = %v", err)
		}
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM participants"), int64(4))
	})
	t.Run("closing_and_reopening_pool_preserves_data", func(t *testing.T) {
		f := newIMFixture(t, instance)
		group := f.group(t, f.alpha)
		message := f.send(t, group.ConversationID, "Persistent", f.human)
		if err := f.store.Close(); err != nil {
			t.Fatal(err)
		}
		if err := f.store.Close(); err != nil {
			t.Fatal(err)
		}
		var err error
		f.store, err = repository.Open(t.Context(), f.dsn)
		if err != nil {
			t.Fatal(err)
		}
		f.handle = handler.New(service.New(f.store))
		equalValue(t, apiJSON[handler.MessagePage](t, f, fmt.Sprintf("/conversations/%d/messages", group.ConversationID)).Messages, []model.Message{message})
		equalValue(t, apiJSON[handler.ParticipantsResponse](t, f, "/participants").Participants, []model.Participant{f.human, f.alpha, f.beta, f.outsider})
	})
	runMySQLConcurrencyTests(t, instance)
}
