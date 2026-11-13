package tests

import (
	"testing"

	"starrychat/backend/im/handler"
	"starrychat/backend/im/model"
	"starrychat/backend/im/repository"
)

func setConversationHidden(t *testing.T, f *imFixture, id string, hidden bool, caller string) model.Conversation {
	t.Helper()
	return apiJSON[handler.ConversationResponse](t, f, "/conversations/"+id+"/visibility", apiOptions{
		method: "PATCH", body: map[string]any{"hidden": hidden}, caller: caller,
	}).Conversation
}

func TestConversationVisibilityHandler(t *testing.T) {
	path := "/conversations/" + testID(7) + "/visibility"
	for _, hidden := range []bool{true, false} {
		h := newHandler(t, func(call serviceCall) (any, error) {
			equalValue(t, call.method, "SetConversationVisibility")
			equalValue(t, call.caller.ParticipantID, testID(1))
			equalValue(t, call.input, handler.SetConversationVisibilityInput{ConversationID: testID(7), Hidden: hidden})
			return handler.Conversation{ConversationID: testID(7), Kind: "direct", Hidden: hidden}, nil
		})
		body := `{"hidden":false}`
		if hidden {
			body = `{"hidden":true}`
		}
		assertJSON(t, serve(h, request("PATCH", path, body)), 200, handler.ConversationResponse{
			Conversation: handler.Conversation{ConversationID: testID(7), Kind: "direct", Hidden: hidden},
		})
	}
	h := newHandler(t, func(call serviceCall) (any, error) {
		t.Fatal("invalid request reached service")
		return nil, nil
	})
	for _, body := range []string{"", `{}`, `{"hidden":null}`, `{"hidden":0}`, `{"hidden":"true"}`, `{"hidden":[]}`, `{"hidden":true,"participant_id":"` + testID(2) + `"}`} {
		equalValue(t, serve(h, request("PATCH", path, body)).Code, 400)
	}
}

func TestMySQLConversationVisibility(t *testing.T) {
	instance := startMySQL(t)
	t.Run("hidden_groups_remain_listed_and_only_affect_the_caller", func(t *testing.T) {
		f := newIMFixture(t, instance)
		group := f.group(t, f.alpha, f.beta)
		message := f.send(t, group.ConversationID, "Keep this history", f.human)
		path := "/conversations/" + group.ConversationID
		events := f.count(t, "SELECT COUNT(*) FROM trigger_outbox")
		equalValue(t, group.Hidden, false)
		for range 2 {
			hidden := setConversationHidden(t, f, group.ConversationID, true, "")
			equalValue(t, hidden.Hidden, true)
			equalValue(t, hidden.ConversationID, group.ConversationID)
		}
		for _, caller := range []model.Participant{f.human, f.alpha, f.beta} {
			list := apiJSON[handler.ConversationsResponse](t, f, "/conversations", apiOptions{caller: caller.ParticipantID}).Conversations
			equalValue(t, len(list), 1)
			equalValue(t, list[0].ConversationID, group.ConversationID)
			equalValue(t, list[0].Hidden, caller.Kind == model.Human)
			detail := apiJSON[handler.ConversationResponse](t, f, path, apiOptions{caller: caller.ParticipantID}).Conversation
			equalValue(t, detail, list[0])
		}
		equalValue(t, apiJSON[handler.MessagePage](t, f, path+"/messages").Messages, []model.Message{message})
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversations"), int64(1))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversation_members"), int64(3))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox"), events)

		// A separate connection pool observes the persisted flag, without any UI state.
		reopened, err := repository.Open(t.Context(), f.dsn)
		if err != nil {
			t.Fatal(err)
		}
		defer reopened.Close()
		membership, err := reopened.GetMembership(t.Context(), group.ConversationID, f.human.ParticipantID)
		if err != nil {
			t.Fatal(err)
		}
		equalValue(t, membership.Hidden, true)
		renamed := apiJSON[handler.ConversationResponse](t, f, path, apiOptions{method: "PATCH", body: map[string]any{"title": "Renamed"}}).Conversation
		equalValue(t, renamed.Hidden, true)
		f.send(t, group.ConversationID, "Still deliver while hidden", f.alpha)
		equalValue(t, apiJSON[handler.ConversationResponse](t, f, path).Conversation.Hidden, true)
		setConversationHidden(t, f, group.ConversationID, true, f.alpha.ParticipantID)
		equalValue(t, setConversationHidden(t, f, group.ConversationID, false, "").Hidden, false)
		equalValue(t, apiJSON[handler.ConversationResponse](t, f, path, apiOptions{caller: f.alpha.ParticipantID}).Conversation.Hidden, true)
	})
	t.Run("opening_a_hidden_direct_chat_restores_the_original_without_resubscribing", func(t *testing.T) {
		f := newIMFixture(t, instance)
		open := func() model.Conversation {
			return apiJSON[handler.ConversationResponse](t, f, "/conversations/direct", apiOptions{method: "POST", body: map[string]any{"agent_id": f.alpha.ParticipantID}}).Conversation
		}
		direct := open()
		message := f.send(t, direct.ConversationID, "Original direct history", f.alpha)
		setConversationHidden(t, f, direct.ConversationID, true, "")
		setConversationHidden(t, f, direct.ConversationID, true, f.alpha.ParticipantID)
		events := f.count(t, "SELECT COUNT(*) FROM trigger_outbox")
		equalValue(t, open(), direct)
		equalValue(t, open(), direct)
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversations"), int64(1))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversation_members"), int64(2))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox"), events)
		path := "/conversations/" + direct.ConversationID
		equalValue(t, apiJSON[handler.ConversationResponse](t, f, path, apiOptions{caller: f.alpha.ParticipantID}).Conversation.Hidden, true)
		equalValue(t, apiJSON[handler.MessagePage](t, f, path+"/messages").Messages, []model.Message{message})
	})
	t.Run("dissolved_groups_can_be_hidden_and_reopened_for_history", func(t *testing.T) {
		f := newIMFixture(t, instance)
		group := f.group(t, f.alpha)
		message := f.send(t, group.ConversationID, "Archived history", f.human)
		path := "/conversations/" + group.ConversationID
		setConversationHidden(t, f, group.ConversationID, true, "")
		dissolved := apiJSON[handler.ConversationResponse](t, f, path+"/dissolve", apiOptions{method: "POST"}).Conversation
		equalValue(t, dissolved.Hidden, true)
		events := f.count(t, "SELECT COUNT(*) FROM trigger_outbox")
		restored := setConversationHidden(t, f, group.ConversationID, false, "")
		equalValue(t, restored.Hidden, false)
		equalValue(t, restored.DissolvedAt, dissolved.DissolvedAt)
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM trigger_outbox"), events)
		equalValue(t, apiJSON[handler.MessagePage](t, f, path+"/messages").Messages, []model.Message{message})
		apiJSON[handler.ErrorResponse](t, f, path+"/visibility", apiOptions{method: "PATCH", caller: f.outsider.ParticipantID, body: map[string]any{"hidden": true}, status: 403})
	})
	t.Run("authentication_and_owner_scope_apply_to_visibility_updates", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		owner := f.humanLogin(t)
		other := f.anotherHuman(t, "other-visibility-owner")
		group := responseValue[handler.ConversationResponse](t, f.call("POST", "/conversations", map[string]any{"title": "Private group", "agent_ids": []string{}}, authRequest{bearer: owner.Token}), 201).Conversation
		path := "/conversations/" + group.ConversationID + "/visibility"
		assertError(t, f.call("PATCH", path, map[string]any{"hidden": true}), 401, "UNAUTHORIZED")
		assertError(t, f.call("PATCH", path, map[string]any{"hidden": true}, authRequest{bearer: other.Token}), 403, "FORBIDDEN")
		visible := responseValue[handler.ConversationResponse](t, f.call("GET", "/conversations/"+group.ConversationID, nil, authRequest{bearer: owner.Token}), 200).Conversation
		equalValue(t, visible.Hidden, false)
	})
}
