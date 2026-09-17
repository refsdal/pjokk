package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// The pick-up handover (issue #106, internal/api/handover.go): one document
// over ordinary sleep, feed and diaper rows that carry the day's id.
// -----------------------------------------------------------------------

type handoverRig struct {
	a      *testrig.AppRig
	cookie string
	babyID string
	dayID  string
	start  time.Time
	end    time.Time
}

// A finished seven-hour day, 08:00–15:00 UTC, picked up an hour ago by the
// rig's clock.
func newHandoverRig(t *testing.T) handoverRig {
	t.Helper()
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	start := time.Date(2026, 3, 16, 8, 0, 0, 0, time.UTC)
	end := start.Add(7 * time.Hour)
	a.SetNow(end.Add(time.Hour))
	day := a.Do(http.MethodPost, "/api/daycare", cookie, map[string]any{"babyId": babyID, "startTime": rfc(start), "endTime": rfc(end)})
	if day.Status != http.StatusCreated {
		t.Fatalf("seed day: %d %s", day.Status, day.Raw)
	}
	id, _ := day.JSON["id"].(string)
	return handoverRig{a: a, cookie: cookie, babyID: babyID, dayID: id, start: start, end: end}
}

func (h handoverRig) put(t *testing.T, body map[string]any) *testrig.Result {
	t.Helper()
	return h.a.Do(http.MethodPut, "/api/daycare/"+h.dayID+"/handover", h.cookie, body)
}

func (h handoverRig) usual() map[string]any {
	return map[string]any{
		"naps":    []any{map[string]any{"startTime": rfc(h.start.Add(3*time.Hour + 40*time.Minute)), "endTime": rfc(h.start.Add(5*time.Hour + 10*time.Minute))}},
		"meals":   []any{map[string]any{"time": rfc(h.start.Add(3 * time.Hour)), "appetite": "well", "food": "Fish cakes"}},
		"diapers": map[string]any{"wet": 2, "dirty": 1},
		"mood":    "good",
	}
}

func (h handoverRig) list(t *testing.T, path string) []any {
	t.Helper()
	res := h.a.DoArray(http.MethodGet, path+"?babyId="+h.babyID, h.cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("GET %s: %d %s", path, res.Status, res.Raw)
	}
	return res.JSON
}

func TestHandoverWritesOrdinaryRowsThatKnowTheirDay(t *testing.T) {
	h := newHandoverRig(t)

	empty := h.a.Do(http.MethodGet, "/api/daycare/"+h.dayID+"/handover", h.cookie, nil)
	if empty.Status != http.StatusOK || len(empty.JSON["naps"].([]any)) != 0 || empty.JSON["mood"] != nil {
		t.Fatalf("handover before any = %d %s, want the empty document", empty.Status, empty.Raw)
	}

	saved := h.put(t, h.usual())
	if saved.Status != http.StatusOK {
		t.Fatalf("PUT status = %d, body %s", saved.Status, saved.Raw)
	}
	diapers, _ := saved.JSON["diapers"].(map[string]any)
	if len(saved.JSON["naps"].([]any)) != 1 || len(saved.JSON["meals"].([]any)) != 1 || diapers["wet"] != float64(2) || diapers["dirty"] != float64(1) || saved.JSON["mood"] != "good" {
		t.Errorf("PUT echoed %s", saved.Raw)
	}

	sleeps := h.list(t, "/api/sleep")
	if len(sleeps) != 1 {
		t.Fatalf("sleeps = %d, want 1", len(sleeps))
	}
	nap := sleeps[0].(map[string]any)
	if nap["daycareId"] != h.dayID || nap["type"] != "nap" || nap["location"] != "Barnehage" || nap["endTime"] == nil {
		t.Errorf("nap row = %v", nap)
	}

	feeds := h.list(t, "/api/feeds")
	meal := feeds[0].(map[string]any)
	if len(feeds) != 1 || meal["daycareId"] != h.dayID || meal["type"] != "solids" || meal["appetite"] != "well" || meal["food"] != "Fish cakes" || meal["amountMl"] != nil {
		t.Errorf("meal rows = %v", feeds)
	}

	// Three nappies spread evenly inside the day, wet first: a quarter, a
	// half and three quarters of the way through.
	rows := h.list(t, "/api/diapers")
	if len(rows) != 3 {
		t.Fatalf("diapers = %d, want 3", len(rows))
	}
	span := h.end.Sub(h.start)
	for i, want := range []struct {
		kind string
		at   time.Time
	}{{"dirty", h.start.Add(span * 3 / 4)}, {"wet", h.start.Add(span / 2)}, {"wet", h.start.Add(span / 4)}} { // newest first
		row := rows[i].(map[string]any)
		got, _ := time.Parse(time.RFC3339, row["time"].(string))
		if row["type"] != want.kind || !got.Equal(want.at) || row["daycareId"] != h.dayID {
			t.Errorf("diaper %d = %v at %v, want %s at %v", i, row["type"], got, want.kind, want.at)
		}
	}

	// On the timeline too, and the day carries its mood.
	tl := h.a.Do(http.MethodGet, "/api/timeline?babyId="+h.babyID, h.cookie, nil)
	linked := 0
	for _, e := range tl.JSON["entries"].([]any) {
		m := e.(map[string]any)
		if m["daycareId"] == h.dayID {
			linked++
		}
		if m["kind"] == "daycare" && m["mood"] != "good" {
			t.Errorf("timeline day mood = %v, want good", m["mood"])
		}
	}
	if linked != 5 {
		t.Errorf("timeline entries carrying the day's id = %d, want 5", linked)
	}

	// An ordinary row never carries one.
	own := h.a.Do(http.MethodPost, "/api/diapers", h.cookie, map[string]any{"babyId": h.babyID, "time": rfc(h.end.Add(10 * time.Minute)), "type": "wet"})
	if v, present := own.JSON["daycareId"]; !present || v != nil {
		t.Errorf("an ordinary diaper's daycareId = %v (present %v), want an explicit null", v, present)
	}
}

func TestHandoverPutReplacesRatherThanDoubles(t *testing.T) {
	h := newHandoverRig(t)
	for range 2 { // a replayed offline save
		if res := h.put(t, h.usual()); res.Status != http.StatusOK {
			t.Fatalf("PUT = %d %s", res.Status, res.Raw)
		}
	}
	if n := len(h.list(t, "/api/sleep")); n != 1 {
		t.Errorf("sleeps after two identical PUTs = %d, want 1", n)
	}
	if n := len(h.list(t, "/api/diapers")); n != 3 {
		t.Errorf("diapers after two identical PUTs = %d, want 3", n)
	}

	// The family's own rows are never touched by a replace.
	h.a.Do(http.MethodPost, "/api/feeds", h.cookie, map[string]any{"babyId": h.babyID, "time": rfc(h.start.Add(-time.Hour)), "type": "bottle", "amountMl": 150})
	cleared := h.put(t, map[string]any{"naps": []any{}, "meals": []any{}, "diapers": map[string]any{"wet": 0, "dirty": 0}, "mood": nil})
	if cleared.Status != http.StatusOK || cleared.JSON["mood"] != nil {
		t.Fatalf("clearing PUT = %d %s", cleared.Status, cleared.Raw)
	}
	if n := len(h.list(t, "/api/sleep")) + len(h.list(t, "/api/diapers")); n != 0 {
		t.Errorf("linked rows after an empty PUT = %d, want 0", n)
	}
	if feeds := h.list(t, "/api/feeds"); len(feeds) != 1 || feeds[0].(map[string]any)["type"] != "bottle" {
		t.Errorf("feeds after an empty PUT = %v, want the family's own bottle alone", feeds)
	}
}

// A row edited through its own sheet stays in the handover; the document is
// a view over the rows, not a copy of them.
func TestHandoverReadsBackEditedRows(t *testing.T) {
	h := newHandoverRig(t)
	h.put(t, h.usual())
	meal := h.list(t, "/api/feeds")[0].(map[string]any)
	h.a.Do(http.MethodPatch, "/api/feeds/"+meal["id"].(string), h.cookie, map[string]any{"appetite": "little"})
	wet := h.list(t, "/api/diapers")[2].(map[string]any)
	h.a.Do(http.MethodPatch, "/api/diapers/"+wet["id"].(string), h.cookie, map[string]any{"type": "both"})

	got := h.a.Do(http.MethodGet, "/api/daycare/"+h.dayID+"/handover", h.cookie, nil)
	meals, _ := got.JSON["meals"].([]any)
	diapers, _ := got.JSON["diapers"].(map[string]any)
	if meals[0].(map[string]any)["appetite"] != "little" || diapers["wet"] != float64(1) || diapers["dirty"] != float64(2) {
		t.Errorf("handover after edits = %s", got.Raw)
	}
}

func TestHandoverValidation(t *testing.T) {
	h := newHandoverRig(t)
	nap := func(from, to time.Duration) map[string]any {
		return map[string]any{"startTime": rfc(h.start.Add(from)), "endTime": rfc(h.start.Add(to))}
	}
	base := func(over map[string]any) map[string]any {
		body := map[string]any{"naps": []any{}, "meals": []any{}, "diapers": map[string]any{"wet": 0, "dirty": 0}, "mood": nil}
		for k, v := range over {
			body[k] = v
		}
		return body
	}

	backwards := h.put(t, base(map[string]any{"naps": []any{nap(5*time.Hour, 3*time.Hour)}}))
	if backwards.Status != http.StatusBadRequest || backwards.JSON["code"] != "BAD_NAP" {
		t.Errorf("backwards nap = %d %v, want 400 BAD_NAP", backwards.Status, backwards.JSON)
	}
	// A handover is about the hours she was there (08:00–15:00 here).
	for name, body := range map[string]map[string]any{
		"a nap that starts before the drop-off": base(map[string]any{"naps": []any{nap(-10*time.Minute, time.Hour)}}),
		"a nap that ends after the pick-up":     base(map[string]any{"naps": []any{nap(6*time.Hour, 7*time.Hour+time.Minute)}}),
		"a meal after the pick-up":              base(map[string]any{"meals": []any{map[string]any{"time": rfc(h.end.Add(time.Minute)), "appetite": "well"}}}),
	} {
		if res := h.put(t, body); res.Status != http.StatusBadRequest || res.JSON["code"] != "OUTSIDE_DAY" {
			t.Errorf("%s = %d %v, want 400 OUTSIDE_DAY", name, res.Status, res.JSON)
		}
	}
	// The edges themselves are inside.
	if res := h.put(t, base(map[string]any{"naps": []any{nap(0, 7*time.Hour)}})); res.Status != http.StatusOK {
		t.Errorf("a nap from drop-off to pick-up = %d %s, want 200", res.Status, res.Raw)
	}
	h.put(t, base(nil))

	for name, body := range map[string]map[string]any{
		"five naps":       base(map[string]any{"naps": []any{nap(1, 2), nap(1, 2), nap(1, 2), nap(1, 2), nap(1, 2)}}),
		"eleven nappies":  base(map[string]any{"diapers": map[string]any{"wet": 11, "dirty": 0}}),
		"an unknown mood": base(map[string]any{"mood": "ecstatic"}),
		"no diapers key":  {"naps": []any{}, "meals": []any{}, "mood": nil},
	} {
		if res := h.put(t, body); res.Status != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400 from spec validation", name, res.Status)
		}
	}
	if n := len(h.list(t, "/api/sleep")); n != 0 {
		t.Errorf("a refused handover wrote %d sleeps", n)
	}
}

func TestHandoverIsFamilyScoped(t *testing.T) {
	h := newHandoverRig(t)
	_, other := h.a.NewFamily("Olsen", "other@example.com")
	if res := h.a.Do(http.MethodGet, "/api/daycare/"+h.dayID+"/handover", other, nil); res.Status != http.StatusNotFound {
		t.Errorf("GET across families = %d, want 404", res.Status)
	}
	if res := h.a.Do(http.MethodPut, "/api/daycare/"+h.dayID+"/handover", other, h.usual()); res.Status != http.StatusNotFound {
		t.Errorf("PUT across families = %d, want 404", res.Status)
	}
	if n := len(h.list(t, "/api/sleep")); n != 0 {
		t.Errorf("a cross-family PUT wrote %d sleeps", n)
	}
}

// Deleting the day keeps what happened during it: the rows stay, unlinked.
func TestHandoverRowsSurviveTheirDay(t *testing.T) {
	h := newHandoverRig(t)
	h.put(t, h.usual())
	if res := h.a.Do(http.MethodDelete, "/api/daycare/"+h.dayID, h.cookie, nil); res.Status != http.StatusOK {
		t.Fatalf("delete day = %d", res.Status)
	}
	sleeps := h.list(t, "/api/sleep")
	if len(sleeps) != 1 || sleeps[0].(map[string]any)["daycareId"] != nil {
		t.Errorf("sleeps after deleting the day = %v, want the nap, unlinked", sleeps)
	}
}

func TestSummaryOffersTheHandoverUntilItIsAnswered(t *testing.T) {
	h := newHandoverRig(t)
	due := func() any {
		t.Helper()
		s := h.a.Do(http.MethodGet, "/api/summary?babyId="+h.babyID, h.cookie, nil)
		v, present := s.JSON["handoverDue"]
		if !present {
			t.Fatalf("summary has no handoverDue key: %s", s.Raw)
		}
		return v
	}
	if day, _ := due().(map[string]any); day == nil || day["id"] != h.dayID {
		t.Fatalf("handoverDue an hour after pick-up = %v, want the day", due())
	}
	// A mood alone is an answer.
	h.put(t, map[string]any{"naps": []any{}, "meals": []any{}, "diapers": map[string]any{"wet": 0, "dirty": 0}, "mood": "ok"})
	if due() != nil {
		t.Errorf("handoverDue after a mood = %v, want null", due())
	}
	// So are rows alone; and an emptied handover is due again.
	h.put(t, map[string]any{"naps": []any{}, "meals": []any{}, "diapers": map[string]any{"wet": 1, "dirty": 0}, "mood": nil})
	if due() != nil {
		t.Errorf("handoverDue after a nappy = %v, want null", due())
	}
	h.put(t, map[string]any{"naps": []any{}, "meals": []any{}, "diapers": map[string]any{"wet": 0, "dirty": 0}, "mood": nil})
	if due() == nil {
		t.Errorf("handoverDue after emptying it = null, want the day again")
	}
	// Not the next morning.
	h.a.SetNow(h.end.Add(13 * time.Hour))
	if due() != nil {
		t.Errorf("handoverDue 13 h after pick-up = %v, want null", due())
	}
	// And never while she is still there.
	h.a.SetNow(h.end.Add(time.Hour))
	h.a.Do(http.MethodPatch, "/api/daycare/"+h.dayID, h.cookie, map[string]any{"endTime": nil})
	if due() != nil {
		t.Errorf("handoverDue for a running day = %v, want null", due())
	}
}
