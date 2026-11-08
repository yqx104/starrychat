package tests

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	"starrychat/backend/im/common"
)

func testID(n int64) string { return fmt.Sprintf("00000000-0000-7000-8000-%012x", n) }

func TestUUIDv7GenerationAndCanonicalValidation(t *testing.T) {
	seen := sync.Map{}
	var workers sync.WaitGroup
	for range 16 {
		workers.Go(func() {
			for range 128 {
				id, err := common.NewID()
				if err != nil || !common.ValidID(id) {
					t.Errorf("invalid generated UUID: %q: %v", id, err)
					return
				}
				if _, duplicate := seen.LoadOrStore(id, true); duplicate {
					t.Errorf("duplicate UUID: %s", id)
				}
			}
		})
	}
	workers.Wait()
	for _, value := range []string{"", "1", "00000000-0000-0000-0000-000000000000", strings.ToUpper(testID(255)), strings.Replace(testID(1), "7000", "4000", 1), strings.ReplaceAll(testID(1), "-", ""), "urn:uuid:" + testID(1), "{" + testID(1) + "}"} {
		if common.ValidID(value) {
			t.Errorf("noncanonical UUID accepted: %q", value)
		}
	}
}
