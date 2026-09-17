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

// ---- Weekdays (issue #125): Monday to Friday, the pick-up rota ----------

func TestWeekdaysSkipsTheWeekend(t *testing.T) {
	// Thursday 2026-10-01, 15:30.
	s := Series{Start: oslo(2026, 10, 1, 15, 30), Rule: Weekdays}
	got := s.Between(oslo(2026, 10, 1, 0, 0), oslo(2026, 10, 9, 0, 0))
	want := []int{1, 2, 5, 6, 7, 8}
	if len(got) != len(want) {
		t.Fatalf("got %d occurrences %v, want days %v", len(got), got, want)
	}
	for i, occ := range got {
		l := occ.In(Location)
		if l.Day() != want[i] || l.Hour() != 15 || l.Minute() != 30 {
			t.Errorf("occurrence %d = %v, want October %d at 15:30", i, l, want[i])
		}
		if wd := l.Weekday(); wd == time.Saturday || wd == time.Sunday {
			t.Errorf("occurrence %d falls on a %v", i, wd)
		}
	}
}

// A series stored with a weekend start begins on the Monday: no occurrence
// is ever put on a Saturday, whichever index is asked for.
func TestWeekdaysFromAWeekendStartBeginsOnMonday(t *testing.T) {
	for _, start := range []time.Time{oslo(2026, 10, 3, 15, 30), oslo(2026, 10, 4, 15, 30)} {
		s := Series{Start: start, Rule: Weekdays}
		if got := s.Nth(0).In(Location); got.Day() != 5 || got.Weekday() != time.Monday || got.Hour() != 15 {
			t.Errorf("first occurrence of a series starting %v = %v, want Monday the 5th at 15:30", start.Weekday(), got)
		}
		if got := s.Nth(5).In(Location); got.Day() != 12 || got.Weekday() != time.Monday {
			t.Errorf("sixth occurrence = %v, want Monday the 12th", got)
		}
		if s.IsOccurrence(start) {
			t.Errorf("the %v start itself is an occurrence", start.Weekday())
		}
	}
}

func TestWeekdaysKeepsLocalClockAcrossDST(t *testing.T) {
	// Oslo falls back on Sunday 2026-10-25: Friday 23rd to Monday 26th is
	// 73 hours apart, and both are at 15:30.
	s := Series{Start: oslo(2026, 10, 23, 15, 30), Rule: Weekdays}
	fri, mon := s.Nth(0), s.Nth(1)
	if mon.In(Location).Hour() != 15 || mon.In(Location).Minute() != 30 || mon.In(Location).Day() != 26 {
		t.Errorf("Monday = %v, want the 26th at 15:30", mon.In(Location))
	}
	if mon.Sub(fri) != 73*time.Hour {
		t.Errorf("Friday to Monday across the change = %v, want 73 h", mon.Sub(fri))
	}
}

func TestWeekdaysRRuleUntilAndSkips(t *testing.T) {
	until := oslo(2026, 10, 7, 23, 59)
	s := Series{Start: oslo(2026, 10, 1, 15, 30), Rule: Weekdays, Until: &until, Skip: []time.Time{oslo(2026, 10, 5, 15, 30)}}
	if got := s.RRule(); got != "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20261007T215900Z" {
		t.Errorf("RRULE = %q", got)
	}
	got := s.Between(oslo(2026, 9, 1, 0, 0), oslo(2026, 11, 1, 0, 0))
	if len(got) != 4 { // 1st, 2nd, (5th skipped), 6th, 7th
		t.Fatalf("got %d occurrences %v, want 4", len(got), got)
	}
	if next, ok := s.NextOnOrAfter(oslo(2026, 10, 3, 0, 0)); !ok || next.In(Location).Day() != 6 {
		t.Errorf("next on or after Saturday the 3rd = %v %v, want Tuesday the 6th (Monday is skipped)", next, ok)
	}
	if _, ok := s.NextOnOrAfter(oslo(2026, 10, 8, 0, 0)); ok {
		t.Errorf("an occurrence after Until")
	}
}

// ---- The jump must never start past its answer --------------------------
//
// Between and NextOnOrAfter both begin from an estimated index rather than
// from the series' first occurrence (counted from zero, a daily series went
// silent 400 days in). The estimate is only safe if it never overshoots.
// This walks every rule over eight years against the slow, obviously right
// answer: count from zero.

func bruteBetween(s Series, from, to time.Time) []time.Time {
	var out []time.Time
	for n := 0; n < 4000; n++ {
		occ := s.Nth(n)
		if !occ.Before(to) {
			break
		}
		if !occ.Before(from) {
			out = append(out, occ)
		}
	}
	return out
}

func TestExpansionMatchesCountingFromZeroForEveryRule(t *testing.T) {
	starts := []time.Time{
		oslo(2026, 1, 31, 15, 30), // a 31st, for monthly clamping; a Saturday, for weekdays
		oslo(2026, 10, 2, 8, 0),   // a Friday: the weekdays rule's worst case for the jump
		oslo(2024, 2, 29, 9, 0),   // a leap day
	}
	for _, rule := range []Rule{Daily, Weekly, Biweekly, Weekdays, Monthly, Yearly} {
		for _, start := range starts {
			s := Series{Start: start, Rule: rule}
			// Month-long windows, stepped 17 days, for eight years.
			for from := start.AddDate(0, 0, -10); from.Before(start.AddDate(8, 0, 0)); from = from.AddDate(0, 0, 17) {
				to := from.AddDate(0, 1, 0)
				got, want := s.Between(from, to), bruteBetween(s, from, to)
				if len(got) != len(want) {
					t.Fatalf("%s from %v, window %v: got %d occurrences, counting from zero gives %d", rule, start, from, len(got), len(want))
				}
				for i := range got {
					if !got[i].Equal(want[i]) {
						t.Fatalf("%s from %v, window %v: occurrence %d = %v, want %v", rule, start, from, i, got[i], want[i])
					}
				}
				next, ok := s.NextOnOrAfter(from)
				if brute := bruteBetween(s, from, from.AddDate(2, 0, 0)); !ok || !next.Equal(brute[0]) {
					t.Fatalf("%s from %v: next on or after %v = %v, want %v", rule, start, from, next, brute[0])
				}
			}
		}
	}
}
