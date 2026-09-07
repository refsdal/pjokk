// A small RFC 4180 reader — quoted fields, doubled quotes, embedded
// newlines, CRLF — returning objects keyed by the header row. No
// dependency: the importers run with plain node.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const src = text.startsWith("\ufeff") ? text.slice(1) : text;
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows
    .slice(1)
    .filter((r) => r.some((v) => v !== ""))
    .map((r) => Object.fromEntries(headers.map((h, k) => [h, r[k] ?? ""])));
  return { headers, rows: records };
}
