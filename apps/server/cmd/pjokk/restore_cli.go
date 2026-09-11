package main

// The restore commands (docs/superpowers/specs/2026-09-11-admin-restore-design.md):
//
//	restore --from YYYY-MM-DD | --file PATH              the whole database, into an empty one
//	restore family <id> --from YYYY-MM-DD | --file PATH  one deleted family, into the live one
//	set-password <email>                                 the password is read from stdin
//
// The work is internal/restore's; this file parses, builds dependencies,
// and prints what happened.

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"regexp"
	"sort"
	"strings"
	"syscall"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/config"
	"github.com/refsdal/pjokk/server/internal/db"
	"github.com/refsdal/pjokk/server/internal/restore"
	"github.com/refsdal/pjokk/server/internal/storage"
)

const restoreUsage = `usage: pjokk restore --from YYYY-MM-DD | --file PATH
       pjokk restore family <id> --from YYYY-MM-DD | --file PATH`

const setPasswordUsage = `usage: pjokk set-password <email>   (the password is read from stdin)`

// minPassword is the console's rule for a password an operator sets.
const minPassword = 8

var snapshotDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// restoreCmd is a parsed `restore` command line. family is empty for the
// whole database.
type restoreCmd struct {
	family string
	from   string
	file   string
}

func parseRestoreArgs(args []string) (restoreCmd, error) {
	var cmd restoreCmd
	if len(args) > 0 && args[0] == "family" {
		if len(args) < 2 || strings.HasPrefix(args[1], "-") {
			return cmd, errors.New("restore family: which family?")
		}
		cmd.family = args[1]
		args = args[2:]
	}
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&cmd.from, "from", "", "")
	fs.StringVar(&cmd.file, "file", "", "")
	if err := fs.Parse(args); err != nil {
		return cmd, fmt.Errorf("restore: %w", err)
	}
	switch {
	case fs.NArg() > 0:
		return cmd, fmt.Errorf("restore: unexpected %q", fs.Arg(0))
	case (cmd.from == "") == (cmd.file == ""):
		return cmd, errors.New("restore: give exactly one of --from YYYY-MM-DD or --file PATH")
	case cmd.from != "" && !snapshotDate.MatchString(cmd.from):
		return cmd, fmt.Errorf("restore: --from %q is not a date (YYYY-MM-DD)", cmd.from)
	}
	return cmd, nil
}

// restoreMode rejects a bad command line before it touches anything, like
// cronMode, so a typo'd Job fails fast and says why.
func restoreMode(args []string) int {
	cmd, err := parseRestoreArgs(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n%s\n", err, restoreUsage)
		return 2
	}

	cfg, err := config.FromOS()
	if err != nil {
		log.Printf("configuration error: %v", err)
		return 1
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	if cmd.family == "" {
		// The whole restore loads into this build's schema.
		if err := db.ApplyMigrations(ctx, cfg.DatabaseURL); err != nil {
			log.Printf("migration failed: %v", err)
			return 1
		}
	}
	deps, closeDeps, err := buildDeps(ctx, cfg)
	if err != nil {
		log.Printf("startup failed: %v", err)
		return 1
	}
	defer closeDeps()

	snap, err := loadSnapshot(ctx, deps.Storage, cmd)
	if err != nil {
		log.Print(err)
		return 1
	}
	rd := restore.Deps{Pool: deps.Pool, Storage: deps.Storage}

	if cmd.family == "" {
		rep, err := restore.Whole(ctx, rd, snap)
		if err != nil {
			log.Print(err)
			return 1
		}
		printReport(os.Stdout, rep)
		fmt.Fprint(os.Stdout, `
Passwords are not in backups, so nobody can sign in with one yet. Set yours:
  pjokk set-password <your email>     (it reads the password from stdin)
Google sign-in works as before.
`)
		return 0
	}

	rep, err := restore.Family(ctx, rd, snap, cmd.family, nil)
	if err != nil {
		log.Print(err)
		return 1
	}
	printFamilyReport(os.Stdout, rep)
	return 0
}

func loadSnapshot(ctx context.Context, st storage.Storage, cmd restoreCmd) (*restore.Snapshot, error) {
	if cmd.file != "" {
		return restore.FromFile(cmd.file)
	}
	return restore.FromStorage(ctx, st, cmd.from)
}

func printReport(w io.Writer, rep *restore.Report) {
	version := "unknown"
	if rep.SchemaVersion > 0 {
		version = fmt.Sprint(rep.SchemaVersion)
	}
	fmt.Fprintf(w, "Restored from a snapshot at schema %s (this build: %d).\n", version, rep.BuildVersion)
	names := make([]string, 0, len(rep.Rows))
	for name := range rep.Rows {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Fprintf(w, "  %-28s %d\n", name, rep.Rows[name])
	}
	if len(rep.Skipped) > 0 {
		fmt.Fprintf(w, "Skipped, no longer in the schema: %s\n", strings.Join(rep.Skipped, ", "))
	}
	fmt.Fprintf(w, "Photos: %d restored", rep.PhotosRestored)
	if len(rep.PhotosMissing) > 0 {
		fmt.Fprintf(w, ", %d with no copy in the photo backup:\n", len(rep.PhotosMissing))
		for _, key := range rep.PhotosMissing {
			fmt.Fprintf(w, "  %s\n", key)
		}
	} else {
		fmt.Fprintln(w)
	}
	for _, warning := range rep.Warnings {
		fmt.Fprintf(w, "Note: %s\n", warning)
	}
}

func printFamilyReport(w io.Writer, rep *restore.FamilyReport) {
	fmt.Fprintf(w, "Restored the family %q (%s).\n", rep.Name, rep.FamilyID)
	if rep.PreviousSlug != "" {
		fmt.Fprintf(w, "Its slug %q had been taken; it is now %q.\n", rep.PreviousSlug, rep.Slug)
	}
	fmt.Fprintf(w, "Members: %d back", rep.MembersRejoined)
	if rep.MembersDropped > 0 {
		fmt.Fprintf(w, ", %d left out (their accounts were deleted since; what they logged is the Deleted user's)", rep.MembersDropped)
	}
	fmt.Fprintln(w, ".")
	if !rep.HasAdmin {
		fmt.Fprintln(w, "Nobody left can administer it: make someone its admin on the console's family page.")
	}
	fmt.Fprintln(w, "API keys, kiosk devices and push subscriptions stay gone: re-issue, re-enrol, re-subscribe.")
	printReport(w, &rep.Report)
}

// setPasswordMode sets one account's password — the way back in after a
// whole restore, whose snapshot carried no password hashes, and for any
// locked-out operator.
func setPasswordMode(args []string, stdin io.Reader) int {
	if len(args) != 1 || args[0] == "" || strings.HasPrefix(args[0], "-") {
		fmt.Fprintln(os.Stderr, setPasswordUsage)
		return 2
	}
	password, err := readPassword(stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n%s\n", err, setPasswordUsage)
		return 2
	}

	cfg, err := config.FromOS()
	if err != nil {
		log.Printf("configuration error: %v", err)
		return 1
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	deps, closeDeps, err := buildDeps(ctx, cfg)
	if err != nil {
		log.Printf("startup failed: %v", err)
		return 1
	}
	defer closeDeps()

	var id string
	err = deps.Pool.QueryRow(ctx,
		`SELECT "id" FROM "users" WHERE lower("email") = lower($1) AND "id" <> $2`, args[0], db.TombstoneID,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		log.Printf("set-password: no account for %s", args[0])
		return 1
	}
	if err != nil {
		log.Printf("set-password: %v", err)
		return 1
	}
	if err := deps.Auth.SetPassword(ctx, id, password); err != nil {
		log.Printf("set-password: %v", err)
		return 1
	}
	log.Printf("set-password: password set for %s", args[0])
	return 0
}

// readPassword takes the first line of r. Piped in, never an argument: an
// argument lands in shell history and in every process listing.
func readPassword(r io.Reader) (string, error) {
	line, err := bufio.NewReader(r).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("set-password: read the password: %w", err)
	}
	password := strings.TrimRight(line, "\r\n")
	if len(password) < minPassword {
		return "", fmt.Errorf("set-password: the password must be at least %d characters", minPassword)
	}
	return password, nil
}
