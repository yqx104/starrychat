package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"unicode"
)

type httpError struct {
	status  int
	code    string
	message string
}

func (e *httpError) Error() string { return e.message }

func invalid(message string) error {
	return &httpError{http.StatusBadRequest, "INVALID_REQUEST", message}
}

func validID(id int64) bool { return id > 0 && id <= MaxID }

func decimalID(value, field string) (int64, error) {
	if value == "" {
		return 0, invalid(field + " must contain decimal digits.")
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return 0, invalid(field + " must contain decimal digits.")
		}
	}
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || !validID(id) {
		return 0, invalid(field + " must be a positive safe integer.")
	}
	return id, nil
}

func pathID(value, field string) (int64, error) {
	decoded, err := url.PathUnescape(value)
	if err != nil {
		return 0, invalid(field + " is malformed.")
	}
	return decimalID(decoded, field)
}

func queryParameters(raw string, allowed []string) (url.Values, error) {
	query, err := url.ParseQuery(raw)
	if err != nil {
		return nil, invalid("Malformed query parameters.")
	}
	for key, values := range query {
		if !slices.Contains(allowed, key) {
			return nil, invalid("Unknown query parameter: " + key + ".")
		}
		if len(values) != 1 {
			return nil, invalid("Repeated query parameter: " + key + ".")
		}
	}
	return query, nil
}

// Match the existing JavaScript string.trim whitespace rules.
func blank(value string) bool {
	return strings.TrimFunc(value, func(r rune) bool {
		return unicode.Is(unicode.Zs, r) || r == '\t' || r == '\n' || r == '\v' || r == '\f' || r == '\r' || r == '\u2028' || r == '\u2029' || r == '\ufeff'
	}) == ""
}

func bodyObject(r *http.Request, allowed []string, allowEmpty bool) (map[string]json.RawMessage, error) {
	var source []byte
	var err error
	if r.Body != nil {
		source, err = io.ReadAll(io.LimitReader(r.Body, 1<<20+1))
	}
	if err != nil {
		return nil, invalid("Unable to read request body.")
	}
	if len(source) > 1<<20 {
		return nil, invalid("Request body exceeds 1 MiB.")
	}
	if blank(string(source)) {
		if allowEmpty {
			return map[string]json.RawMessage{}, nil
		}
		return nil, invalid("A JSON object body is required.")
	}
	mediaType := strings.TrimSpace(strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0])
	if !strings.EqualFold(mediaType, "application/json") {
		return nil, &httpError{http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json."}
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(source, &body); err != nil || body == nil {
		return nil, invalid("Request body must be a valid JSON object.")
	}
	for key := range body {
		if !slices.Contains(allowed, key) {
			return nil, invalid("Unknown body field: " + key + ".")
		}
	}
	return body, nil
}

func bodyID(raw json.RawMessage, field string) (int64, error) {
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil || value < 1 || value > float64(MaxID) || math.Trunc(value) != value {
		return 0, invalid(field + " must be a positive safe integer.")
	}
	return int64(value), nil
}

func bodyIDs(raw json.RawMessage, field string) ([]int64, error) {
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil || values == nil {
		return nil, invalid(field + " must be an array of IDs.")
	}
	ids := make([]int64, len(values))
	for index, raw := range values {
		id, err := bodyID(raw, fmt.Sprintf("%s[%d]", field, index))
		if err != nil {
			return nil, err
		}
		ids[index] = id
	}
	return ids, nil
}

func bodyText(raw json.RawMessage, field string) (string, error) {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil || blank(value) {
		return "", invalid(field + " must be a non-empty string.")
	}
	return value, nil
}

func messageQuery(conversationID int64, query url.Values) (MessagePageQuery, error) {
	result := MessagePageQuery{ConversationID: conversationID, Limit: 50}
	if query.Has("limit") {
		limit, err := decimalID(query.Get("limit"), "limit")
		if err != nil {
			return result, err
		}
		if limit > 50 {
			return result, invalid("limit must be between 1 and 50.")
		}
		result.Limit = int(limit)
	}
	if query.Has("before_message_id") && query.Has("after_message_id") {
		return result, invalid("before_message_id and after_message_id are mutually exclusive.")
	}
	if query.Has("before_message_id") {
		id, err := decimalID(query.Get("before_message_id"), "before_message_id")
		if err != nil {
			return result, err
		}
		result.BeforeMessageID = &id
	}
	if query.Has("after_message_id") {
		id, err := decimalID(query.Get("after_message_id"), "after_message_id")
		if err != nil {
			return result, err
		}
		result.AfterMessageID = &id
	}
	return result, nil
}
