package tests

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEntrypointRequiresConfiguration(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "trigger")
	buildContext, cancelBuild := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancelBuild()
	if output, err := exec.CommandContext(buildContext, "go", "build", "-o", binary, "../cmd").CombinedOutput(); err != nil {
		t.Fatalf("build entrypoint: %v\n%s", err, output)
	}
	t.Setenv("TRIGGER_CONFIG", filepath.Join(t.TempDir(), "missing.json"))
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, binary).CombinedOutput()
	var exitError *exec.ExitError
	if ctx.Err() != nil || !errors.As(err, &exitError) || exitError.ExitCode() != 1 {
		t.Fatalf("unconfigured entrypoint must exit 1: %v\n%s", err, output)
	}
	for _, message := range []string{"TRIGGER_CONFIG", "未启动 HTTP 监听"} {
		if !strings.Contains(string(output), message) {
			t.Fatalf("missing configuration failure detail %q: %s", message, output)
		}
	}
}
