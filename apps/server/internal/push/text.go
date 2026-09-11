package push

// Server-written notification text in the recipient's language (DECISIONS
// 2026-09-11). The English string is the key, as in the SPA's t()
// (apps/frontend/src/lib/i18n.ts), and the Norwegian wording follows that
// dictionary's words for the same things (Måltid, Bleie, Pumping, Logg …).
// text_test.go fails when a T call's string has no Norwegian entry, or an
// entry's format verbs differ from its key's.

import "fmt"

// The languages a person's users.language can hold.
const (
	LangEN = "en"
	LangNB = "nb"
)

// T renders format in lang, then formats it with args. A string missing
// from the dictionary falls back to English rather than failing a push.
func T(lang, format string, args ...any) string {
	if lang == LangNB {
		if s, ok := nb[format]; ok {
			format = s
		}
	}
	if len(args) == 0 {
		return format
	}
	return fmt.Sprintf(format, args...)
}

var nb = map[string]string{
	// Durations in a reminder's body.
	"%d h":   "%d t",
	"%d min": "%d min",

	// Reminders (internal/jobs/reminders.go).
	"No feed logged for %s":          "Ikke noe måltid logget på %s",
	"No diaper change logged for %s": "Ikke noe bleieskift logget på %s",
	"No pump logged for %s":          "Ingen pumping logget på %s",
	"No medicine logged for %s":      "Ingen medisin logget på %s",
	"%s: %s since the last dose":     "%s: %s siden siste dose",
	"Feed reminder":                  "Påminnelse: måltid",
	"Diaper reminder":                "Påminnelse: bleie",
	"Time to pump":                   "Tid for pumping",
	"Medicine reminder":              "Påminnelse: medisin",

	// Buttons.
	"Log feed":      "Logg måltid",
	"Log diaper":    "Logg bleie",
	"Log pump":      "Logg pumping",
	"Log dose":      "Logg dose",
	"Snooze 15 min": "Utsett 15 min",

	// Help requests (internal/api/help.go).
	"%s needs a hand":       "%s trenger en hånd",
	"%s is on the way":      "%s er på vei",
	"Answered your request": "Har svart på forespørselen din",
	"Can you come?":         "Kan du komme?",
	"Someone":               "Noen",

	// The test push (internal/api/push.go).
	"Push works on this device ✅": "Varsler fungerer på denne enheten ✅",
}
