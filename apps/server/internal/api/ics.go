package api

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/recur"
)

// GET /api/calendar.ics (issue #52): the family's calendar as an iCalendar
// feed a phone or Google Calendar can subscribe to. Hand-routed outside
// the strict server like export.go — the body is text/calendar, not JSON.
//
// # The key in the URL
//
// A subscription URL cannot send a header, so this one route also accepts
// the `pjk_` API key as ?key=. withKeyQuery copies it into the
// Authorization header before the ordinary familyChain runs, so the key
// is checked, touched and expired by exactly the same middleware as every
// other key request — nothing here re-implements auth. The URL is
// therefore a credential; Settings says so and hands out a read-only key
// for it. GET is a read, so a read-only key is enough.
//
// # Series
//
// A recurring event is one VEVENT with an RRULE (internal/recur.RRule),
// never an expansion — the calendar client does the stepping. DTSTART is
// given in Europe/Oslo local time with a VTIMEZONE so the client steps
// on the same local calendar recur does.

func (d Deps) mountICSRoutes(mux *http.ServeMux, chain func(http.Handler) http.Handler) {
	mux.Handle("GET /api/calendar.ics", withKeyQuery(chain(http.HandlerFunc(d.calendarICS))))
}

// withKeyQuery lifts ?key=pjk_… into the Authorization header when no
// header was sent.
func withKeyQuery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			if key := r.URL.Query().Get("key"); strings.HasPrefix(key, apiKeyTokenPrefix) {
				r.Header.Set("Authorization", "Bearer "+key)
			}
		}
		next.ServeHTTP(w, r)
	})
}

// The Oslo rules as a VTIMEZONE (EU rules since 1996: last Sunday of March
// and October). Static text is what every calendar client expects here.
const osloVTimezone = `BEGIN:VTIMEZONE
TZID:Europe/Oslo
BEGIN:STANDARD
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
END:DAYLIGHT
END:VTIMEZONE`

func (d Deps) calendarICS(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListAllCalendarEvents(ctx, fam.FamilyID)
	if err != nil {
		http.Error(w, "calendar read failed", http.StatusInternalServerError)
		return
	}
	ids := make([]string, len(rows))
	for i, row := range rows {
		ids[i] = row.ID
	}
	babiesByEvent := map[string][]string{}
	if len(ids) > 0 {
		babyRows, err := d.Q.CalendarEventBabiesForEvents(ctx, ids)
		if err != nil {
			http.Error(w, "calendar read failed", http.StatusInternalServerError)
			return
		}
		for _, br := range babyRows {
			babiesByEvent[br.EventID] = append(babiesByEvent[br.EventID], br.Name)
		}
	}

	skips, err := d.skipsByEvent(ctx, fam.FamilyID, ids)
	if err != nil {
		http.Error(w, "calendar read failed", http.StatusInternalServerError)
		return
	}

	var b strings.Builder
	line := func(s string) { b.WriteString(foldICSLine(s) + "\r\n") }
	line("BEGIN:VCALENDAR")
	line("VERSION:2.0")
	line("PRODID:-//Pjokk//Calendar//EN")
	line("CALSCALE:GREGORIAN")
	line("METHOD:PUBLISH")
	line("X-WR-CALNAME:Pjokk")
	for _, l := range strings.Split(osloVTimezone, "\n") {
		line(l)
	}
	stamp := d.Now().UTC().Format("20060102T150405Z")
	for _, row := range rows {
		line("BEGIN:VEVENT")
		line("UID:" + row.ID + "@pjokk")
		line("DTSTAMP:" + stamp)
		line("CREATED:" + row.CreatedAt.Time.UTC().Format("20060102T150405Z"))
		start := row.StartTime.Time.In(recur.Location)
		if row.AllDay {
			line("DTSTART;VALUE=DATE:" + start.Format("20060102"))
		} else {
			line("DTSTART;TZID=Europe/Oslo:" + start.Format("20060102T150405"))
			if row.DurationMin != nil {
				end := start.Add(time.Duration(*row.DurationMin) * time.Minute)
				line("DTEND;TZID=Europe/Oslo:" + end.Format("20060102T150405"))
			}
		}
		if rr := seriesOf(row.StartTime, row.Recurrence, row.RecurrenceUntil).RRule(); rr != "" {
			line("RRULE:" + rr)
			// Occurrences taken out of the series ("this event" deleted or
			// detached), in the same form as DTSTART.
			exdates := skips[row.ID]
			sort.Slice(exdates, func(i, j int) bool { return exdates[i].Before(exdates[j]) })
			for _, skip := range exdates {
				local := skip.In(recur.Location)
				if row.AllDay {
					line("EXDATE;VALUE=DATE:" + local.Format("20060102"))
				} else {
					line("EXDATE;TZID=Europe/Oslo:" + local.Format("20060102T150405"))
				}
			}
		}
		line("SUMMARY:" + escapeICS(row.Title))
		var desc []string
		if row.Description != nil && *row.Description != "" {
			desc = append(desc, *row.Description)
		}
		if names := babiesByEvent[row.ID]; len(names) > 0 {
			sort.Strings(names)
			desc = append(desc, strings.Join(names, ", "))
		}
		if len(desc) > 0 {
			line("DESCRIPTION:" + escapeICS(strings.Join(desc, "\n")))
		}
		if row.Location != nil && *row.Location != "" {
			line("LOCATION:" + escapeICS(*row.Location))
		}
		line("CATEGORIES:" + escapeICS(row.Category))
		if row.RemindMinutesBefore != nil {
			line("BEGIN:VALARM")
			line("ACTION:DISPLAY")
			line("DESCRIPTION:" + escapeICS(row.Title))
			line(fmt.Sprintf("TRIGGER:-PT%dM", *row.RemindMinutesBefore))
			line("END:VALARM")
		}
		line("END:VEVENT")
	}
	line("END:VCALENDAR")

	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	w.Header().Set("Content-Disposition", `inline; filename="pjokk.ics"`)
	w.Header().Set("Cache-Control", "private, no-store")
	_, _ = w.Write([]byte(b.String()))
}

// escapeICS is RFC 5545 §3.3.11 TEXT escaping.
func escapeICS(s string) string {
	r := strings.NewReplacer(`\`, `\\`, ";", `\;`, ",", `\,`, "\r\n", `\n`, "\n", `\n`)
	return r.Replace(s)
}

// foldICSLine folds a content line at 75 octets (RFC 5545 §3.1), on a
// rune boundary so a multi-byte character is never split.
func foldICSLine(s string) string {
	const max = 75
	if len(s) <= max {
		return s
	}
	var out strings.Builder
	width := 0
	first := true
	for _, r := range s {
		size := len(string(r))
		limit := max
		if !first {
			limit = max - 1 // the leading space of a continuation counts
		}
		if width+size > limit {
			out.WriteString("\r\n ")
			width = 0
			first = false
		}
		out.WriteRune(r)
		width += size
	}
	return out.String()
}
