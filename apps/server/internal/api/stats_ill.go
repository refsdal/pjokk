package api

// Ill days in Stats (issue #127): "how much has she actually been ill?".
// Illness episodes are spans; Stats counts the local DAYS they touched.
// Pure, so the edges are tested without a database.

// illSpan is one episode in epoch milliseconds; endMs < 0 means still ill.
type illSpan struct {
	startMs int64
	endMs   int64
}

// illDayIndexes returns the day indexes, within [rangeFrom, rangeTo), that
// any episode touched. dayIndex is GetStats' own local-day function, so an
// "ill day" is cut at the same midnight as a day's sleep and feeds.
//
//   - An open episode runs to now: she is ill today, not for the rest of
//     the window.
//   - An episode that ends exactly at local midnight did not touch the day
//     that begins there, hence the millisecond taken off its end.
//   - A day two episodes share is one ill day: the result is a set.
func illDayIndexes(spans []illSpan, rangeFrom, rangeTo, now int64, dayIndex func(int64) int64) map[int64]bool {
	days := map[int64]bool{}
	for _, s := range spans {
		start, end := s.startMs, s.endMs
		if end < 0 || end > now {
			end = now
		} else {
			end--
		}
		if start < rangeFrom {
			start = rangeFrom
		}
		if end >= rangeTo {
			end = rangeTo - 1
		}
		if end < start {
			continue
		}
		for i := dayIndex(start); i <= dayIndex(end); i++ {
			days[i] = true
		}
	}
	return days
}
