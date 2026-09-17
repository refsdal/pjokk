package api

import "testing"

// illDayIndexes' edges (issue #127), without a database. Days are 24 h from
// zero here; GetStats passes its own local-day function.
func TestIllDayIndexes(t *testing.T) {
	const day = int64(86_400_000)
	idx := func(ms int64) int64 { return ms / day }
	at := func(d int64, hours float64) int64 { return d*day + int64(hours*3_600_000) }
	from, to := at(10, 0), at(17, 0) // a seven-day window: days 10..16
	now := at(16, 12)                // noon on the last day

	for name, c := range map[string]struct {
		spans []illSpan
		want  []int64
	}{
		"an afternoon to a morning two days on touches three days":   {[]illSpan{{at(11, 15), at(13, 9)}}, []int64{11, 12, 13}},
		"ending exactly at midnight does not touch the next day":     {[]illSpan{{at(11, 15), at(13, 0)}}, []int64{11, 12}},
		"an open episode runs to today, not to the window's end":     {[]illSpan{{at(15, 8), -1}}, []int64{15, 16}},
		"one that began before the window counts from its first day": {[]illSpan{{at(3, 8), at(11, 8)}}, []int64{10, 11}},
		"two episodes sharing a day make it one ill day":             {[]illSpan{{at(12, 6), at(12, 20)}, {at(12, 22), at(13, 8)}}, []int64{12, 13}},
		"entirely before the window is nothing":                      {[]illSpan{{at(3, 8), at(5, 8)}}, nil},
		"a future end is clipped to now":                             {[]illSpan{{at(16, 6), at(20, 0)}}, []int64{16}},
		"no episodes":                                                {nil, nil},
	} {
		got := illDayIndexes(c.spans, from, to, now, idx)
		if len(got) != len(c.want) {
			t.Errorf("%s: got %v, want %v", name, got, c.want)
			continue
		}
		for _, d := range c.want {
			if !got[d] {
				t.Errorf("%s: day %d missing from %v", name, d, got)
			}
		}
	}
}
