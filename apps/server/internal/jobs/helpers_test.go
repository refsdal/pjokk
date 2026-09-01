package jobs_test

import (
	"context"
	"io"
	"sort"
	"strings"
	"testing"

	"github.com/refsdal/pjokk/server/internal/storage"
)

// jsonBody is a fresh reader over a placeholder JSON body — good enough for
// seeding a storage fixture whose content pruneBackups never inspects.
func jsonBody() io.Reader { return strings.NewReader("{}") }

func listKeys(t *testing.T, mem *storage.Memory, prefix string) []string {
	t.Helper()
	objs, err := mem.List(context.Background(), prefix)
	if err != nil {
		t.Fatalf("list %q: %v", prefix, err)
	}
	keys := make([]string, len(objs))
	for i, o := range objs {
		keys[i] = o.Key
	}
	return keys
}

func assertSameSet(t *testing.T, got, want []string) {
	t.Helper()
	g := append([]string(nil), got...)
	w := append([]string(nil), want...)
	sort.Strings(g)
	sort.Strings(w)
	if len(g) != len(w) {
		t.Errorf("got %v, want %v", got, want)
		return
	}
	for i := range g {
		if g[i] != w[i] {
			t.Errorf("got %v, want %v", got, want)
			return
		}
	}
}

func assertContains(t *testing.T, haystack []string, needle string) {
	t.Helper()
	for _, s := range haystack {
		if s == needle {
			return
		}
	}
	t.Errorf("%v does not contain %q", haystack, needle)
}

func assertNotContains(t *testing.T, haystack []string, needle string) {
	t.Helper()
	for _, s := range haystack {
		if s == needle {
			t.Errorf("%v unexpectedly contains %q", haystack, needle)
			return
		}
	}
}
