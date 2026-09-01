package api_test

import (
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Timeline — ports apps/api/test/timeline.test.ts in full (merge order
// across kinds, cursor pagination stability including single-kind tails and
// a mixed-kind page where no single source fills the quota, filter chips,
// family scoping) plus apps/api/test/defects.test.ts's "timeline
// same-timestamp pagination" regression.
// -----------------------------------------------------------------------

// timelineSeedDay ports timeline.test.ts's seedDay: 5 entries spread across
// 6 hours — 2 feeds, 1 diaper, 2 sleeps (one completed, one still active) —
// newest-first order once merged: sleep(active), feed, sleep(completed),
// diaper, feed.
func timelineSeedDay(t *testing.T, a *testrig.AppRig, cookie, babyID string, now time.Time) {
	t.Helper()
	H := time.Hour
	post := func(path string, body map[string]any) {
		t.Helper()
		res := a.Do(http.MethodPost, path, cookie, body)
		if res.Status != http.StatusCreated {
			t.Fatalf("seed POST %s status = %d, body %s", path, res.Status, res.Raw)
		}
	}
	post("/api/feeds", map[string]any{
		"babyId": babyID, "time": now.Add(-6 * H).Format(time.RFC3339),
		"type": "bottle", "amountMl": 120,
	})
	post("/api/diapers", map[string]any{
		"babyId": babyID, "time": now.Add(-5 * H).Format(time.RFC3339),
		"type": "wet",
	})
	post("/api/sleep", map[string]any{
		"babyId": babyID, "startTime": now.Add(-4 * H).Format(time.RFC3339),
		"endTime": now.Add(-3 * H).Format(time.RFC3339),
	})
	post("/api/feeds", map[string]any{
		"babyId": babyID, "time": now.Add(-2 * H).Format(time.RFC3339),
		"type": "breast", "side": "left", "durationMin": 15,
	})
	post("/api/sleep", map[string]any{
		"babyId": babyID, "startTime": now.Add(-1 * H).Format(time.RFC3339),
	}) // active, no endTime
}

func timelineEntryKinds(entries []any) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i], _ = e.(map[string]any)["kind"].(string)
	}
	return out
}

func TestTimelineMergesAllKindsNewestFirstSleepByStartTime(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	timelineSeedDay(t, a, cookie, babyID, time.Now())

	res := a.Do(http.MethodGet, "/api/timeline?babyId="+babyID, cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	entries, _ := res.JSON["entries"].([]any)

	want := []string{"sleep", "feed", "sleep", "diaper", "feed"}
	if got := timelineEntryKinds(entries); !reflect.DeepEqual(got, want) {
		t.Fatalf("kinds = %v, want %v", got, want)
	}
	if res.JSON["nextCursor"] != nil {
		t.Errorf("nextCursor = %v, want null (only 5 entries, well under the default 50-row page)", res.JSON["nextCursor"])
	}

	active, _ := entries[0].(map[string]any)
	if active["kind"] != "sleep" || active["endTime"] != nil {
		t.Errorf("entries[0] = %v, want the active sleep (kind sleep, endTime null)", active)
	}
	for _, e := range entries {
		if m, _ := e.(map[string]any); m["caretakerName"] != "Rig admin" {
			t.Errorf("caretakerName = %v, want %q", m["caretakerName"], "Rig admin")
		}
	}
}

func TestTimelineFiltersByKind(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	timelineSeedDay(t, a, cookie, babyID, time.Now())

	feeds := a.Do(http.MethodGet, "/api/timeline?babyId="+babyID+"&filter=feeds", cookie, nil)
	if feeds.Status != http.StatusOK {
		t.Fatalf("filter=feeds status = %d, body %s", feeds.Status, feeds.Raw)
	}
	feedEntries, _ := feeds.JSON["entries"].([]any)
	if len(feedEntries) != 2 {
		t.Fatalf("filter=feeds entries = %v, want 2", feedEntries)
	}
	for _, e := range feedEntries {
		if m, _ := e.(map[string]any); m["kind"] != "feed" {
			t.Errorf("kind = %v, want feed", m["kind"])
		}
	}

	sleep := a.Do(http.MethodGet, "/api/timeline?babyId="+babyID+"&filter=sleep", cookie, nil)
	if sleep.Status != http.StatusOK {
		t.Fatalf("filter=sleep status = %d, body %s", sleep.Status, sleep.Raw)
	}
	sleepEntries, _ := sleep.JSON["entries"].([]any)
	if len(sleepEntries) != 2 {
		t.Fatalf("filter=sleep entries = %v, want 2", sleepEntries)
	}
}

// Ports "paginates with a before-cursor, including single-kind tails": 5
// feeds only, limit=2 — the naive "merged length > page length" hasMore
// check would stall after the first page since the merge never holds more
// than the single source's own rows.
func TestTimelinePaginatesWithBeforeCursorSingleKindTails(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	now := time.Now()

	for i := 0; i < 5; i++ {
		res := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
			"babyId":   babyID,
			"time":     now.Add(-time.Duration(i) * time.Hour).Format(time.RFC3339),
			"type":     "bottle",
			"amountMl": 100 + i,
		})
		if res.Status != http.StatusCreated {
			t.Fatalf("seed POST %d status = %d, body %s", i, res.Status, res.Raw)
		}
	}

	var seen []float64
	cursor := ""
	for page := 0; page < 5; page++ {
		path := fmt.Sprintf("/api/timeline?babyId=%s&limit=2", babyID)
		if cursor != "" {
			path += "&before=" + url.QueryEscape(cursor)
		}
		res := a.Do(http.MethodGet, path, cookie, nil)
		if res.Status != http.StatusOK {
			t.Fatalf("page %d status = %d, body %s", page, res.Status, res.Raw)
		}
		entries, _ := res.JSON["entries"].([]any)
		for _, e := range entries {
			m, _ := e.(map[string]any)
			if m["kind"] != "feed" {
				t.Fatalf("kind = %v, want feed", m["kind"])
			}
			seen = append(seen, m["amountMl"].(float64))
		}
		nc, _ := res.JSON["nextCursor"].(string)
		cursor = nc
		if cursor == "" {
			break
		}
	}
	want := []float64{100, 101, 102, 103, 104}
	if !reflect.DeepEqual(seen, want) {
		t.Errorf("seen = %v, want %v (newest-first across pages == ascending amountMl here)", seen, want)
	}
}

// Ports "paginates a mixed-kind page where no single source fills the
// quota": seedDay's 5 entries (2 feeds, 1 diaper, 2 sleeps), limit=3.
func TestTimelinePaginatesMixedKindPageNoSingleSourceFillsQuota(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	timelineSeedDay(t, a, cookie, babyID, time.Now())

	first := a.Do(http.MethodGet, "/api/timeline?babyId="+babyID+"&limit=3", cookie, nil)
	if first.Status != http.StatusOK {
		t.Fatalf("first page status = %d, body %s", first.Status, first.Raw)
	}
	firstEntries, _ := first.JSON["entries"].([]any)
	if len(firstEntries) != 3 {
		t.Fatalf("first page entries = %v, want 3", firstEntries)
	}
	nextCursor, _ := first.JSON["nextCursor"].(string)
	if nextCursor == "" {
		t.Fatalf("first page nextCursor = %v, want non-null", first.JSON["nextCursor"])
	}

	second := a.Do(http.MethodGet, "/api/timeline?babyId="+babyID+"&limit=3&before="+url.QueryEscape(nextCursor), cookie, nil)
	if second.Status != http.StatusOK {
		t.Fatalf("second page status = %d, body %s", second.Status, second.Raw)
	}
	secondEntries, _ := second.JSON["entries"].([]any)
	if len(secondEntries) != 2 {
		t.Fatalf("second page entries = %v, want 2", secondEntries)
	}

	all := append(append([]any{}, firstEntries...), secondEntries...)
	want := []string{"sleep", "feed", "sleep", "diaper", "feed"}
	if got := timelineEntryKinds(all); !reflect.DeepEqual(got, want) {
		t.Errorf("kinds across both pages = %v, want %v", got, want)
	}
}

func TestTimelineIsFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")
	babyA := a.NewBaby(familyA, "Baby A")
	timelineSeedDay(t, a, cookieA, babyA, time.Now())

	// B can't read A's baby timeline at all.
	res := a.Do(http.MethodGet, "/api/timeline?babyId="+babyA, cookieB, nil)
	if res.Status != http.StatusNotFound {
		t.Errorf("cross-family status = %d, want 404", res.Status)
	}
}

func TestTimelineUnknownBabyIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodGet, "/api/timeline?babyId=does-not-exist", cookie, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Unknown baby" || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Unknown baby\",code:\"NOT_FOUND\"}", res.JSON)
	}
}

func TestTimelineRejectsUnauthenticated(t *testing.T) {
	a := testrig.App(t)
	res := a.Do(http.MethodGet, "/api/timeline?babyId=whatever", "", nil)
	if res.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", res.Status)
	}
}

// Ports defects.test.ts's "timeline same-timestamp pagination" — "never
// drops entries sharing the page-boundary timestamp". Three feeds: one
// newer, two sharing an exact timestamp a minute earlier. With limit=2 the
// tied pair straddles a page boundary; the (time,id) row-comparison cursor
// (internal/db/queries/timeline.sql) is what keeps this lossless — a naive
// "time < cursor" clause would drop or duplicate whichever of the tied pair
// landed on the cut.
func TestTimelineSameTimestampPaginationNeverDropsEntries(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	t0 := time.Now()

	mk := func(when time.Time, ml int) {
		t.Helper()
		res := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
			"babyId":   babyID,
			"time":     when.Format(time.RFC3339),
			"type":     "bottle",
			"amountMl": ml,
		})
		if res.Status != http.StatusCreated {
			t.Fatalf("seed POST status = %d, body %s", res.Status, res.Raw)
		}
	}
	mk(t0, 100)
	mk(t0.Add(-time.Minute), 101)
	mk(t0.Add(-time.Minute), 102)

	var seen []float64
	cursor := ""
	for i := 0; i < 5; i++ {
		path := fmt.Sprintf("/api/timeline?babyId=%s&limit=2", babyID)
		if cursor != "" {
			path += "&before=" + url.QueryEscape(cursor)
		}
		res := a.Do(http.MethodGet, path, cookie, nil)
		if res.Status != http.StatusOK {
			t.Fatalf("page %d status = %d, body %s", i, res.Status, res.Raw)
		}
		entries, _ := res.JSON["entries"].([]any)
		for _, e := range entries {
			m, _ := e.(map[string]any)
			if m["kind"] == "feed" {
				seen = append(seen, m["amountMl"].(float64))
			}
		}
		nc, _ := res.JSON["nextCursor"].(string)
		cursor = nc
		if cursor == "" {
			break
		}
	}
	sort.Float64s(seen)
	want := []float64{100, 101, 102}
	if !reflect.DeepEqual(seen, want) {
		t.Errorf("seen (sorted) = %v, want %v", seen, want)
	}
}

// A stricter variant of the same-timestamp regression above: FIVE feeds
// share one exact timestamp, with limit=2 — so the tied group itself spans
// three page boundaries, not just one. Every id is a fresh UUID, so the
// (time,id) row-comparison cursor still gives a strict total order; this
// proves that holds for a tie wider than the page size, not just the
// two-row case defects.test.ts happens to use.
func TestTimelineManySameTimestampRowsPaginateWithoutLossOrDuplication(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	when := time.Now().Format(time.RFC3339)

	for i := 0; i < 5; i++ {
		res := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
			"babyId":   babyID,
			"time":     when,
			"type":     "bottle",
			"amountMl": 200 + i,
		})
		if res.Status != http.StatusCreated {
			t.Fatalf("seed POST %d status = %d, body %s", i, res.Status, res.Raw)
		}
	}

	var seen []float64
	cursor := ""
	for page := 0; page < 10; page++ {
		path := fmt.Sprintf("/api/timeline?babyId=%s&limit=2", babyID)
		if cursor != "" {
			path += "&before=" + url.QueryEscape(cursor)
		}
		res := a.Do(http.MethodGet, path, cookie, nil)
		if res.Status != http.StatusOK {
			t.Fatalf("page %d status = %d, body %s", page, res.Status, res.Raw)
		}
		entries, _ := res.JSON["entries"].([]any)
		if len(entries) == 0 {
			t.Fatalf("page %d: empty page while a cursor was still supplied — hasMore lied", page)
		}
		for _, e := range entries {
			m, _ := e.(map[string]any)
			seen = append(seen, m["amountMl"].(float64))
		}
		nc, _ := res.JSON["nextCursor"].(string)
		cursor = nc
		if cursor == "" {
			break
		}
	}
	sort.Float64s(seen)
	want := []float64{200, 201, 202, 203, 204}
	if !reflect.DeepEqual(seen, want) {
		t.Errorf("seen (sorted) = %v, want %v (no entry lost or duplicated across a tie wider than the page size)", seen, want)
	}
}
