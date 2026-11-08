package tests

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEntrypointReportsNotReady(t *testing.T) {
	t.Setenv("IM_CONFIG", filepath.Join(t.TempDir(), "missing.json"))
	binary := filepath.Join(t.TempDir(), "im")
	buildContext, cancelBuild := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancelBuild()
	if output, err := exec.CommandContext(buildContext, "go", "build", "-o", binary, "../cmd").CombinedOutput(); err != nil {
		t.Fatalf("build entrypoint: %v\n%s", err, output)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binary)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err := command.Run()
	if ctx.Err() != nil {
		t.Fatal("unconfigured entrypoint did not exit promptly")
	}
	var exitError *exec.ExitError
	if !errors.As(err, &exitError) || exitError.ExitCode() != 1 {
		t.Fatalf("unconfigured entrypoint must exit 1: %v\n%s", err, &stderr)
	}
	if stdout.Len() != 0 {
		t.Fatalf("unexpected success output: %s", &stdout)
	}
	for _, text := range []string{"IM 未就绪", "IM_CONFIG", "未启动 HTTP 监听"} {
		if !strings.Contains(stderr.String(), text) {
			t.Fatalf("missing readiness detail %q: %s", text, &stderr)
		}
	}
}
