package tests

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"yqx-team/backend/im/common/auth"
	"yqx-team/backend/im/model"
)

func testTokens(t *testing.T) (*auth.Tokens, *atomic.Int64, []byte) {
	t.Helper()
	clock := &atomic.Int64{}
	clock.Store(1800000000)
	key := bytes.Repeat([]byte{0x39}, 32)
	tokens, err := auth.NewTokens(key, "test-im", "test-api", func() time.Time { return time.Unix(clock.Load(), 0) })
	if err != nil {
		t.Fatal(err)
	}
	return tokens, clock, key
}

func TestJWTStrictValidation(t *testing.T) {
	tokens, clock, key := testTokens(t)
	raw, expires, err := tokens.Issue(testID(9999))
	if err != nil {
		t.Fatal(err)
	}
	id, err := tokens.Verify(raw)
	if err != nil || id != testID(9999) {
		t.Fatal("valid safe subject rejected")
	}
	equalValue(t, expires.Unix(), clock.Load()+int64(auth.Lifetime.Seconds()))
	for name, change := range map[string]func(jwt.MapClaims){
		"missing_sub":       func(c jwt.MapClaims) { delete(c, "sub") },
		"numeric_sub":       func(c jwt.MapClaims) { c["sub"] = 1 },
		"unsafe_sub":        func(c jwt.MapClaims) { c["sub"] = "9007199254740992" },
		"zero_sub":          func(c jwt.MapClaims) { c["sub"] = "0" },
		"negative_sub":      func(c jwt.MapClaims) { c["sub"] = "-1" },
		"noncanonical_sub":  func(c jwt.MapClaims) { c["sub"] = "01" },
		"missing_exp":       func(c jwt.MapClaims) { delete(c, "exp") },
		"expired":           func(c jwt.MapClaims) { c["exp"] = clock.Load() },
		"missing_iat":       func(c jwt.MapClaims) { delete(c, "iat") },
		"future_iat":        func(c jwt.MapClaims) { c["iat"] = clock.Load() + 1 },
		"future_nbf":        func(c jwt.MapClaims) { c["nbf"] = clock.Load() + 1 },
		"missing_iss":       func(c jwt.MapClaims) { delete(c, "iss") },
		"wrong_iss":         func(c jwt.MapClaims) { c["iss"] = "other" },
		"missing_aud":       func(c jwt.MapClaims) { delete(c, "aud") },
		"wrong_aud":         func(c jwt.MapClaims) { c["aud"] = "other" },
		"too_long_lifetime": func(c jwt.MapClaims) { c["exp"] = clock.Load() + int64(auth.Lifetime.Seconds()) + 1 },
		"inverted_times":    func(c jwt.MapClaims) { c["iat"] = clock.Load() - 1; c["exp"] = clock.Load() - 2 },
	} {
		t.Run(name, func(t *testing.T) {
			claims := jwt.MapClaims{"sub": testID(1), "iat": clock.Load(), "exp": clock.Load() + 3600, "iss": "test-im", "aud": "test-api"}
			change(claims)
			raw, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(key)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = tokens.Verify(raw); err == nil {
				t.Fatal("invalid claims accepted")
			}
		})
	}
	t.Run("algorithm_and_signature", func(t *testing.T) {
		claims := jwt.MapClaims{"sub": testID(1), "iat": clock.Load(), "exp": clock.Load() + 3600, "iss": "test-im", "aud": "test-api"}
		for _, method := range []jwt.SigningMethod{jwt.SigningMethodHS384, jwt.SigningMethodNone} {
			var signingKey any = key
			if method == jwt.SigningMethodNone {
				signingKey = jwt.UnsafeAllowNoneSignatureType
			}
			raw, err := jwt.NewWithClaims(method, claims).SignedString(signingKey)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = tokens.Verify(raw); err == nil {
				t.Fatal("wrong algorithm accepted")
			}
		}
		wrong, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(bytes.Repeat([]byte{1}, 32))
		for _, raw := range []string{wrong, "", "bad.token.value", strings.Repeat("x", 4097)} {
			if _, err := tokens.Verify(raw); err == nil {
				t.Fatal("invalid signature accepted")
			}
		}
	})
}

func TestJWTRollingSevenDaysAndConcurrentIsolation(t *testing.T) {
	tokens, clock, _ := testTokens(t)
	old, oldExpiry, err := tokens.Issue(testID(1))
	if err != nil {
		t.Fatal(err)
	}
	clock.Add(int64(auth.Lifetime.Seconds()) - 1)
	if _, err := tokens.Verify(old); err != nil {
		t.Fatal(err)
	}
	renewed, expires, err := tokens.Issue(testID(1))
	if err != nil {
		t.Fatal(err)
	}
	equalValue(t, expires.Unix(), clock.Load()+int64(auth.Lifetime.Seconds()))
	clock.Add(1)
	if clock.Load() != oldExpiry.Unix() {
		t.Fatal("wrong boundary")
	}
	if _, err := tokens.Verify(old); err == nil {
		t.Fatal("expired token accepted")
	}
	if _, err := tokens.Verify(renewed); err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	seen := sync.Map{}
	for id := int64(1); id <= 64; id++ {
		workers.Go(func() {
			raw, _, err := tokens.Issue(testID(id))
			if err != nil {
				t.Error(err)
				return
			}
			subject, err := tokens.Verify(raw)
			if err != nil || subject != testID(id) {
				t.Error("concurrent identity mixed")
			}
			if _, loaded := seen.LoadOrStore(raw, true); loaded {
				t.Error("token not newly signed")
			}
		})
	}
	workers.Wait()
	serialized, _ := json.Marshal(model.ParticipantAccount{ParticipantID: testID(1), Username: "private", Password: "private", CreatedAt: 1})
	equalValue(t, string(serialized), "{}")
	if _, err := auth.NewTokens([]byte("short"), "issuer", "aud", nil); err == nil {
		t.Fatal("weak key accepted")
	}
}
