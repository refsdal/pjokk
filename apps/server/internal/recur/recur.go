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
	// Weekdays is Monday to Friday (issue #125): the pick-up rota, which is
	// none of the other rules and the most repeated event in a barnehage
	// family's week.
	Weekdays Rule = "weekdays"
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
	case None, Daily, Weekly, Biweekly, Weekdays, Monthly, Yearly:
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
	if s.Rule == None || (n == 0 && s.Rule != Weekdays) {
		return s.Start
	}
	local := s.Start.In(Location)
	switch s.Rule {
	case Weekdays:
		return nthWeekday(local, n)
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

// nthWeekday is the n-th Monday-to-Friday on or after local's date, at
// local's clock. A series stored with a weekend start (the API moves one to
// the Monday, but a row is a row) begins on the following Monday rather
// than put an occurrence on a Saturday. Whole weeks are jumped, so the cost
// does not grow with n, and the date is built with time.Date so the clock
// survives a DST change like every other rule.
func nthWeekday(local time.Time, n int) time.Time {
	offset := 0
	switch local.Weekday() {
	case time.Saturday:
		offset = 2
	case time.Sunday:
		offset = 1
	}
	// 0 = Monday … 4 = Friday, for the (now weekday) first occurrence.
	first := (int(local.Weekday()) + offset + 6) % 7
	steps := first + n
	offset += (steps/5)*7 + steps%5 - first
	return time.Date(local.Year(), local.Month(), local.Day()+offset, local.Hour(), local.Minute(), local.Second(), local.Nanosecond(), Location)
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
	// Start near `from`, not at the series' first occurrence: counted from
	// zero, a daily series went silent 400 days in and a weekday rota 80
	// weeks in — long before a barnehage child stops being picked up.
	var out []time.Time
	first := s.indexNear(from)
	for n := first; n < first+maxOccurrences; n++ {
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
	n := s.indexNear(t)
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

// indexNear returns an occurrence index at or before the first occurrence
// on or after t: elapsed time over the rule's period, less one, so a caller
// walks forward from it and never starts past what it is looking for. That
// only holds if roughPeriod is never SHORTER than the rule's real spacing —
// a shorter period divides into more steps than have happened, and the walk
// would begin beyond its answer and silently drop occurrences.
func (s Series) indexNear(t time.Time) int {
	if !t.After(s.Start) {
		return 0
	}
	period := s.roughPeriod()
	if period <= 0 {
		return 0
	}
	n := int(t.Sub(s.Start)/period) - 1
	if n < 0 {
		n = 0
	}
	return n
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
	case Weekdays:
		// Five a week is one every 33.6 h on average, but a Friday-to-Monday
		// gap makes any average overshoot. 36 h never does: from a Friday
		// start, 3+7k days on is occurrence 1+5k, and ⌊(72+168k)/36⌋-1 is
		// 1+⌊4.67k⌋, never more.
		return 36 * time.Hour
	case Monthly:
		// The LONGEST month, not the shortest (see indexNear). This was 28
		// days, which overshot once a series was about two years old.
		return 31 * 24 * time.Hour
	case Yearly:
		return 366 * 24 * time.Hour
	}
	return 0
}

// RRule renders the series as an iCalendar RRULE value (RFC 5545 §3.3.10),
// or "" for a one-off. UNTIL is rendered in UTC as the RFC requires when
// DTSTART carries a TZID.
func (s Series) RRule() string {
	var freq, byDay string
	interval := 1
	switch s.Rule {
	case Daily:
		freq = "DAILY"
	case Weekdays:
		freq, byDay = "WEEKLY", "MO,TU,WE,TH,FR"
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
	if byDay != "" {
		out += ";BYDAY=" + byDay
	}
	if s.Until != nil {
		out += ";UNTIL=" + s.Until.UTC().Format("20060102T150405Z")
	}
	return out
}
