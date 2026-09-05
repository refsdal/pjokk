package api_test

import (
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// CSV export — ports apps/api/test/stats.test.ts's "csv export" describe
// block. internal/api/export.go's package doc comment explains why
// /api/export.csv sits outside the generated strict server (a CSV body
// isn't JSON) and why it needs no plan gate (export.ts's own handler
// never calls canUse, unlike the "csvExport" entitlements.ts flag its own
// comment names, which is dead code).
// -----------------------------------------------------------------------

func TestExportCSVOrderingEscapingFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")
	babyA := a.NewBaby(familyA, "Nora")
	familyB, cookieB := a.NewFamily("Family B", "b@example.com")
	babyB := a.NewBaby(familyB, "Ola")

	now := time.Now()

	feedRes := a.Do(http.MethodPost, "/api/feeds", cookieA, map[string]any{
		"babyId":   babyA,
		"time":     now.Add(-2 * time.Hour).Format(time.RFC3339),
		"type":     "bottle",
		"amountMl": 150,
		"notes":    `she said "more", then a,comma`,
	})
	if feedRes.Status != http.StatusCreated {
		t.Fatalf("create feed status = %d, body %s", feedRes.Status, feedRes.Raw)
	}

	medRes := a.Do(http.MethodPost, "/api/medicine", cookieA, map[string]any{
		"babyId": babyA,
		"time":   now.Add(-1 * time.Hour).Format(time.RFC3339),
		"name":   "D-vitamin",
		"amount": 5,
		"unit":   "drops",
	})
	if medRes.Status != http.StatusCreated {
		t.Fatalf("create medicine status = %d, body %s", medRes.Status, medRes.Raw)
	}

	// B's data must NOT leak into A's export.
	bFeedRes := a.Do(http.MethodPost, "/api/feeds", cookieB, map[string]any{
		"babyId":   babyB,
		"time":     now.Format(time.RFC3339),
		"type":     "bottle",
		"amountMl": 999,
	})
	if bFeedRes.Status != http.StatusCreated {
		t.Fatalf("create feed (family B) status = %d, body %s", bFeedRes.Status, bFeedRes.Raw)
	}

	res := a.Do(http.MethodGet, "/api/export.csv", cookieA, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "text/csv") {
		t.Errorf("Content-Type = %q, want it to contain text/csv", ct)
	}
	if cd := res.Header.Get("Content-Disposition"); !strings.Contains(cd, "attachment") {
		t.Errorf("Content-Disposition = %q, want it to contain attachment", cd)
	}

	csv := string(res.Raw)
	lines := strings.Split(csv, "\n")
	want := "kind,baby,time,end_time,type,detail,amount,unit,side,duration_min,value,location,caretaker,notes"
	if lines[0] != want {
		t.Errorf("header = %q, want %q", lines[0], want)
	}
	if len(lines) != 3 {
		t.Fatalf("lines = %d, want 3 (header + feed + medicine), got:\n%s", len(lines), csv)
	}
	if !strings.Contains(lines[1], "feed") {
		t.Errorf("lines[1] = %q, want it to contain \"feed\"", lines[1])
	}
	if !strings.Contains(lines[1], `"she said ""more"", then a,comma"`) {
		t.Errorf("lines[1] = %q, want the notes field RFC-4180-quoted", lines[1])
	}
	if !strings.Contains(lines[2], "D-vitamin") {
		t.Errorf("lines[2] = %q, want it to contain \"D-vitamin\"", lines[2])
	}
	if strings.Contains(csv, "999") {
		t.Errorf("csv contains family B's amount 999:\n%s", csv)
	}

	// Formula injection is neutralized with a leading apostrophe.
	noteRes := a.Do(http.MethodPost, "/api/notes", cookieA, map[string]any{
		"babyId":  babyA,
		"time":    now.Format(time.RFC3339),
		"content": `=HYPERLINK("http://evil.example","x")`,
	})
	if noteRes.Status != http.StatusCreated {
		t.Fatalf("create note status = %d, body %s", noteRes.Status, noteRes.Raw)
	}
	res2 := a.Do(http.MethodGet, "/api/export.csv", cookieA, nil)
	csv2 := string(res2.Raw)
	if !strings.Contains(csv2, "'=HYPERLINK") {
		t.Errorf("csv2 does not contain the apostrophe-guarded formula:\n%s", csv2)
	}
	if regexp.MustCompile(`(?m)(^|,)=HYPERLINK`).MatchString(csv2) {
		t.Errorf("csv2 still contains an unguarded =HYPERLINK cell:\n%s", csv2)
	}

	// Unauthenticated: refused.
	unauth := a.Do(http.MethodGet, "/api/export.csv", "", nil)
	if unauth.Status != http.StatusUnauthorized {
		t.Errorf("unauthenticated status = %d, want 401", unauth.Status)
	}
}

func TestExportCSVEmptyFamilyIsHeaderOnly(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodGet, "/api/export.csv", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	csv := string(res.Raw)
	if strings.Contains(csv, "\n") {
		t.Errorf("csv = %q, want exactly the header line (no data rows)", csv)
	}
}

// The CSV's `unit` column is derived from the measurement's type, since
// measurement_log stores no unit — weight is kg, length and head are cm, and
// a temperature is °C. Deriving it as "weight ? kg : cm" (which is what the
// three-type world could get away with) exports every temperature as a
// length, so this pins the whole mapping rather than just the new arm.
func TestExportCSVDerivesMeasurementUnitFromType(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	for _, m := range []struct {
		typ   string
		value float64
	}{
		{"weight", 8.4},
		{"length", 70.4},
		{"head", 43.5},
		{"temperature", 39.4},
	} {
		res := a.Do(http.MethodPost, "/api/measurements", cookie, map[string]any{
			"babyId": babyID,
			"time":   time.Now().UTC().Format(time.RFC3339),
			"type":   m.typ,
			"value":  m.value,
		})
		if res.Status != http.StatusCreated {
			t.Fatalf("create %s: status %d, body %s", m.typ, res.Status, res.Raw)
		}
	}

	csv := string(a.Do(http.MethodGet, "/api/export.csv", cookie, nil).Raw)
	for _, want := range []string{"weight", "length", "head", "temperature"} {
		if !strings.Contains(csv, want) {
			t.Fatalf("export missing %s row:\n%s", want, csv)
		}
	}
	for _, c := range []struct{ typ, unit string }{
		{"weight", "kg"},
		{"length", "cm"},
		{"head", "cm"},
		{"temperature", "°C"},
	} {
		var found bool
		for _, line := range strings.Split(csv, "\n") {
			if strings.Contains(line, ","+c.typ+",") && strings.Contains(line, ","+c.unit+",") {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("no %s row carrying unit %q:\n%s", c.typ, c.unit, csv)
		}
	}
}
