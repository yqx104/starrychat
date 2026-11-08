package auth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"starrychat/backend/im/common"
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

func (t *Tokens) Issue(id string) (string, time.Time, error) {
	if !common.ValidID(id) {
		return "", time.Time{}, errors.New("invalid token subject")
	}
	now := t.now().UTC().Truncate(time.Second)
	expires := now.Add(Lifetime)
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", time.Time{}, err
	}
	claims := jwt.RegisteredClaims{Subject: id, Issuer: t.issuer, Audience: jwt.ClaimStrings{t.audience}, IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(expires), ID: base64.RawURLEncoding.EncodeToString(nonce[:])}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(t.key)
	return token, expires, err
}

func (t *Tokens) Verify(raw string) (string, error) {
	invalid := errors.New("invalid authentication token")
	if len(raw) == 0 || len(raw) > 4096 {
		return "", invalid
	}
	claims := &jwt.RegisteredClaims{}
	token, err := jwt.ParseWithClaims(raw, claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, invalid
		}
		return t.key, nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer(t.issuer), jwt.WithAudience(t.audience), jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithTimeFunc(t.now), jwt.WithStrictDecoding())
	if err != nil || token == nil || !token.Valid || claims.IssuedAt == nil || claims.ExpiresAt == nil {
		return "", invalid
	}
	id := claims.Subject
	if !common.ValidID(id) || !claims.ExpiresAt.After(claims.IssuedAt.Time) || claims.ExpiresAt.Sub(claims.IssuedAt.Time) > Lifetime {
		return "", invalid
	}
	return id, nil
}
