package service

import (
	"context"
	"time"

	"starrychat/backend/im/model"
	"starrychat/backend/im/repository"
)

func (s *Service) ListMembers(ctx context.Context, caller model.RequestContext, id string) ([]model.Participant, error) {
	return read(ctx, s, func(q *repository.Queries) ([]model.Participant, error) {
		if _, err := accessibleConversation(ctx, q, caller, id, false); err != nil {
			return nil, err
		}
		members, err := q.ListMemberships(ctx, id)
		if err != nil {
			return nil, err
		}
		participants := make([]model.Participant, 0, len(members))
		ownerID, err := callerOwner(ctx, q, caller)
		if err != nil {
			return nil, err
		}
		for _, member := range members {
			participant, err := requireParticipant(ctx, q, member.ParticipantID)
			if err != nil {
				return nil, err
			}
			owner, err := ownerOf(ctx, q, participant)
			if err != nil {
				return nil, err
			}
			if owner != ownerID {
				return nil, businessError("FORBIDDEN", "Conversation contains a participant from another human.")
			}
			participants = append(participants, participant)
		}
		return participants, nil
	})
}

func (s *Service) AddMember(ctx context.Context, caller model.RequestContext, input model.AddMemberInput) (model.Participant, error) {
	return write(ctx, s, func(q *repository.Queries) (model.Participant, error) {
		conversation, err := editableGroup(ctx, q, caller, input.ConversationID)
		if err != nil {
			return model.Participant{}, err
		}
		ownerID, err := callerOwner(ctx, q, caller)
		if err != nil {
			return model.Participant{}, err
		}
		agent, err := requireOwnedAgent(ctx, q, ownerID, input.ParticipantID)
		if err != nil {
			return agent, err
		}
		exists, err := memberExists(ctx, q, input.ConversationID, input.ParticipantID)
		if err != nil {
			return agent, err
		}
		if !exists {
			if err := q.InsertMember(ctx, input.ConversationID, input.ParticipantID, time.Now().UnixMilli()); err != nil {
				return agent, err
			}
			input := model.TriggerSubscription{TriggerSource: triggerSource(conversation), AgentIDs: []string{agent.ParticipantID}}
			err = q.EnqueueTrigger(ctx, &conversation.ConversationID, model.TriggerSubscribe, input)
		}
		return agent, err
	})
}

func (s *Service) RemoveMember(ctx context.Context, caller model.RequestContext, input model.RemoveMemberInput) error {
	_, err := write(ctx, s, func(q *repository.Queries) (struct{}, error) {
		conversation, err := editableGroup(ctx, q, caller, input.ConversationID)
		if err != nil {
			return struct{}{}, err
		}
		ownerID, err := callerOwner(ctx, q, caller)
		if err != nil {
			return struct{}{}, err
		}
		if _, err := requireOwnedAgent(ctx, q, ownerID, input.ParticipantID); err != nil {
			return struct{}{}, err
		}
		exists, err := memberExists(ctx, q, input.ConversationID, input.ParticipantID)
		if err != nil {
			return struct{}{}, err
		}
		if !exists {
			return struct{}{}, businessError("NOT_FOUND", "Agent is not a member of this conversation.")
		}
		if err := q.DeleteMember(ctx, input.ConversationID, input.ParticipantID); err != nil {
			return struct{}{}, err
		}
		event := model.TriggerUnsubscription{TriggerSource: triggerSource(conversation), AgentID: input.ParticipantID}
		return struct{}{}, q.EnqueueTrigger(ctx, &input.ConversationID, model.TriggerUnsubscribe, event)
	})
	return err
}
