package recur

import (
	"testing"
	"time"
)

func oslo(y int, m time.Month, d, hh, mm int) time.Time {
	return time.Date(y, m, d, hh, mm, 0, 0, Location)
}

func TestDailyKeepsLocalClockAcrossDST(t *testing.T) {
	// Oslo springs forward on 2026-03-29.
	s := Series{Start: oslo(2026, 3, 27, 8, 0), Rule: Daily}
	got := s.Between(oslo(2026, 3, 27, 0, 0), oslo(2026, 3, 31, 0, 0))
	if len(got) != 4 {
		t.Fatalf("got %d occurrences, want 4", len(got))
	}
	for _, occ := range got {
		if occ.In(Location).Hour() != 8 {
			t.Errorf("occurrence %v is not at 08:00 local", occ.In(Location))
		}
	}
	if got[3].Sub(got[2]) != 24*time.Hour || got[2].Sub(got[1]) != 23*time.Hour {
		t.Errorf("DST day should be 23 h apart: %v %v %v", got[1], got[2], got[3])
	}
}

func TestMonthlyClampsAndYearlyLeapDay(t *testing.T) {
	s := Series{Start: oslo(2026, 1, 31, 10, 0), Rule: Monthly}
	if got := s.Nth(1).In(Location); got.Month() != time.February || got.Day() != 28 {
		t.Errorf("Jan 31 + 1 month = %v, want Feb 28", got)
	}
	if got := s.Nth(2).In(Location); got.Month() != time.March || got.Day() != 31 {
		t.Errorf("Jan 31 + 2 months = %v, want Mar 31", got)
	}
	leap := Series{Start: oslo(2024, 2, 29, 9, 0), Rule: Yearly}
	if got := leap.Nth(1).In(Location); got.Year() != 2025 || got.Month() != time.February || got.Day() != 28 {
		t.Errorf("Feb 29 + 1 year = %v, want 2025-02-28", got)
	}
}

func TestBetweenHonoursUntilAndWindow(t *testing.T) {
	until := oslo(2026, 2, 12, 23, 59)
	s := Series{Start: oslo(2026, 2, 2, 17, 0), Rule: Weekly, Until: &until}
	got := s.Between(oslo(2026, 1, 1, 0, 0), oslo(2026, 12, 31, 0, 0))
	if len(got) != 2 || !got[0].Equal(oslo(2026, 2, 2, 17, 0)) || !got[1].Equal(oslo(2026, 2, 9, 17, 0)) {
		t.Errorf("weekly until Feb 12 = %v, want Feb 2 and Feb 9", got)
	}
	// A window that starts mid-series skips the earlier occurrences.
	open := Series{Start: oslo(2026, 2, 2, 17, 0), Rule: Biweekly}
	got = open.Between(oslo(2026, 3, 1, 0, 0), oslo(2026, 4, 1, 0, 0))
	if len(got) != 3 || !got[0].Equal(oslo(2026, 3, 2, 17, 0)) || !got[1].Equal(oslo(2026, 3, 16, 17, 0)) || !got[2].Equal(oslo(2026, 3, 30, 17, 0)) {
		t.Errorf("biweekly in March = %v, want Mar 2, 16 and 30", got)
	}
	one := Series{Start: oslo(2026, 2, 2, 17, 0), Rule: None}
	if got := one.Between(oslo(2026, 2, 3, 0, 0), oslo(2026, 3, 1, 0, 0)); len(got) != 0 {
		t.Errorf("a one-off outside the window = %v, want none", got)
	}
}

func TestNextOnOrAfter(t *testing.T) {
	s := Series{Start: oslo(2026, 1, 5, 20, 0), Rule: Daily}
	got, ok := s.NextOnOrAfter(oslo(2026, 6, 10, 20, 0))
	if !ok || !got.Equal(oslo(2026, 6, 10, 20, 0)) {
		t.Errorf("next on the exact minute = %v %v, want that minute", got, ok)
	}
	got, ok = s.NextOnOrAfter(oslo(2026, 6, 10, 20, 1))
	if !ok || !got.Equal(oslo(2026, 6, 11, 20, 0)) {
		t.Errorf("next a minute later = %v, want the next day", got)
	}
	until := oslo(2026, 1, 6, 23, 0)
	ended := Series{Start: oslo(2026, 1, 5, 20, 0), Rule: Daily, Until: &until}
	if _, ok := ended.NextOnOrAfter(oslo(2026, 1, 7, 0, 0)); ok {
		t.Errorf("a finished series still has a next occurrence")
	}
	one := Series{Start: oslo(2026, 1, 5, 20, 0), Rule: None}
	if _, ok := one.NextOnOrAfter(oslo(2026, 1, 5, 20, 1)); ok {
		t.Errorf("a past one-off still has a next occurrence")
	}
}

func TestRRule(t *testing.T) {
	until := time.Date(2026, 6, 1, 22, 0, 0, 0, time.UTC)
	cases := map[Rule]string{
		None: "", Daily: "FREQ=DAILY", Weekly: "FREQ=WEEKLY", Biweekly: "FREQ=WEEKLY;INTERVAL=2",
		Monthly: "FREQ=MONTHLY", Yearly: "FREQ=YEARLY",
	}
	for rule, want := range cases {
		if got := (Series{Rule: rule}).RRule(); got != want {
			t.Errorf("%s = %q, want %q", rule, got, want)
		}
	}
	if got := (Series{Rule: Weekly, Until: &until}).RRule(); got != "FREQ=WEEKLY;UNTIL=20260601T220000Z" {
		t.Errorf("weekly until = %q", got)
	}
}

// Skipped occurrences ("this event" deleted or detached) are left out of
// every expansion, and IsOccurrence names exactly the ones left.
func TestSkippedOccurrencesAreLeftOut(t *testing.T) {
	start := time.Date(2026, 3, 2, 9, 0, 0, 0, time.UTC) // Mondays 10:00 Oslo
	second := time.Date(2026, 3, 9, 9, 0, 0, 0, time.UTC)
	third := time.Date(2026, 3, 16, 9, 0, 0, 0, time.UTC)
	until := time.Date(2026, 3, 20, 0, 0, 0, 0, time.UTC)
	s := Series{Start: start, Rule: Weekly, Until: &until, Skip: []time.Time{second}}

	got := s.Between(start, until)
	if len(got) != 2 || !got[0].Equal(start) || !got[1].Equal(third) {
		t.Errorf("Between = %v, want the first and third", got)
	}
	if next, ok := s.NextOnOrAfter(start.Add(time.Minute)); !ok || !next.Equal(third) {
		t.Errorf("NextOnOrAfter past the first = %v %v, want the third", next, ok)
	}

	for name, tc := range map[string]struct {
		at   time.Time
		want bool
	}{
		"an occurrence":     {third, true},
		"the first":         {start, true},
		"a skipped one":     {second, false},
		"off the rule":      {third.Add(time.Hour), false},
		"past Until":        {time.Date(2026, 3, 23, 9, 0, 0, 0, time.UTC), false},
		"before the series": {start.Add(-7 * 24 * time.Hour), false},
	} {
		if got := s.IsOccurrence(tc.at); got != tc.want {
			t.Errorf("IsOccurrence(%s) = %v, want %v", name, got, tc.want)
		}
	}
	if (Series{Start: start, Rule: None}).IsOccurrence(start) {
		t.Error("a one-off has no occurrence to single out")
	}
}
