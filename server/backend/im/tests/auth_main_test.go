package tests

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"starrychat/backend/im/config"
	"starrychat/backend/im/handler"
	"starrychat/backend/im/model"
)

func TestLocalRuntimePortProbeAllowsGracefulRestart(t *testing.T) {
	script := filepath.Join("..", "..", "..", "..", "localdeploy", "im", "local.py")
	if _, err := os.Stat(script); os.IsNotExist(err) {
		t.Skip("localdeploy is Git-ignored; local deployment script is not installed")
	} else if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	probe := func() error {
		command := exec.CommandContext(t.Context(), "python3", "-B", "-c", fmt.Sprintf("import importlib.util; s=importlib.util.spec_from_file_location('im_local',%q); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.check_port(%d)", script, port))
		return command.Run()
	}
	if err := probe(); err == nil {
		t.Fatal("port probe accepted an active listener")
	}
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(client); err != nil {
		t.Fatal(err)
	}
	_ = client.Close()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	if err := probe(); err != nil {
		t.Fatal("port probe rejected a stopped server with closed connections")
	}
}

func launchTestIM(t *testing.T, binary, path string) (string, func()) {
	t.Helper()
	command := exec.Command(binary, "-config", path)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	ready := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if address, ok := strings.CutPrefix(scanner.Text(), "IM 已就绪：http://"); ok {
				ready <- "http://" + address
			}
		}
	}()
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			_ = command.Process.Signal(syscall.SIGTERM)
			select {
			case err := <-done:
				if err != nil {
					t.Errorf("IM did not stop cleanly: %v; %s", err, &stderr)
				}
			case <-time.After(15 * time.Second):
				_ = command.Process.Kill()
				<-done
				t.Error("IM graceful shutdown timed out")
			}
		})
	}
	t.Cleanup(stop)
	select {
	case address := <-ready:
		return address, stop
	case <-time.After(10 * time.Second):
		t.Fatal("IM listener did not become ready")
	}
	return "", stop
}

func testHTTPJSON[T any](t *testing.T, base, method, path string, body any, token string, status int) T {
	t.Helper()
	var zero T
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	r, err := http.NewRequestWithContext(t.Context(), method, base+path, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != status {
		t.Fatalf("%s %s status %d, want %d", method, path, response.StatusCode, status)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("cacheable response")
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&zero); err != nil {
		t.Fatal(err)
	}
	return zero
}

func testRealEntrypoint(t *testing.T, f *imFixture) {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "im")
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, "go", "build", "-race", "-o", binary, "../cmd").CombinedOutput(); err != nil {
		t.Fatalf("build real IM: %v %s", err, output)
	}
	path := filepath.Join(dir, "config.json")
	data, _ := json.Marshal(config.Config{MySQLDSN: f.dsn, Address: "127.0.0.1:0", InsecureLocalHTTP: true})
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	// The existing human cannot be claimed through a public registration route.
	f.exec(t, "DELETE FROM participant_accounts WHERE participant_id=?", f.human.ParticipantID)
	command := exec.CommandContext(ctx, binary, "-config", path, "-bind-human-account")
	input, _ := json.Marshal(map[string]any{"participant_id": f.human.ParticipantID, "username": "local-owner", "password": testPassword})
	command.Stdin = bytes.NewReader(input)
	if output, err := command.CombinedOutput(); err != nil || !strings.Contains(string(output), fmt.Sprintf("participant_id=%s", f.human.ParticipantID)) {
		t.Fatalf("local account binding failed: %v", err)
	}
	base, stop := launchTestIM(t, binary, path)
	equalValue(t, testHTTPJSON[handler.ErrorResponse](t, base, "GET", "/participants", nil, "", 401).Error.Code, "UNAUTHORIZED")
	logged := testHTTPJSON[loginResult](t, base, "POST", "/auth/login", loginBody("local-owner", "bearer"), "", 200)
	equalValue(t, logged.Participant, f.human)
	group := testHTTPJSON[handler.ConversationResponse](t, base, "POST", "/conversations", map[string]any{"title": "Real listener", "agent_ids": []string{}}, logged.Token, 201).Conversation
	message := testHTTPJSON[handler.MessageResponse](t, base, "POST", fmt.Sprintf("/conversations/%s/messages", group.ConversationID), map[string]any{"content": "Persisted over actual HTTP"}, logged.Token, 201).Message
	stop()
	base, stop = launchTestIM(t, binary, path)
	defer stop()
	me := testHTTPJSON[struct {
		Participant model.Participant `json:"participant"`
	}](t, base, "GET", "/auth/me", nil, logged.Token, 200)
	equalValue(t, me.Participant, f.human)
	page := testHTTPJSON[handler.MessagePage](t, base, "GET", fmt.Sprintf("/conversations/%s/messages", group.ConversationID), nil, logged.Token, 200)
	equalValue(t, page.Messages, []model.Message{message})
	equalValue(t, f.count(t, "SELECT COUNT(*) FROM participants"), int64(4))
	equalValue(t, f.count(t, "SELECT COUNT(*) FROM participant_accounts"), int64(4))
}
