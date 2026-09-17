package api_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Illness episodes (issue #107, internal/api/illness.go). The lifecycle
// mirrors daycare_test.go's; the rest covers what an illness has of its
// own: the symptom set, the last-symptom clock's two inputs, and the fact
// that the server stores both and concludes nothing.
// -----------------------------------------------------------------------

func TestIllnessOpenTrackAndRecover(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	start := time.Now().Add(-30 * time.Hour).Truncate(time.Second)

	opened := a.Do(http.MethodPost, "/api/illness", cookie, map[string]any{
		"babyId": babyID, "startTime": rfc(start), "symptoms": []string{"vomiting", "fever"}, "clearHours": 48,
	})
	if opened.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", opened.Status, opened.Raw)
	}
	if opened.JSON["endTime"] != nil || opened.JSON["lastSymptomAt"] != nil || opened.JSON["clearHours"] != float64(48) {
		t.Errorf("opened = %v, want endTime and lastSymptomAt null, clearHours 48", opened.JSON)
	}
	if got, _ := opened.JSON["symptoms"].([]any); len(got) != 2 || got[0] != "vomiting" || got[1] != "fever" {
		t.Errorf("symptoms = %v, want [vomiting fever] in the order given", opened.JSON["symptoms"])
	}
	id, _ := opened.JSON["id"].(string)

	summary := a.Do(http.MethodGet, "/api/summary?babyId="+babyID, cookie, nil)
	if ill, _ := summary.JSON["activeIllness"].(map[string]any); ill == nil || ill["id"] != id {
		t.Errorf("summary.activeIllness = %v, want the open episode", summary.JSON["activeIllness"])
	}

	// Symptom-free now; then a relapse; the server stores what it is told.
	free := time.Now().Add(-6 * time.Hour).Truncate(time.Second)
	patched := a.Do(http.MethodPatch, "/api/illness/"+id, cookie, map[string]any{"lastSymptomAt": rfc(free)})
	if got, _ := time.Parse(time.RFC3339, patched.JSON["lastSymptomAt"].(string)); patched.Status != http.StatusOK || !got.Equal(free) {
		t.Errorf("symptom-free patch = %d %v", patched.Status, patched.JSON["lastSymptomAt"])
	}
	relapse := a.Do(http.MethodPatch, "/api/illness/"+id, cookie, map[string]any{"lastSymptomAt": nil, "symptoms": []string{"vomiting", "fever", "diarrhoea"}})
	if relapse.JSON["lastSymptomAt"] != nil || len(relapse.JSON["symptoms"].([]any)) != 3 {
		t.Errorf("relapse patch = %v", relapse.JSON)
	}
	noClock := a.Do(http.MethodPatch, "/api/illness/"+id, cookie, map[string]any{"clearHours": nil, "symptoms": []string{}})
	if noClock.JSON["clearHours"] != nil || len(noClock.JSON["symptoms"].([]any)) != 0 {
		t.Errorf("clearing the clock and the symptoms = %v", noClock.JSON)
	}

	recovered := a.Do(http.MethodPost, "/api/illness/"+id+"/recover", cookie, nil)
	if recovered.Status != http.StatusOK || recovered.JSON["endTime"] == nil {
		t.Fatalf("recover = %d %s", recovered.Status, recovered.Raw)
	}
	if again := a.Do(http.MethodPost, "/api/illness/"+id+"/recover", cookie, nil); again.Status != http.StatusNotFound {
		t.Errorf("second recover = %d, want 404", again.Status)
	}
	if active := a.Do(http.MethodGet, "/api/illness/active?babyId="+babyID, cookie, nil); string(active.Raw) != "null" {
		t.Errorf("active after recovery = %s, want bare null", active.Raw)
	}
	summary = a.Do(http.MethodGet, "/api/summary?babyId="+babyID, cookie, nil)
	if v, present := summary.JSON["activeIllness"]; !present || v != nil {
		t.Errorf("summary.activeIllness after recovery = %v (present %v), want an explicit null", v, present)
	}
}

func TestIllnessOneOpenEpisodePerBaby(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	body := map[string]any{"babyId": babyID, "startTime": rfc(time.Now().Add(-time.Hour))}

	first := a.Do(http.MethodPost, "/api/illness", cookie, body)
	if first.Status != http.StatusCreated {
		t.Fatalf("first = %d %s", first.Status, first.Raw)
	}
	if got, _ := first.JSON["symptoms"].([]any); got == nil || len(got) != 0 {
		t.Errorf("symptoms when none were sent = %v, want an empty array, never null", first.JSON["symptoms"])
	}
	if second := a.Do(http.MethodPost, "/api/illness", cookie, body); second.Status != http.StatusConflict || second.JSON["code"] != "ALREADY_ACTIVE" {
		t.Errorf("second open episode = %d %v, want 409 ALREADY_ACTIVE", second.Status, second.JSON)
	}
	// One that is already over is no obstacle, and cannot be reopened beside it.
	past := a.Do(http.MethodPost, "/api/illness", cookie, map[string]any{
		"babyId": babyID, "startTime": rfc(time.Now().Add(-240 * time.Hour)), "endTime": rfc(time.Now().Add(-200 * time.Hour)), "symptoms": []string{"cold"},
	})
	if past.Status != http.StatusCreated {
		t.Fatalf("a finished episode = %d %s", past.Status, past.Raw)
	}
	pastID, _ := past.JSON["id"].(string)
	if clash := a.Do(http.MethodPatch, "/api/illness/"+pastID, cookie, map[string]any{"endTime": nil}); clash.Status != http.StatusConflict {
		t.Errorf("reopen beside an open episode = %d, want 409", clash.Status)
	}
	// A sibling is their own patient.
	sibling := a.NewBaby(familyID, "Emil")
	if res := a.Do(http.MethodPost, "/api/illness", cookie, map[string]any{"babyId": sibling, "startTime": rfc(time.Now())}); res.Status != http.StatusCreated {
		t.Errorf("sibling's episode = %d, want 201", res.Status)
	}
}

func TestIllnessValidation(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	for name, extra := range map[string]map[string]any{
		"an unknown symptom": {"symptoms": []string{"plague"}},
		"a repeated symptom": {"symptoms": []string{"fever", "fever"}},
		"zero clear hours":   {"clearHours": 0},
		"a month of hours":   {"clearHours": 720},
	} {
		body := map[string]any{"babyId": babyID, "startTime": rfc(time.Now())}
		for k, v := range extra {
			body[k] = v
		}
		if res := a.Do(http.MethodPost, "/api/illness", cookie, body); res.Status != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400 from spec validation", name, res.Status)
		}
	}
	if res := a.Do(http.MethodPost, "/api/illness", cookie, map[string]any{"babyId": "nope", "startTime": rfc(time.Now())}); res.Status != http.StatusNotFound {
		t.Errorf("unknown baby = %d, want 404", res.Status)
	}
	stranger := a.SignUp("Stranger", "stranger@example.com")
	if res := a.Do(http.MethodPost, "/api/illness", cookie, map[string]any{"babyId": babyID, "startTime": rfc(time.Now()), "caretakerId": stranger}); res.Status != http.StatusForbidden {
		t.Errorf("a stranger as caretaker = %d, want 403", res.Status)
	}
}

func TestIllnessIsFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Hansen", "a@example.com")
	babyA := a.NewBaby(familyA, "Nora")
	_, cookieB := a.NewFamily("Olsen", "b@example.com")
	opened := a.Do(http.MethodPost, "/api/illness", cookieA, map[string]any{"babyId": babyA, "startTime": rfc(time.Now())})
	id, _ := opened.JSON["id"].(string)

	for name, res := range map[string]*testrig.Result{
		"create":  a.Do(http.MethodPost, "/api/illness", cookieB, map[string]any{"babyId": babyA, "startTime": rfc(time.Now())}),
		"recover": a.Do(http.MethodPost, "/api/illness/"+id+"/recover", cookieB, nil),
		"patch":   a.Do(http.MethodPatch, "/api/illness/"+id, cookieB, map[string]any{"notes": "mine"}),
		"delete":  a.Do(http.MethodDelete, "/api/illness/"+id, cookieB, nil),
	} {
		if res.Status != http.StatusNotFound {
			t.Errorf("%s across families = %d, want 404", name, res.Status)
		}
	}
	if list := a.DoArray(http.MethodGet, "/api/illness", cookieB, nil); len(list.JSON) != 0 {
		t.Errorf("other family lists %d episodes, want 0", len(list.JSON))
	}
	if active := a.Do(http.MethodGet, "/api/illness/active?babyId="+babyA, cookieB, nil); string(active.Raw) != "null" {
		t.Errorf("other family sees an open episode: %s", active.Raw)
	}
	if still := a.Do(http.MethodGet, "/api/illness/active?babyId="+babyA, cookieA, nil); still.JSON["id"] != id {
		t.Errorf("the owner's episode did not survive: %s", still.Raw)
	}
	if res := a.Do(http.MethodDelete, "/api/illness/"+id, cookieA, nil); res.Status != http.StatusOK {
		t.Errorf("owner delete = %d, want 200", res.Status)
	}
}

func TestIllnessOnTheTimelineAndInTheExport(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	end := time.Now().Add(-2 * time.Hour)
	a.Do(http.MethodPost, "/api/illness", cookie, map[string]any{
		"babyId": babyID, "startTime": rfc(end.Add(-50 * time.Hour)), "endTime": rfc(end),
		"symptoms": []string{"vomiting", "diarrhoea"}, "notes": "Omgangssyke from barnehagen",
	})

	for _, query := range []string{"", "&filter=other", "&q=omgangssyke"} {
		tl := a.Do(http.MethodGet, "/api/timeline?babyId="+babyID+query, cookie, nil)
		entries, _ := tl.JSON["entries"].([]any)
		if len(entries) != 1 {
			t.Fatalf("timeline%s = %s, want the one episode", query, tl.Raw)
		}
		e := entries[0].(map[string]any)
		if e["kind"] != "illness" || e["endTime"] == nil || len(e["symptoms"].([]any)) != 2 {
			t.Errorf("timeline%s entry = %v", query, e)
		}
	}
	if tl := a.Do(http.MethodGet, "/api/timeline?babyId="+babyID+"&filter=sleep", cookie, nil); strings.Contains(string(tl.Raw), `"illness"`) {
		t.Errorf("filter=sleep carries the illness")
	}
	csv := a.Do(http.MethodGet, "/api/export.csv", cookie, nil)
	if !strings.Contains(string(csv.Raw), ",vomiting · diarrhoea,") || !strings.Contains(string(csv.Raw), "illness,Nora,") {
		t.Errorf("export lacks the illness row:\n%s", csv.Raw)
	}
}
