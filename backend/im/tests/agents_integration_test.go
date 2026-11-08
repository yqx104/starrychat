package tests

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"

	"yqx-team/backend/im/handler"
	"yqx-team/backend/im/model"
	"yqx-team/backend/im/repository"
	"yqx-team/backend/im/service"
)

type agentResponse struct {
	Agent model.AgentAccount `json:"agent"`
}
type agentsResponse struct {
	Agents []model.AgentAccount `json:"agents"`
}

func (f *authFixture) anotherHuman(t *testing.T, username string) loginResult {
	t.Helper()
	responseValue[map[string]any](t, f.call("POST", "/auth/register", registration(username, "human")), 201)
	return responseValue[loginResult](t, f.call("POST", "/auth/login", loginBody(username, "bearer")), 200)
}

func (f *authFixture) createAgent(t *testing.T, owner loginResult, username string) model.AgentAccount {
	t.Helper()
	w := f.call("POST", "/agents", map[string]any{"name": "Agent " + username, "username": username, "password": testPassword}, authRequest{bearer: owner.Token})
	agent := responseValue[agentResponse](t, w, 201).Agent
	equalValue(t, agent.OwnerParticipantID, owner.Participant.ParticipantID)
	equalValue(t, agent.Kind, model.Agent)
	id, err := f.tokens.Verify(w.Header().Get("X-IM-Token"))
	if err != nil || id != owner.Participant.ParticipantID {
		t.Fatal("agent creation changed login identity")
	}
	return agent
}

func participantIDs(participants []model.Participant) []int64 {
	ids := make([]int64, len(participants))
	for i, p := range participants {
		ids[i] = p.ParticipantID
	}
	return ids
}

func TestMySQLAgentOwnership(t *testing.T) {
	instance := startMySQL(t)
	t.Run("multiple_humans_manage_only_owned_agents_and_directory_scope", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		one := f.humanLogin(t)
		two := f.anotherHuman(t, "other-human")
		equalValue(t, responseValue[agentsResponse](t, f.call("GET", "/agents", nil, authRequest{bearer: one.Token}), 200).Agents, []model.AgentAccount{})
		a := f.createAgent(t, one, "alpha")
		b := f.createAgent(t, one, "beta")
		foreign := f.createAgent(t, two, "foreign")
		equalValue(t, responseValue[agentsResponse](t, f.call("GET", "/agents", nil, authRequest{bearer: one.Token}), 200).Agents, []model.AgentAccount{a, b})
		equalValue(t, responseValue[agentsResponse](t, f.call("GET", "/agents", nil, authRequest{bearer: two.Token}), 200).Agents, []model.AgentAccount{foreign})
		agentLogin := responseValue[loginResult](t, f.call("POST", "/auth/login", loginBody("alpha", "bearer")), 200)
		for _, token := range []string{one.Token, agentLogin.Token} {
			people := responseValue[handler.ParticipantsResponse](t, f.call("GET", "/participants", nil, authRequest{bearer: token}), 200).Participants
			equalValue(t, participantIDs(people), []int64{one.Participant.ParticipantID, a.ParticipantID, b.ParticipantID})
			filtered := responseValue[handler.ParticipantsResponse](t, f.call("GET", "/participants?kind=agent", nil, authRequest{bearer: token}), 200).Participants
			equalValue(t, participantIDs(filtered), []int64{a.ParticipantID, b.ParticipantID})
			human := responseValue[handler.ParticipantsResponse](t, f.call("GET", "/participants?kind=human", nil, authRequest{bearer: token}), 200).Participants
			equalValue(t, participantIDs(human), []int64{one.Participant.ParticipantID})
		}
		assertError(t, f.call("GET", "/agents", nil, authRequest{bearer: agentLogin.Token}), 403, "FORBIDDEN")
		assertError(t, f.call("POST", "/agents", map[string]any{"name": "Denied", "username": "denied", "password": testPassword}, authRequest{bearer: agentLogin.Token}), 403, "FORBIDDEN")
		assertError(t, f.call("PATCH", fmt.Sprintf("/agents/%d", a.ParticipantID), map[string]any{"name": "Denied"}, authRequest{bearer: agentLogin.Token}), 403, "FORBIDDEN")
		assertError(t, f.call("PATCH", fmt.Sprintf("/agents/%d", a.ParticipantID), map[string]any{"name": "Denied"}, authRequest{bearer: two.Token}), 403, "FORBIDDEN")
		for _, human := range []loginResult{one, two} {
			account, err := f.store.GetAccount(t.Context(), human.Participant.ParticipantID)
			if err != nil {
				t.Fatal(err)
			}
			equalValue(t, account.Kind, model.Human)
			if account.OwnerParticipantID != nil {
				t.Fatal("human has owner")
			}
		}
		account, err := f.store.GetAccount(t.Context(), a.ParticipantID)
		if err != nil {
			t.Fatal(err)
		}
		equalValue(t, *account.OwnerParticipantID, one.Participant.ParticipantID)
		equalValue(t, account.Kind, model.Agent)
	})
	t.Run("cross_owner_direct_group_invitation_and_reads_are_rejected", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		one := f.humanLogin(t)
		two := f.anotherHuman(t, "other-human")
		a := f.createAgent(t, one, "alpha")
		b := f.createAgent(t, one, "beta")
		foreign := f.createAgent(t, two, "foreign")
		agent := responseValue[loginResult](t, f.call("POST", "/auth/login", loginBody("alpha", "bearer")), 200)
		foreignAgent := responseValue[loginResult](t, f.call("POST", "/auth/login", loginBody("foreign", "bearer")), 200)
		assertError(t, f.call("POST", "/conversations/direct", map[string]any{"agent_id": foreign.ParticipantID}, authRequest{bearer: one.Token}), 403, "FORBIDDEN")
		assertError(t, f.call("POST", "/conversations", map[string]any{"title": "Denied", "agent_ids": []int64{a.ParticipantID, foreign.ParticipantID}}, authRequest{bearer: one.Token}), 403, "FORBIDDEN")
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM conversations"), int64(0))
		group := responseValue[handler.ConversationResponse](t, f.call("POST", "/conversations", map[string]any{"title": "Own group", "agent_ids": []int64{a.ParticipantID}}, authRequest{bearer: one.Token}), 201).Conversation
		path := fmt.Sprintf("/conversations/%d", group.ConversationID)
		for _, token := range []string{one.Token, agent.Token} {
			assertError(t, f.call("POST", path+"/members", map[string]any{"participant_id": foreign.ParticipantID}, authRequest{bearer: token}), 403, "FORBIDDEN")
			assertError(t, f.call("POST", path+"/messages", map[string]any{"content": "Denied mention", "mentioned_agent_ids": []int64{foreign.ParticipantID}}, authRequest{bearer: token}), 403, "FORBIDDEN")
		}
		responseValue[handler.MemberResponse](t, f.call("POST", path+"/members", map[string]any{"participant_id": b.ParticipantID}, authRequest{bearer: agent.Token}), 200)
		for _, token := range []string{two.Token, foreignAgent.Token} {
			for _, suffix := range []string{"", "/members", "/messages"} {
				assertError(t, f.call("GET", path+suffix, nil, authRequest{bearer: token}), 403, "FORBIDDEN")
			}
			assertError(t, f.call("POST", path+"/messages", map[string]any{"content": "Denied"}, authRequest{bearer: token}), 403, "FORBIDDEN")
			assertError(t, f.call("PATCH", path, map[string]any{"title": "Denied"}, authRequest{bearer: token}), 403, "FORBIDDEN")
			assertError(t, f.call("POST", path+"/dissolve", nil, authRequest{bearer: token}), 403, "FORBIDDEN")
			equalValue(t, responseValue[handler.ConversationsResponse](t, f.call("GET", "/conversations", nil, authRequest{bearer: token}), 200).Conversations, []model.Conversation{})
		}
		// An inconsistent imported membership still cannot grant cross-owner access.
		f.exec(t, "INSERT INTO conversation_members (conversation_id,participant_id,created_at) VALUES (?,?,?)", group.ConversationID, foreign.ParticipantID, int64(1))
		assertError(t, f.call("GET", path, nil, authRequest{bearer: foreignAgent.Token}), 403, "FORBIDDEN")
		equalValue(t, responseValue[handler.ConversationsResponse](t, f.call("GET", "/conversations", nil, authRequest{bearer: foreignAgent.Token}), 200).Conversations, []model.Conversation{})
		assertError(t, f.call("GET", path+"/members", nil, authRequest{bearer: one.Token}), 403, "FORBIDDEN")
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM messages"), int64(0))
	})
	t.Run("agent_credentials_update_atomically_and_old_jwt_remains_valid", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		owner := f.humanLogin(t)
		a := f.createAgent(t, owner, "alpha")
		original := responseValue[loginResult](t, f.call("POST", "/auth/login", loginBody("alpha", "bearer")), 200)
		path := fmt.Sprintf("/agents/%d", a.ParticipantID)
		password := "new-isolated-密码-pass "
		w := f.call("PATCH", path, map[string]any{"name": "Renamed", "username": "renamed-agent", "password": password}, authRequest{bearer: owner.Token})
		updated := responseValue[agentResponse](t, w, 200).Agent
		equalValue(t, updated, model.AgentAccount{ParticipantID: a.ParticipantID, Kind: model.Agent, Name: "Renamed", Username: "renamed-agent", OwnerParticipantID: a.OwnerParticipantID, CreatedAt: a.CreatedAt})
		account, err := f.store.GetAccount(t.Context(), a.ParticipantID)
		if err != nil {
			t.Fatal(err)
		}
		if account.Password != password {
			t.Fatal("stored password differs from update input")
		}
		for _, secret := range []string{password, "password"} {
			if strings.Contains(w.Body.String(), secret) {
				t.Fatal("credential leaked in management response")
			}
		}
		var fields map[string]json.RawMessage
		var envelope map[string]json.RawMessage
		if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(envelope["agent"], &fields); err != nil {
			t.Fatal(err)
		}
		equalValue(t, len(fields), 6)
		assertError(t, f.call("POST", "/auth/login", loginBody("alpha", "bearer")), 401, "UNAUTHORIZED")
		assertError(t, f.call("POST", "/auth/login", loginBody("renamed-agent", "bearer")), 401, "UNAUTHORIZED")
		body := loginBody("renamed-agent", "bearer")
		body["password"] = password
		logged := responseValue[loginResult](t, f.call("POST", "/auth/login", body), 200)
		equalValue(t, logged.Participant.ParticipantID, a.ParticipantID)
		me := responseValue[struct {
			Participant model.Participant `json:"participant"`
		}](t, f.call("GET", "/auth/me", nil, authRequest{bearer: original.Token}), 200)
		equalValue(t, me.Participant.Name, "Renamed")
		f.createAgent(t, owner, "occupied")
		assertError(t, f.call("PATCH", path, map[string]any{"name": "Must roll back", "username": "occupied"}, authRequest{bearer: owner.Token}), 409, "CONFLICT")
		persisted, err := f.store.GetParticipant(t.Context(), a.ParticipantID)
		if err != nil {
			t.Fatal(err)
		}
		equalValue(t, persisted.Name, "Renamed")
		responseValue[loginResult](t, f.call("POST", "/auth/login", body), 200)
	})
	t.Run("forged_ownership_invalid_patches_and_legacy_registration_cannot_bypass", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		owner := f.humanLogin(t)
		for _, extra := range []map[string]any{{"kind": "human"}, {"owner_participant_id": 999}, {"participant_id": 999}, {"password_hash": "hash"}} {
			body := map[string]any{"name": "Agent", "username": "alpha", "password": testPassword}
			for k, v := range extra {
				body[k] = v
			}
			assertError(t, f.call("POST", "/agents", body, authRequest{bearer: owner.Token}), 400, "INVALID_REQUEST")
		}
		legacy := registration("legacy", "agent")
		legacy["owner_participant_id"] = 999
		assertError(t, f.call("POST", "/auth/register", legacy, authRequest{bearer: owner.Token}), 400, "INVALID_REQUEST")
		delete(legacy, "owner_participant_id")
		created := responseValue[struct {
			Participant model.Participant `json:"participant"`
		}](t, f.call("POST", "/auth/register", legacy, authRequest{bearer: owner.Token}), 201).Participant
		account, err := f.store.GetAccount(t.Context(), created.ParticipantID)
		if err != nil {
			t.Fatal(err)
		}
		equalValue(t, *account.OwnerParticipantID, owner.Participant.ParticipantID)
		path := fmt.Sprintf("/agents/%d", created.ParticipantID)
		for _, body := range []map[string]any{{}, {"name": " "}, {"username": nil}, {"password": "short"}, {"password": strings.Repeat("x", 73)}, {"kind": "human"}, {"owner_participant_id": 999}, {"username": "bad name"}} {
			assertError(t, f.call("PATCH", path, body, authRequest{bearer: owner.Token}), 400, "INVALID_REQUEST")
		}
		assertError(t, f.call("DELETE", path, nil, authRequest{bearer: owner.Token}), 405, "METHOD_NOT_ALLOWED")
		assertError(t, f.call("GET", "/agents?owner_participant_id=999", nil, authRequest{bearer: owner.Token}), 400, "INVALID_REQUEST")
		assertError(t, f.call("GET", "/agents", nil), 401, "UNAUTHORIZED")
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM participants"), int64(2))
	})
	t.Run("kind_owner_constraints_and_inconsistent_identity_fail_closed", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		owner := f.humanLogin(t)
		a := f.createAgent(t, owner, "alpha")
		for _, statement := range []string{
			fmt.Sprintf("UPDATE participant_accounts SET kind='human' WHERE participant_id=%d", a.ParticipantID),
			fmt.Sprintf("UPDATE participant_accounts SET owner_participant_id=NULL WHERE participant_id=%d", a.ParticipantID),
			fmt.Sprintf("UPDATE participant_accounts SET owner_participant_id=0 WHERE participant_id=%d", a.ParticipantID),
			fmt.Sprintf("UPDATE participant_accounts SET owner_participant_id=%d WHERE participant_id=%d", a.ParticipantID, a.ParticipantID),
			fmt.Sprintf("UPDATE participant_accounts SET kind='other' WHERE participant_id=%d", a.ParticipantID),
			fmt.Sprintf("UPDATE participant_accounts SET owner_participant_id=%d WHERE participant_id=%d", a.ParticipantID, owner.Participant.ParticipantID),
		} {
			if _, err := f.db.ExecContext(t.Context(), statement); err == nil {
				t.Fatal("invalid kind/owner combination accepted")
			}
		}
		raw, _, err := f.tokens.Issue(a.ParticipantID)
		if err != nil {
			t.Fatal(err)
		}
		f.exec(t, "UPDATE participant_accounts SET owner_participant_id=999999 WHERE participant_id=?", a.ParticipantID)
		assertError(t, f.call("GET", "/auth/me", nil, authRequest{bearer: raw}), 401, "UNAUTHORIZED")
		f.exec(t, "UPDATE participant_accounts SET kind='human',owner_participant_id=NULL WHERE participant_id=?", a.ParticipantID)
		assertError(t, f.call("GET", "/auth/me", nil, authRequest{bearer: raw}), 401, "UNAUTHORIZED")
	})
	t.Run("concurrent_agent_username_uniqueness_and_partial_updates", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		one := f.humanLogin(t)
		two := f.anotherHuman(t, "other-human")
		other, err := repository.Open(t.Context(), f.dsn)
		if err != nil {
			t.Fatal(err)
		}
		defer other.Close()
		services := []*service.Service{service.New(f.store), service.New(other)}
		owners := []loginResult{one, two}
		var workers sync.WaitGroup
		results := make(chan error, 2)
		start := make(chan struct{})
		for i, s := range services {
			workers.Go(func() {
				<-start
				_, err := s.CreateAgent(t.Context(), model.RequestContext{ParticipantID: owners[i].Participant.ParticipantID}, model.CreateAgentInput{Name: "Concurrent", Username: "shared-agent", Password: testPassword})
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
			} else if value, ok := err.(*model.ServiceError); !ok || value.Code != "CONFLICT" {
				t.Fatal(err)
			}
		}
		equalValue(t, success, 1)
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM participants"), int64(3))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM participant_accounts"), int64(3))
		a := f.createAgent(t, one, "partial-agent")
		name := "Concurrent name"
		username := "concurrent-name"
		patches := []model.UpdateAgentInput{{ParticipantID: a.ParticipantID, Name: &name}, {ParticipantID: a.ParticipantID, Username: &username}}
		for i, s := range services {
			workers.Go(func() {
				_, err := s.UpdateAgent(context.Background(), model.RequestContext{ParticipantID: one.Participant.ParticipantID}, patches[i])
				if err != nil {
					t.Error(err)
				}
			})
		}
		workers.Wait()
		p, err := f.store.GetParticipant(t.Context(), a.ParticipantID)
		if err != nil {
			t.Fatal(err)
		}
		equalValue(t, p.Name, name)
		account, err := f.store.GetAccount(t.Context(), a.ParticipantID)
		if err != nil {
			t.Fatal(err)
		}
		equalValue(t, account.Username, username)
	})
	t.Run("local_binding_requires_explicit_human_id", func(t *testing.T) {
		f := newAuthFixture(t, instance)
		first, err := f.store.InsertParticipant(t.Context(), model.Human, "First", 1)
		if err != nil {
			t.Fatal(err)
		}
		second, err := f.store.InsertParticipant(t.Context(), model.Human, "Second", 2)
		if err != nil {
			t.Fatal(err)
		}
		s := service.New(f.store)
		if _, err := s.BindHumanAccount(t.Context(), 0, "bound", testPassword); err == nil {
			t.Fatal("implicit human binding accepted")
		}
		bound, err := s.BindHumanAccount(t.Context(), second.ParticipantID, "bound", testPassword)
		if err != nil {
			t.Fatal(err)
		}
		equalValue(t, bound, second)
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM participant_accounts WHERE participant_id=?", first.ParticipantID), int64(0))
	})
}
