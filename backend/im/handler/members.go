package handler

func (h *Handler) listMembers(in requestInput) (any, int, error) {
	id, err := pathID(in.params[0], "conversation_id")
	if err != nil {
		return nil, 0, err
	}
	members, err := h.service.ListMembers(in.request.Context(), in.caller, id)
	return MembersResponse{nonNil(members)}, 200, err
}

func (h *Handler) addMember(in requestInput) (any, int, error) {
	id, err := pathID(in.params[0], "conversation_id")
	if err != nil {
		return nil, 0, err
	}
	body, err := bodyObject(in.request, []string{"participant_id"}, false)
	if err != nil {
		return nil, 0, err
	}
	participantID, err := bodyID(body["participant_id"], "participant_id")
	if err != nil {
		return nil, 0, err
	}
	member, err := h.service.AddMember(in.request.Context(), in.caller, AddMemberInput{ConversationID: id, ParticipantID: participantID})
	return MemberResponse{member}, 200, err
}

func (h *Handler) removeMember(in requestInput) (any, int, error) {
	conversationID, err := pathID(in.params[0], "conversation_id")
	if err != nil {
		return nil, 0, err
	}
	participantID, err := pathID(in.params[1], "participant_id")
	if err != nil {
		return nil, 0, err
	}
	if _, err := bodyObject(in.request, nil, true); err != nil {
		return nil, 0, err
	}
	err = h.service.RemoveMember(in.request.Context(), in.caller, RemoveMemberInput{ConversationID: conversationID, ParticipantID: participantID})
	return nil, 204, err
}
