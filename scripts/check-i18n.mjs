// Guards the English-string-keyed dictionary: renaming a t("…") literal
// silently orphans its translation, so CI fails when a source string has no
// Norwegian entry.
//   node scripts/check-i18n.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "apps/frontend/src";
const DICT_FILE = "apps/frontend/src/lib/i18n.ts";

// Keys intentionally without translation (identical in both languages or
// composed dynamically from translated parts).
const ALLOW = new Set(["~", "min", "d", "Auto", "System", "Data", "admin"]);

const dictSource = readFileSync(DICT_FILE, "utf8");
// Biome unquotes identifier-safe keys (quoteProperties: asNeeded), so match
// both `"Two words":` and `Wake:` forms.
const dictKeys = new Set(
  [
    ...dictSource.matchAll(
      /^\s{2}(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$]*)):/gm,
    ),
  ].map((m) => (m[1] ?? m[2]).replaceAll('\\"', '"')),
);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

const missing = new Map();
for (const file of walk(ROOT)) {
  if (file.endsWith("i18n.ts")) continue;
  // The admin console is deliberately English-only.
  if (file.includes(`${join("screens", "admin")}`)) continue;
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    const key = m[1].replaceAll('\\"', '"');
    if (!dictKeys.has(key) && !ALLOW.has(key)) {
      if (!missing.has(key)) missing.set(key, file);
    }
  }
  for (const m of src.matchAll(/\bt\(\s*\n\s*"((?:[^"\\]|\\.)*)"/g)) {
    const key = m[1].replaceAll('\\"', '"');
    if (!dictKeys.has(key) && !ALLOW.has(key)) {
      if (!missing.has(key)) missing.set(key, file);
    }
  }
}

if (missing.size > 0) {
  console.error(`${missing.size} t() string(s) missing a translation:`);
  for (const [key, file] of missing) {
    console.error(`  "${key}"  (${file})`);
  }
  process.exit(1);
}
console.log(`i18n ok: all t() literals covered (${dictKeys.size} keys)`);
