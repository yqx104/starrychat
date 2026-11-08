package tests

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type mysqlInstance struct {
	socket string
	query  func(string, string) (string, error)
}

func startMySQL(t *testing.T) *mysqlInstance {
	if os.Getenv("TRIGGER_TEST_MYSQL") != "1" {
		t.Skip("set TRIGGER_TEST_MYSQL=1 to validate against an isolated temporary MySQL instance")
	}
	mysqld, err := exec.LookPath("mysqld")
	if err != nil {
		t.Fatal(err)
	}
	mysql, err := exec.LookPath("mysql")
	if err != nil {
		t.Fatal(err)
	}
	// A short path also fits macOS's Unix socket path limit.
	directory, err := os.MkdirTemp("/tmp", "yqx-trigger-mysql-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(directory); err != nil {
			t.Error(err)
		}
	})
	datadir := filepath.Join(directory, "data")
	socket := filepath.Join(directory, "mysql.sock")
	logPath := filepath.Join(directory, "mysql.log")
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	initialize := exec.CommandContext(ctx, mysqld, "--no-defaults", "--initialize-insecure", "--datadir="+datadir, "--log-error="+logPath)
	if output, err := initialize.CombinedOutput(); err != nil {
		log, _ := os.ReadFile(logPath)
		t.Fatalf("initialize temporary MySQL: %v\n%s\n%s", err, output, log)
	}
	serverOutput, err := os.Create(filepath.Join(directory, "server-output.log"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = serverOutput.Close() })
	server := exec.Command(mysqld, "--no-defaults", "--datadir="+datadir, "--socket="+socket,
		"--pid-file="+filepath.Join(directory, "mysql.pid"), "--log-error="+logPath,
		"--skip-networking", "--mysqlx=OFF", "--skip-log-bin", "--innodb-buffer-pool-size=64M")
	server.Stdout, server.Stderr = serverOutput, serverOutput
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- server.Wait() }()
	stopped := false
	query := func(sql string, database string) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		args := []string{"--no-defaults", "--no-login-paths", "--protocol=SOCKET", "--socket=" + socket,
			"--user=root", "--skip-password", "--default-character-set=utf8mb4", "--batch", "--raw", "--skip-column-names"}
		if database != "" {
			args = append(args, "--database="+database)
		}
		args = append(args, "--execute", sql)
		output, err := exec.CommandContext(ctx, mysql, args...).Output()
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			output = append(output, exitError.Stderr...)
		}
		return strings.TrimSpace(string(output)), err
	}
	t.Cleanup(func() {
		if stopped {
			return
		}
		_, _ = query("SHUTDOWN", "")
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			_ = server.Process.Kill()
			<-done
			t.Error("temporary MySQL needed forced shutdown")
		}
	})
	deadline := time.Now().Add(30 * time.Second)
	for {
		select {
		case err := <-done:
			stopped = true
			log, _ := os.ReadFile(logPath)
			t.Fatalf("temporary MySQL exited: %v\n%s", err, log)
		default:
		}
		if _, err := query("SELECT 1", ""); err == nil {
			break
		}
		if time.Now().After(deadline) {
			log, _ := os.ReadFile(logPath)
			t.Fatalf("temporary MySQL did not become ready\n%s", log)
		}
		time.Sleep(100 * time.Millisecond)
	}
	return &mysqlInstance{socket: socket, query: query}
}
