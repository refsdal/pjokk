// "YYYY-MM-DD HH:MM:SS" written in an IANA zone → epoch ms. A CSV that
// carries no offset (Baby Buddy exports in the server's TIME_ZONE) has to
// be read in the zone it was written in, or every row lands an hour or
// six off. No library: the offset is found by formatting a guess back
// into the zone and correcting once (twice around a DST edge).
const fmtCache = new Map();
function partsIn(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(
    f.formatToParts(ms).map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

export function zonedToUtcMs(text, tz) {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(
      String(text ?? "").trim(),
    );
  if (!m) return null;
  // An explicit offset or Z wins over the zone.
  const explicit = /(?:Z|[+-]\d{2}:?\d{2})$/.test(String(text).trim());
  if (explicit) {
    const t = Date.parse(String(text).trim().replace(" ", "T"));
    return Number.isNaN(t) ? null : t;
  }
  const wall = Date.UTC(
    +m[1],
    +m[2] - 1,
    +m[3],
    +(m[4] ?? 12),
    +(m[5] ?? 0),
    +(m[6] ?? 0),
  );
  if (!tz || tz === "UTC") return wall;
  let guess = wall - (partsIn(wall, tz) - wall);
  guess = wall - (partsIn(guess, tz) - guess);
  return guess;
}
