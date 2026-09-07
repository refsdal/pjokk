package api_test

import (
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Issue #52: ?q searches the free text of every kind, case-insensitively,
// with ILIKE wildcards treated as literals.
func TestListTimelineSearch(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	at := func(h int) string { return time.Date(2026, 3, 10, h, 0, 0, 0, time.UTC).Format(time.RFC3339) }
	post := func(path string, body map[string]any) {
		t.Helper()
		body["babyId"] = babyID
		if res := a.Do(http.MethodPost, path, cookie, body); res.Status != http.StatusCreated {
			t.Fatalf("%s: %d %s", path, res.Status, res.Raw)
		}
	}
	post("/api/feeds", map[string]any{"time": at(8), "type": "solids", "food": "Avocado", "notes": "small REACTION on the cheek"})
	post("/api/feeds", map[string]any{"time": at(9), "type": "bottle", "amountMl": 100})
	post("/api/medicine", map[string]any{"time": at(10), "name": "Ibuprofen", "amount": 2.5, "unit": "ml"})
	post("/api/notes", map[string]any{"time": at(11), "content": "Slept badly, 100% grumpy"})
	post("/api/sleep", map[string]any{"startTime": at(12), "endTime": at(13), "location": "Pram", "notes": "avocado dream"})

	titles := func(q string, filter string) []string {
		t.Helper()
		v := url.Values{"babyId": {babyID}, "q": {q}}
		if filter != "" {
			v.Set("filter", filter)
		}
		res := a.Do(http.MethodGet, "/api/timeline?"+v.Encode(), cookie, nil)
		if res.Status != http.StatusOK {
			t.Fatalf("search %q: %d %s", q, res.Status, res.Raw)
		}
		entries, _ := res.JSON["entries"].([]any)
		var out []string
		for _, e := range entries {
			m, _ := e.(map[string]any)
			out = append(out, m["kind"].(string))
		}
		return out
	}
	if got := titles("reaction", ""); len(got) != 1 || got[0] != "feed" {
		t.Errorf("reaction = %v, want the solids feed", got)
	}
	if got := titles("avocado", ""); len(got) != 2 || got[0] != "sleep" || got[1] != "feed" {
		t.Errorf("avocado = %v, want the sleep note then the feed food", got)
	}
	if got := titles("ibuprofen", ""); len(got) != 1 || got[0] != "medicine" {
		t.Errorf("ibuprofen = %v, want the medicine", got)
	}
	if got := titles("100%", ""); len(got) != 1 || got[0] != "note" {
		t.Errorf("100%% = %v, want only the note (the wildcard is literal)", got)
	}
	if got := titles("pram", "sleep"); len(got) != 1 || got[0] != "sleep" {
		t.Errorf("pram with filter=sleep = %v", got)
	}
	if got := titles("avocado", "sleep"); len(got) != 1 {
		t.Errorf("avocado with filter=sleep = %v, want only the sleep", got)
	}
	if got := titles("zzz", ""); len(got) != 0 {
		t.Errorf("no match = %v, want empty", got)
	}
}
