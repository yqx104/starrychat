package auth

import (
	"errors"
	"regexp"
)

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$`)

func ValidateCredentials(username, password string) error {
	if err := ValidateUsername(username); err != nil {
		return err
	}
	return ValidatePassword(password)
}

func ValidateUsername(username string) error {
	if !usernamePattern.MatchString(username) {
		return errors.New("Username must be 3–64 ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit.")
	}
	return nil
}

func ValidatePassword(password string) error {
	if len(password) < 8 || len(password) > 72 {
		return errors.New("Password must be 8–72 bytes.")
	}
	return nil
}
