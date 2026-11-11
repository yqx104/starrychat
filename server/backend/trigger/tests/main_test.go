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

func TestEntrypointRequiresConfiguration(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "trigger")
	buildContext, cancelBuild := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancelBuild()
	if output, err := exec.CommandContext(buildContext, "go", "build", "-o", binary, "../cmd").CombinedOutput(); err != nil {
		t.Fatalf("build entrypoint: %v\n%s", err, output)
	}
	incomplete := filepath.Join(t.TempDir(), "missing-im-url.json")
	if err := os.WriteFile(incomplete, []byte(`{"mysql_dsn":"unused"}`), 0600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ name, path, detail string }{
		{"missing_file", filepath.Join(t.TempDir(), "missing.json"), "TRIGGER_CONFIG"},
		{"missing_im_base_url", incomplete, "requires im_base_url"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("TRIGGER_CONFIG", test.path)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			output, err := exec.CommandContext(ctx, binary).CombinedOutput()
			var exitError *exec.ExitError
			if ctx.Err() != nil || !errors.As(err, &exitError) || exitError.ExitCode() != 1 {
				t.Fatalf("unconfigured entrypoint must exit 1: %v\n%s", err, output)
			}
			for _, message := range []string{test.detail, "未启动 HTTP 监听"} {
				if !strings.Contains(string(output), message) {
					t.Fatalf("missing configuration failure detail %q: %s", message, output)
				}
			}
		})
	}
}
