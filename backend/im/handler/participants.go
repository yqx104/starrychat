package handler

func (h *Handler) listParticipants(in requestInput) (any, int, error) {
	query := ParticipantsQuery{}
	if in.query.Has("kind") {
		query.Kind = ParticipantKind(in.query.Get("kind"))
		if query.Kind != Human && query.Kind != Agent {
			return nil, 0, invalid("kind must be human or agent.")
		}
	}
	participants, err := h.service.ListParticipants(in.request.Context(), in.caller, query)
	return ParticipantsResponse{nonNil(participants)}, 200, err
}
