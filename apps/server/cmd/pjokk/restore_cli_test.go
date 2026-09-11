package main

import (
	"strings"
	"testing"
)

// The restore commands' command lines (spec 2026-09-11-admin-restore §1,
// §2). Like the cron guard, a bad one is refused before anything is built,
// which is why these run with no database.

func TestParseRestoreArgs(t *testing.T) {
	good := []struct {
		name string
		args []string
		want restoreCmd
	}{
		{"the whole database from a night", []string{"--from", "2026-09-10"}, restoreCmd{from: "2026-09-10"}},
		{"the whole database from a file", []string{"--file", "/tmp/pjokk-backup-2026-09-10.json"}, restoreCmd{file: "/tmp/pjokk-backup-2026-09-10.json"}},
		{"one family", []string{"family", "fam1", "--from", "2026-09-10"}, restoreCmd{family: "fam1", from: "2026-09-10"}},
		{"one family from a file", []string{"family", "fam1", "--file", "s.json"}, restoreCmd{family: "fam1", file: "s.json"}},
	}
	for _, tc := range good {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseRestoreArgs(tc.args)
			if err != nil || got != tc.want {
				t.Errorf("parseRestoreArgs(%q) = %+v, %v; want %+v", tc.args, got, err, tc.want)
			}
		})
	}

	bad := []struct {
		name string
		args []string
	}{
		{"no source", nil},
		{"two sources", []string{"--from", "2026-09-10", "--file", "s.json"}},
		{"not a date", []string{"--from", "yesterday"}},
		{"a family with no id", []string{"family"}},
		{"a flag where the id goes", []string{"family", "--from", "2026-09-10"}},
		{"a stray argument", []string{"--from", "2026-09-10", "please"}},
		{"an unknown flag", []string{"--replace", "--from", "2026-09-10"}},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := parseRestoreArgs(tc.args); err == nil {
				t.Errorf("parseRestoreArgs(%q) = %+v, want an error", tc.args, got)
			}
		})
	}
}

func TestReadPasswordTakesTheFirstLine(t *testing.T) {
	for in, want := range map[string]string{
		"hunter2hunter2\n":     "hunter2hunter2",
		"hunter2hunter2\r\n":   "hunter2hunter2",
		"no newline at all":    "no newline at all",
		"first line\nsecond\n": "first line",
	} {
		got, err := readPassword(strings.NewReader(in))
		if err != nil || got != want {
			t.Errorf("readPassword(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "\n", "short\n"} {
		if _, err := readPassword(strings.NewReader(in)); err == nil {
			t.Errorf("readPassword(%q) = nil error, want a refusal", in)
		}
	}
}

// Refused before config or a database is touched: these run with no
// DATABASE_URL at all.
func TestRestoreAndSetPasswordRejectBadCommandLinesFirst(t *testing.T) {
	if got := restoreMode(nil); got != 2 {
		t.Errorf("restoreMode() = %d, want 2", got)
	}
	if got := restoreMode([]string{"family"}); got != 2 {
		t.Errorf("restoreMode(family) = %d, want 2", got)
	}
	if got := setPasswordMode(nil, strings.NewReader("hunter2hunter2\n")); got != 2 {
		t.Errorf("setPasswordMode() = %d, want 2", got)
	}
	if got := setPasswordMode([]string{"a@example.com"}, strings.NewReader("short\n")); got != 2 {
		t.Errorf("setPasswordMode(short) = %d, want 2", got)
	}
}
