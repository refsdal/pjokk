package api

import (
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports apps/api/src/routes/export.ts's CSV export of every log
// in the family, chronological, one row per entry — hand-routed OUTSIDE
// the generated strict server (see api.go's package doc comment and
// files.go's, which this file follows exactly): a CSV body isn't JSON, so
// oapi-codegen's zod-openapi-equivalent route tree has no way to express
// it, the same reason apps/api's own exportApp is a plain Hono app rather
// than `createApp<FamEnv>().openapi(...)`. /api/export.csv is therefore not
// in openapi/pjokk.yaml at all (unlike GetStats, which goes through the
// strict server) — see api.go's skipSpecValidation, which already excludes
// it from kin-openapi request validation.
//
// Mounted behind familyChain (api.go) — the SAME apiKeyAuth + Session +
// RequireFamily chain every tierFamily operation runs behind, no admin
// check, no plan gate: apps/api/src/app.ts mounts exportApp under
// domainBase's plain "/api/*" requireFamily middleware (not requireAdmin,
// not rejectApiKey — export.ts's own handler never calls canUse either,
// unlike the "csvExport" feature flag apps/api/src/entitlements.ts still
// declares, which is dead code: nothing in apps/api reads it). API keys
// are therefore allowed, matching /api/files.

// exportMaxRows is apps/api/src/routes/export.ts's `MAX = 100_000`, applied
// per kind (eleven queries below, LIMIT sqlc.arg(lim) each).
const exportMaxRows = 100_000

// formulaGuard/needsQuoting/esc port export.ts's esc() byte for byte,
// INCLUDING its one quirk: needsQuoting also fires on a bare single quote
// (') even though RFC 4180 never requires quoting for one — the TS
// predecessor's regex is `/[",\n']/`, and this port keeps that behaviour
// rather than "fixing" it, since a stricter escaper is still a correct
// (if slightly more eager) CSV, and matching the TS byte-for-byte is what
// this task asked for.
var (
	formulaGuard = regexp.MustCompile(`^[=+\-@\t\r]`)
	needsQuoting = regexp.MustCompile(`["\n',]`)
)

// esc formats one CSV cell. nil renders as "". A leading =, +, -, @, tab,
// or CR gets a leading apostrophe FIRST (formula-injection guard — REF sec
// review M1, ported verbatim from export.ts's esc doc comment) so the cell
// can never execute as a formula in Excel/Sheets; the (possibly
// apostrophe-prefixed) result is THEN RFC-4180-quoted if it matches
// needsQuoting, doubling any interior double quotes. Order matters — a
// formula-guarded string that also needs quoting gets both, guard first.
func esc(v *string) string {
	if v == nil {
		return ""
	}
	s := *v
	if formulaGuard.MatchString(s) {
		s = "'" + s
	}
	if needsQuoting.MatchString(s) {
		s = `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

// exportHeaders is export.ts's HEADERS, verbatim and in the same order —
// the CSV's first line and the render loop's column order.
var exportHeaders = []string{
	"kind", "baby", "time", "end_time", "type", "detail", "amount", "unit",
	"side", "duration_min", "value", "location", "caretaker", "notes",
}

// exportRow is one CSV data row: every cell is pre-formatted to its final
// string (or nil for an empty cell) at construction time in the rowX
// functions below, so the render loop is pure string-joining + esc(),
// identical for every kind. sortTime is the row's chronological key (never
// itself rendered) — "time" for every kind except sleep/play, which sort
// by start_time (mirrors export.ts's `sortMs`).
type exportRow struct {
	sortTime time.Time
	cells    map[string]*string
}

func str(s string) *string { return &s }

func fmtInt32(v *int32) *string {
	if v == nil {
		return nil
	}
	return str(strconv.Itoa(int(*v)))
}

func fmtFloat64(v float64) *string {
	// 'f'/-1 gives the shortest fixed-notation (never scientific) decimal
	// that round-trips — the closest Go equivalent to JS's String(n) for
	// the modest weight/dose/amount ranges this app ever stores.
	return str(strconv.FormatFloat(v, 'f', -1, 64))
}

func fmtTS(t pgtype.Timestamptz) *string {
	if !t.Valid {
		return nil
	}
	return str(t.Time.UTC().Format(time.RFC3339Nano))
}

func rowFeed(r dbgen.ExportFeedsRow) exportRow {
	var unit *string
	if r.AmountMl != nil {
		if r.Type == "solids" {
			unit = str("g")
		} else {
			unit = str("ml")
		}
	}
	return exportRow{
		sortTime: r.Time.Time,
		cells: map[string]*string{
			"kind":         str("feed"),
			"baby":         str(r.BabyName),
			"time":         fmtTS(r.Time),
			"type":         str(r.Type),
			"amount":       fmtInt32(r.AmountMl),
			"unit":         unit,
			"side":         r.Side,
			"duration_min": fmtInt32(r.DurationMin),
			"caretaker":    str(r.CaretakerName),
			"notes":        r.Notes,
		},
	}
}

func rowDiaper(r dbgen.ExportDiapersRow) exportRow {
	return exportRow{
		sortTime: r.Time.Time,
		cells: map[string]*string{
			"kind":      str("diaper"),
			"baby":      str(r.BabyName),
			"time":      fmtTS(r.Time),
			"type":      str(r.Type),
			"caretaker": str(r.CaretakerName),
			"notes":     r.Notes,
		},
	}
}

func rowSleep(r dbgen.ExportSleepsRow) exportRow {
	return exportRow{
		sortTime: r.StartTime.Time,
		cells: map[string]*string{
			"kind":      str("sleep"),
			"baby":      str(r.BabyName),
			"time":      fmtTS(r.StartTime),
			"end_time":  fmtTS(r.EndTime),
			"location":  r.Location,
			"caretaker": str(r.CaretakerName),
			"notes":     r.Notes,
		},
	}
}

func rowMedicine(r dbgen.ExportMedicineRow) exportRow {
	var amount *string
	if r.Amount != nil {
		amount = fmtFloat64(*r.Amount)
	}
	return exportRow{
		sortTime: r.Time.Time,
		cells: map[string]*string{
			"kind":      str("medicine"),
			"baby":      str(r.BabyName),
			"time":      fmtTS(r.Time),
			"detail":    str(r.Name),
			"amount":    amount,
			"unit":      r.Unit,
			"caretaker": str(r.CaretakerName),
			"notes":     r.Notes,
		},
	}
}

func rowBath(r dbgen.ExportBathsRow) exportRow {
	return exportRow{
		sortTime: r.Time.Time,
		cells: map[string]*string{
			"kind":      str("bath"),
			"baby":      str(r.BabyName),
			"time":      fmtTS(r.Time),
			"caretaker": str(r.CaretakerName),
			"notes":     r.Notes,
		},
	}
}

func rowNote(r dbgen.ExportNotesRow) exportRow {
	return exportRow{
		sortTime: r.Time.Time,
		cells: map[string]*string{
			"kind":      str("note"),
			"baby":      str(r.BabyName),
			"time":      fmtTS(r.Time),
			"detail":    str(r.Content),
			"caretaker": str(r.CaretakerName),
			"notes":     r.Notes,
		},
	}
}

func rowMilestone(r dbgen.ExportMilestonesRow) exportRow {
	return exportRow{
		sortTime: r.Time.Time,
		cells: map[string]*string{
			"kind":      str("milestone"),
			"baby":      str(r.BabyName),
			"time":      fmtTS(r.Time),
			"detail":    str(r.Title),
			"caretaker": str(r.CaretakerName),
			"notes":     r.Notes,
		},
	}
}

func rowMeasurement(r dbgen.ExportMeasurementsRow) exportRow {
	unit := "cm"
	if r.Type == "weight" {
		unit = "kg"
	}
	return exportRow{
		sortTime: r.Time.Time,
		cells: map[string]*string{
			"kind":      str("measurement"),
			"baby":      str(r.BabyName),
			"time":      fmtTS(r.Time),
			"type":      str(r.Type),
			"value":     fmtFloat64(r.Value),
			"unit":      str(unit),
			"caretaker": str(r.CaretakerName),
			"notes":     r.Notes,
		},
	}
}

func rowPump(r dbgen.ExportPumpsRow) exportRow {
	var unit *string
	if r.AmountMl != nil {
		unit = str("ml")
	}
	return exportRow{
		sortTime: r.Time.Time,
		cells: map[string]*string{
			"kind":         str("pump"),
			"baby":         str(r.BabyName),
			"time":         fmtTS(r.Time),
			"amount":       fmtInt32(r.AmountMl),
			"unit":         unit,
			"side":         r.Side,
			"duration_min": fmtInt32(r.DurationMin),
			"caretaker":    str(r.CaretakerName),
			"notes":        r.Notes,
		},
	}
}

func rowPlay(r dbgen.ExportPlaysRow) exportRow {
	var durationMin *string
	if r.EndTime.Valid {
		mins := int64(r.EndTime.Time.Sub(r.StartTime.Time).Round(time.Minute) / time.Minute)
		durationMin = str(strconv.FormatInt(mins, 10))
	}
	return exportRow{
		sortTime: r.StartTime.Time,
		cells: map[string]*string{
			"kind":         str("play"),
			"baby":         str(r.BabyName),
			"time":         fmtTS(r.StartTime),
			"end_time":     fmtTS(r.EndTime),
			"type":         str(r.Type),
			"duration_min": durationMin,
			"caretaker":    str(r.CaretakerName),
			"notes":        r.Notes,
		},
	}
}

func rowVaccine(r dbgen.ExportVaccinesRow) exportRow {
	return exportRow{
		sortTime: r.Time.Time,
		cells: map[string]*string{
			"kind":      str("vaccine"),
			"baby":      str(r.BabyName),
			"time":      fmtTS(r.Time),
			"detail":    str(r.Name),
			"value":     fmtInt32(r.DoseNumber),
			"caretaker": str(r.CaretakerName),
			"notes":     r.Notes,
		},
	}
}

// exportCSV implements GET /api/export.csv. REF: "text/csv; charset=utf-8,
// content-disposition attachment, filename pjokk-export-YYYY-MM-DD.csv
// (UTC date from Deps.Now); every log source, MAX 100000 rows each,
// ascending by time".
func (d Deps) exportCSV(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fam := middleware.FamilyFromContext(ctx)
	lim := int32(exportMaxRows)

	rows := make([]exportRow, 0, 256)

	feeds, err := d.Q.ExportFeeds(ctx, dbgen.ExportFeedsParams{FamilyID: fam.FamilyID, Lim: lim})
	if err != nil {
		internalError(w, r, err)
		return
	}
	for _, v := range feeds {
		rows = append(rows, rowFeed(v))
	}

	diapers, err := d.Q.ExportDiapers(ctx, dbgen.ExportDiapersParams{FamilyID: fam.FamilyID, Lim: lim})
	if err != nil {
		internalError(w, r, err)
		return
	}
	for _, v := range diapers {
		rows = append(rows, rowDiaper(v))
	}

	sleeps, err := d.Q.ExportSleeps(ctx, dbgen.ExportSleepsParams{FamilyID: fam.FamilyID, Lim: lim})
	if err != nil {
		internalError(w, r, err)
		return
	}
	for _, v := range sleeps {
		rows = append(rows, rowSleep(v))
	}

	meds, err := d.Q.ExportMedicine(ctx, dbgen.ExportMedicineParams{FamilyID: fam.FamilyID, Lim: lim})
	if err != nil {
		internalError(w, r, err)
		return
	}
	for _, v := range meds {
		rows = append(rows, rowMedicine(v))
	}

	baths, err := d.Q.ExportBaths(ctx, dbgen.ExportBathsParams{FamilyID: fam.FamilyID, Lim: lim})
	if err != nil {
		internalError(w, r, err)
		return
	}
	for _, v := range baths {
		rows = append(rows, rowBath(v))
	}

	notes, err := d.Q.ExportNotes(ctx, dbgen.ExportNotesParams{FamilyID: fam.FamilyID, Lim: lim})
	if err != nil {
		internalError(w, r, err)
		return
	}
	for _, v := range notes {
		rows = append(rows, rowNote(v))
	}

	milestones, err := d.Q.ExportMilestones(ctx, dbgen.ExportMilestonesParams{FamilyID: fam.FamilyID, Lim: lim})
	if err != nil {
		internalError(w, r, err)
		return
	}
	for _, v := range milestones {
		rows = append(rows, rowMilestone(v))
	}

	meas, err := d.Q.ExportMeasurements(ctx, dbgen.ExportMeasurementsParams{FamilyID: fam.FamilyID, Lim: lim})
	if err != nil {
		internalError(w, r, err)
		return
	}
	for _, v := range meas {
		rows = append(rows, rowMeasurement(v))
	}

	pumps, err := d.Q.ExportPumps(ctx, dbgen.ExportPumpsParams{FamilyID: fam.FamilyID, Lim: lim})
	if err != nil {
		internalError(w, r, err)
		return
	}
	for _, v := range pumps {
		rows = append(rows, rowPump(v))
	}

	plays, err := d.Q.ExportPlays(ctx, dbgen.ExportPlaysParams{FamilyID: fam.FamilyID, Lim: lim})
	if err != nil {
		internalError(w, r, err)
		return
	}
	for _, v := range plays {
		rows = append(rows, rowPlay(v))
	}

	vaccines, err := d.Q.ExportVaccines(ctx, dbgen.ExportVaccinesParams{FamilyID: fam.FamilyID, Lim: lim})
	if err != nil {
		internalError(w, r, err)
		return
	}
	for _, v := range vaccines {
		rows = append(rows, rowVaccine(v))
	}

	// Every per-kind slice above is already ASCENDING by (time, id) — see
	// queries/export.sql's ORDER BY on each — and appended here in the
	// SAME kind order export.ts's `rows` array literal uses (feed, diaper,
	// sleep, medicine, bath, note, milestone, measurement, pump, play,
	// vaccine). A stable sort by sortTime then reproduces a single
	// ascending-by-time file: ties (rows from different kinds sharing an
	// exact timestamp) keep that kind order, which is a deterministic
	// choice this port makes rather than one export.ts's own JS-stable-sort
	// tie-break happens to produce — the contract ("ascending order") does
	// not depend on which kind wins a tie.
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].sortTime.Before(rows[j].sortTime) })

	var b strings.Builder
	b.WriteString(strings.Join(exportHeaders, ","))
	for _, row := range rows {
		b.WriteByte('\n')
		for i, h := range exportHeaders {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(esc(row.cells[h]))
		}
	}

	stamp := d.Now().UTC().Format("2006-01-02")
	h := w.Header()
	h.Set("Content-Type", "text/csv; charset=utf-8")
	h.Set("Content-Disposition", `attachment; filename="pjokk-export-`+stamp+`.csv"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(b.String()))
}

// mountExportRoutes registers GET /api/export.csv on mux, wrapped in chain
// (the tierFamily chain NewHandler builds — see api.go's familyChain).
// Split out for the same reason mountFileRoutes is: one place names every
// hand-routed path, independent of NewHandler's own layout.
func (d Deps) mountExportRoutes(mux *http.ServeMux, chain func(http.Handler) http.Handler) {
	mux.Handle("GET /api/export.csv", chain(http.HandlerFunc(d.exportCSV)))
}
