package tests

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"yqx-team/backend/im/config"
)

func TestSigningKeyPersistsAcrossConcurrentStarts(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "signing.key")
	keys := make([][]byte, 32)
	var workers sync.WaitGroup
	for i := range keys {
		workers.Go(func() {
			var err error
			keys[i], err = config.LoadOrCreateKey(path)
			if err != nil {
				t.Error(err)
			}
		})
	}
	workers.Wait()
	for _, key := range keys {
		if len(key) != 32 || !bytes.Equal(key, keys[0]) {
			t.Fatal("concurrent start created different keys")
		}
	}
	again, err := config.LoadOrCreateKey(path)
	if err != nil || !bytes.Equal(again, keys[0]) {
		t.Fatal("restart replaced signing key")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	equalValue(t, info.Mode().Perm(), os.FileMode(0600))
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := config.LoadOrCreateKey(path); err == nil {
		t.Fatal("public key file accepted")
	}
}

func TestPrivateConfigurationValidation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	data, _ := json.Marshal(config.Config{MySQLDSN: "redacted-test-only", Address: "127.0.0.1:0", InsecureLocalHTTP: true})
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	c, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	equalValue(t, c.SigningKeyFile, filepath.Join(dir, "signing.key"))
	equalValue(t, c.Issuer, "yqx-im")
	for _, source := range []string{`{}`, `{"mysql_dsn":"private","address":"0.0.0.0:4180","insecure_local_http":true}`, `{"mysql_dsn":"private","unknown":true}`, `{} {}`} {
		if err := os.WriteFile(path, []byte(source), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := config.Load(path); err == nil {
			t.Fatal("invalid config accepted")
		}
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Load(path); err == nil {
		t.Fatal("public config accepted")
	}
	link := filepath.Join(dir, "linked.key")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := config.LoadOrCreateKey(link); err == nil {
		t.Fatal("symlink accepted")
	}
}
