package config

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
)

type Config struct {
	MySQLDSN          string `json:"mysql_dsn"`
	Address           string `json:"address"`
	SigningKeyFile    string `json:"signing_key_file"`
	InsecureLocalHTTP bool   `json:"insecure_local_http"`
	Issuer            string `json:"issuer"`
	Audience          string `json:"audience"`
}

func Load(path string) (Config, error) {
	var c Config
	data, err := privateRead(path, 16<<10)
	if err != nil {
		return c, errors.New("unable to read private IM_CONFIG (regular file, mode 0600 required)")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&c); err != nil {
		return Config{}, errors.New("invalid IM_CONFIG JSON")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return Config{}, errors.New("invalid IM_CONFIG JSON")
	}
	if c.MySQLDSN == "" {
		return Config{}, errors.New("IM_CONFIG requires mysql_dsn")
	}
	if c.Address == "" {
		c.Address = "127.0.0.1:4180"
	}
	host, _, err := net.SplitHostPort(c.Address)
	if err != nil {
		return Config{}, errors.New("invalid IM address")
	}
	if c.InsecureLocalHTTP && (net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback()) {
		return Config{}, errors.New("local HTTP development requires a loopback IP listener")
	}
	if c.SigningKeyFile == "" {
		c.SigningKeyFile = "signing.key"
	}
	if !filepath.IsAbs(c.SigningKeyFile) {
		c.SigningKeyFile = filepath.Join(filepath.Dir(path), c.SigningKeyFile)
	}
	if c.Issuer == "" {
		c.Issuer = "yqx-im"
	}
	if c.Audience == "" {
		c.Audience = "yqx-im-api"
	}
	return c, nil
}

func privateRead(path string, max int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("private file permissions required")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errors.New("private file changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, errors.New("private file too large")
	}
	return data, nil
}

// Publish a complete key atomically; concurrent starts all read the same winner.
func LoadOrCreateKey(path string) ([]byte, error) {
	if key, err := privateRead(path, 32); err == nil {
		if len(key) != 32 {
			return nil, errors.New("signing key must be exactly 32 random bytes")
		}
		return key, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("unable to read private signing key")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, errors.New("unable to create private key directory")
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("signing key directory requires mode 0700")
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(dir, ".signing-key-*")
	if err != nil {
		return nil, errors.New("unable to create signing key")
	}
	name := f.Name()
	defer os.Remove(name)
	_, writeErr := f.Write(key)
	syncErr := f.Sync()
	closeErr := f.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		return nil, errors.New("unable to persist signing key")
	}
	if err := os.Link(name, path); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, errors.New("unable to publish signing key")
	}
	stored, err := privateRead(path, 32)
	if err != nil || len(stored) != 32 {
		return nil, errors.New("unable to load persisted signing key")
	}
	return stored, nil
}
