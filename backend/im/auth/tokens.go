package auth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strconv"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"yqx-team/backend/im/model"
)

const Lifetime = 7 * 24 * time.Hour

type Tokens struct {
	key              []byte
	issuer, audience string
	now              func() time.Time
}

func NewTokens(key []byte, issuer, audience string, now func() time.Time) (*Tokens, error) {
	if len(key) < 32 || issuer == "" || audience == "" {
		return nil, errors.New("JWT requires a strong key, issuer and audience")
	}
	if now == nil {
		now = time.Now
	}
	return &Tokens{key: append([]byte(nil), key...), issuer: issuer, audience: audience, now: now}, nil
}

func (t *Tokens) Issue(id int64) (string, time.Time, error) {
	if id < 1 || id > model.MaxID {
		return "", time.Time{}, errors.New("invalid token subject")
	}
	now := t.now().UTC().Truncate(time.Second)
	expires := now.Add(Lifetime)
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", time.Time{}, err
	}
	claims := jwt.RegisteredClaims{Subject: strconv.FormatInt(id, 10), Issuer: t.issuer, Audience: jwt.ClaimStrings{t.audience}, IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(expires), ID: base64.RawURLEncoding.EncodeToString(nonce[:])}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(t.key)
	return token, expires, err
}

func (t *Tokens) Verify(raw string) (int64, error) {
	invalid := errors.New("invalid authentication token")
	if len(raw) == 0 || len(raw) > 4096 {
		return 0, invalid
	}
	claims := &jwt.RegisteredClaims{}
	token, err := jwt.ParseWithClaims(raw, claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, invalid
		}
		return t.key, nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer(t.issuer), jwt.WithAudience(t.audience), jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithTimeFunc(t.now), jwt.WithStrictDecoding())
	if err != nil || token == nil || !token.Valid || claims.IssuedAt == nil || claims.ExpiresAt == nil {
		return 0, invalid
	}
	id, err := strconv.ParseInt(claims.Subject, 10, 64)
	if err != nil || id < 1 || id > model.MaxID || strconv.FormatInt(id, 10) != claims.Subject || !claims.ExpiresAt.After(claims.IssuedAt.Time) || claims.ExpiresAt.Sub(claims.IssuedAt.Time) > Lifetime {
		return 0, invalid
	}
	return id, nil
}
