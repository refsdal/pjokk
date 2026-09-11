// Package recur expands a calendar event's recurrence rule into occurrences
// (issue #52). A series is one stored row — start, rule, optional
// inclusive "until" — and this package is the only place occurrences are
// computed, for the API's read-time expansion, the reminder job's "next
// occurrence" and the ICS feed's RRULE.
//
// Stepping happens on the LOCAL calendar in Location (Europe/Oslo — the
// product's Norwegian defaults, and the same zone the reminder clock is
// rendered in), not in UTC: a daily 08:00 event must stay at 08:00 across
// a DST change, which adding 24 h would not do. Monthly and yearly steps
// clamp the day (the 31st recurs on the 30th in a short month) instead of
// letting time.AddDate roll into the following month.
package recur

import (
	"fmt"
	"time"

	_ "time/tzdata"
)

// Rule is the recurrence vocabulary; the strings are the API's enum.
type Rule string

const (
	None     Rule = "none"
	Daily    Rule = "daily"
	Weekly   Rule = "weekly"
	Biweekly Rule = "biweekly"
	Monthly  Rule = "monthly"
	Yearly   Rule = "yearly"
)

// Location is the local calendar the series steps on.
var Location = mustLoadLocation("Europe/Oslo")

func mustLoadLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(fmt.Sprintf("recur: load location %q: %v", name, err))
	}
	return loc
}

// Valid reports whether r is one of the known rules.
func Valid(r Rule) bool {
	switch r {
	case None, Daily, Weekly, Biweekly, Monthly, Yearly:
		return true
	}
	return false
}

// Series is one stored event's recurrence.
type Series struct {
	Start time.Time
	Rule  Rule
	Until *time.Time // inclusive on the occurrence's start; nil = forever
	// Skip are occurrences taken out of the series — "this event" deleted
	// or detached (00016_calendar_event_skip.sql) — matched on the instant.
	Skip []time.Time
}

// skipped reports whether occ was taken out of the series.
func (s Series) skipped(occ time.Time) bool {
	for _, k := range s.Skip {
		if k.Equal(occ) {
			return true
		}
	}
	return false
}

// IsOccurrence reports whether t is the start of one of the series'
// occurrences: on the rule, within Until, and not skipped. A one-off has
// no occurrences to single out, so it is always false for one.
func (s Series) IsOccurrence(t time.Time) bool {
	if s.Rule == None {
		return false
	}
	next, ok := s.NextOnOrAfter(t)
	return ok && next.Equal(t)
}

// Nth returns the n-th occurrence (0 = Start) in Location, with day clamping
// for the month/year rules.
func (s Series) Nth(n int) time.Time {
	if n == 0 || s.Rule == None {
		return s.Start
	}
	local := s.Start.In(Location)
	switch s.Rule {
	case Daily:
		return time.Date(local.Year(), local.Month(), local.Day()+n, local.Hour(), local.Minute(), local.Second(), local.Nanosecond(), Location)
	case Weekly:
		return time.Date(local.Year(), local.Month(), local.Day()+7*n, local.Hour(), local.Minute(), local.Second(), local.Nanosecond(), Location)
	case Biweekly:
		return time.Date(local.Year(), local.Month(), local.Day()+14*n, local.Hour(), local.Minute(), local.Second(), local.Nanosecond(), Location)
	case Monthly:
		return clampedDate(local.Year(), local.Month()+time.Month(n), local)
	case Yearly:
		return clampedDate(local.Year()+n, local.Month(), local)
	}
	return s.Start
}

// clampedDate builds year/month with local's day-of-month clamped to the
// month's length, keeping local's clock.
func clampedDate(year int, month time.Month, local time.Time) time.Time {
	// Normalise month overflow first (month 13 → next year's January).
	first := time.Date(year, month, 1, 0, 0, 0, 0, Location)
	daysInMonth := time.Date(first.Year(), first.Month()+1, 0, 0, 0, 0, 0, Location).Day()
	day := local.Day()
	if day > daysInMonth {
		day = daysInMonth
	}
	return time.Date(first.Year(), first.Month(), day, local.Hour(), local.Minute(), local.Second(), local.Nanosecond(), Location)
}

// maxOccurrences bounds every expansion: a daily series over the API's
// 366-day window is 366 rows; anything past this is a runaway.
const maxOccurrences = 400

// Between returns the occurrences with from <= start < to, in order,
// honouring Until.
func (s Series) Between(from, to time.Time) []time.Time {
	if s.Rule == None {
		if !s.Start.Before(from) && s.Start.Before(to) && s.within(s.Start) {
			return []time.Time{s.Start}
		}
		return nil
	}
	var out []time.Time
	for n := 0; n < maxOccurrences; n++ {
		occ := s.Nth(n)
		if !occ.Before(to) || !s.within(occ) {
			break
		}
		if !occ.Before(from) && !s.skipped(occ) {
			out = append(out, occ)
		}
	}
	return out
}

// NextOnOrAfter returns the first occurrence starting at or after t, or
// false when the series has run out.
func (s Series) NextOnOrAfter(t time.Time) (time.Time, bool) {
	if s.Rule == None {
		if s.Start.Before(t) || !s.within(s.Start) {
			return time.Time{}, false
		}
		return s.Start, true
	}
	// Jump close: estimate n from the rule's rough period, then walk.
	n := 0
	if t.After(s.Start) {
		period := s.roughPeriod()
		if period > 0 {
			n = int(t.Sub(s.Start)/period) - 1
			if n < 0 {
				n = 0
			}
		}
	}
	for steps := 0; steps < maxOccurrences*4; steps++ {
		occ := s.Nth(n)
		if !s.within(occ) {
			return time.Time{}, false
		}
		if !occ.Before(t) && !s.skipped(occ) {
			return occ, true
		}
		n++
	}
	return time.Time{}, false
}

func (s Series) within(occ time.Time) bool {
	return s.Until == nil || !occ.After(*s.Until)
}

func (s Series) roughPeriod() time.Duration {
	switch s.Rule {
	case Daily:
		return 24 * time.Hour
	case Weekly:
		return 7 * 24 * time.Hour
	case Biweekly:
		return 14 * 24 * time.Hour
	case Monthly:
		return 28 * 24 * time.Hour
	case Yearly:
		return 365 * 24 * time.Hour
	}
	return 0
}

// RRule renders the series as an iCalendar RRULE value (RFC 5545 §3.3.10),
// or "" for a one-off. UNTIL is rendered in UTC as the RFC requires when
// DTSTART carries a TZID.
func (s Series) RRule() string {
	var freq string
	interval := 1
	switch s.Rule {
	case Daily:
		freq = "DAILY"
	case Weekly:
		freq = "WEEKLY"
	case Biweekly:
		freq, interval = "WEEKLY", 2
	case Monthly:
		freq = "MONTHLY"
	case Yearly:
		freq = "YEARLY"
	default:
		return ""
	}
	out := "FREQ=" + freq
	if interval > 1 {
		out += fmt.Sprintf(";INTERVAL=%d", interval)
	}
	if s.Until != nil {
		out += ";UNTIL=" + s.Until.UTC().Format("20060102T150405Z")
	}
	return out
}
