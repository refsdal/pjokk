// Local dev seed: family "Pjokk test", baby Nora (~10 months), caretakers
// Anders (admin) + Kristine (member), and a realistic day of logs so the
// home screen and prefills demo well.
//
//   node scripts/seed.mjs          # writes .seed.sql
//   pnpm seed:local                # generates + applies to the local D1
//
// Sign in locally with anders@pjokk.local / pjokk-dev (or kristine@...).
import { writeFileSync } from "node:fs";
import { hashPassword } from "better-auth/crypto";

const PASSWORD = "pjokk-dev";
const now = Date.now();
const H = 3600_000;
const ms = (hoursAgo) => Math.round(now - hoursAgo * H);
const esc = (s) => `'${String(s).replaceAll("'", "''")}'`;
let n = 0;
const id = (p) => `${p}_seed_${(n++).toString(36).padStart(3, "0")}`;

const FAM = "fam_pjokk_test";
const ANDERS = "user_anders";
const KRISTINE = "user_kristine";
const NORA = "baby_nora";
const hash = await hashPassword(PASSWORD);

const rows = [];
const del = (table) => rows.push(`DELETE FROM ${table};`);
// Idempotent re-seed: wipe domain + auth data (dev database only!).
for (const table of [
  "sleep_log",
  "feed_log",
  "diaper_log",
  "family_invite",
  "baby",
  "invitation",
  "member",
  "organization",
  "passkey",
  "session",
  "account",
  "verification",
  "user",
])
  del(table);

const user = (uid, name, email) => {
  rows.push(
    `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (${esc(uid)}, ${esc(name)}, ${esc(email)}, 1, ${now}, ${now});`,
    `INSERT INTO account (id, issuer, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (${esc(id("acc"))}, 'local:credential', ${esc(uid)}, 'credential', ${esc(uid)}, ${esc(hash)}, ${now}, ${now});`,
  );
};

user(ANDERS, "Anders", "anders@pjokk.local");
user(KRISTINE, "Kristine", "kristine@pjokk.local");

rows.push(
  `INSERT INTO organization (id, name, slug, created_at, plan) VALUES (${esc(FAM)}, 'Pjokk test', 'pjokk-test', ${now}, 'free');`,
  `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (${esc(id("mem"))}, ${esc(FAM)}, ${esc(ANDERS)}, 'admin', ${now});`,
  `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (${esc(id("mem"))}, ${esc(FAM)}, ${esc(KRISTINE)}, 'member', ${now});`,
);

// Nora, born ~10 months ago.
const birth = now - Math.round(10 * 30.4 * 24) * H;
rows.push(
  `INSERT INTO baby (id, family_id, name, birth_date, created_at) VALUES (${esc(NORA)}, ${esc(FAM)}, 'Nora', ${birth}, ${now});`,
);

const feed = (hoursAgo, by, type, extra) =>
  rows.push(
    `INSERT INTO feed_log (id, family_id, baby_id, caretaker_id, time, type, amount_ml, side, duration_min, created_at) VALUES (${esc(id("feed"))}, ${esc(FAM)}, ${esc(NORA)}, ${esc(by)}, ${ms(hoursAgo)}, ${esc(type)}, ${extra.amountMl ?? "NULL"}, ${extra.side ? esc(extra.side) : "NULL"}, ${extra.durationMin ?? "NULL"}, ${now});`,
  );
const diaper = (hoursAgo, by, type) =>
  rows.push(
    `INSERT INTO diaper_log (id, family_id, baby_id, caretaker_id, time, type, created_at) VALUES (${esc(id("dia"))}, ${esc(FAM)}, ${esc(NORA)}, ${esc(by)}, ${ms(hoursAgo)}, ${esc(type)}, ${now});`,
  );
const sleep = (startHoursAgo, endHoursAgo, by, location) =>
  rows.push(
    `INSERT INTO sleep_log (id, family_id, baby_id, caretaker_id, start_time, end_time, location, created_at) VALUES (${esc(id("slp"))}, ${esc(FAM)}, ${esc(NORA)}, ${esc(by)}, ${ms(startHoursAgo)}, ${endHoursAgo === null ? "NULL" : ms(endHoursAgo)}, ${location ? esc(location) : "NULL"}, ${now});`,
  );

// A realistic day, relative to "now" so the home screen always demos well.
sleep(23, 13.5, ANDERS, "crib"); // last night
feed(13.2, KRISTINE, "breast", { side: "left", durationMin: 20 });
diaper(13, ANDERS, "wet");
feed(11.5, ANDERS, "solids", { amountMl: 150 });
diaper(10.8, KRISTINE, "both");
sleep(10.5, 9.25, KRISTINE, "crib"); // morning nap
feed(8.5, KRISTINE, "bottle", { amountMl: 180 });
diaper(7.5, ANDERS, "wet");
sleep(7, 5.5, ANDERS, "stroller"); // afternoon nap
feed(5, ANDERS, "bottle", { amountMl: 160 });
diaper(4, KRISTINE, "dirty");
feed(2.5, KRISTINE, "solids", { amountMl: 120 });
diaper(1.2, ANDERS, "wet");
feed(0.8, KRISTINE, "breast", { side: "right", durationMin: 15 });

writeFileSync(".seed.sql", rows.join("\n") + "\n");
console.log(`wrote .seed.sql (${rows.length} statements)`);
