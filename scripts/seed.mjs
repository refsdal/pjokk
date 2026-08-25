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
const EMIL = "baby_emil";
const hash = await hashPassword(PASSWORD);

const rows = [
  // Safety interlock (issue #3): this table only exists in the LOCAL dev
  // database (created by the seed:local npm script). On any other target the
  // first statement errors and wrangler aborts the whole file before any
  // destructive DELETE runs.
  "DELETE FROM _local_dev_only;",
];
const del = (table) => rows.push(`DELETE FROM ${table};`);
// Idempotent re-seed: wipe domain + auth data (dev database only!).
for (const table of [
  "sleep_log",
  "feed_log",
  "diaper_log",
  "medicine_log",
  "bath_log",
  "note_log",
  "milestone_log",
  "measurement_log",
  "pump_log",
  "family_invite",
  "api_key",
  "admin_audit",
  "push_subscription",
  "push_pref",
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

const user = (uid, name, email, role = null) => {
  rows.push(
    `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES (${esc(uid)}, ${esc(name)}, ${esc(email)}, 1, ${role ? esc(role) : "NULL"}, ${now}, ${now});`,
    `INSERT INTO account (id, issuer, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (${esc(id("acc"))}, 'local:credential', ${esc(uid)}, 'credential', ${esc(uid)}, ${esc(hash)}, ${now}, ${now});`,
  );
};

// Anders is also the system admin in the dev rig.
user(ANDERS, "Anders", "anders@pjokk.local", "admin");
user(KRISTINE, "Kristine", "kristine@pjokk.local");

rows.push(
  `INSERT INTO organization (id, name, slug, created_at, plan) VALUES (${esc(FAM)}, 'Pjokk test', 'pjokk-test', ${now}, 'free');`,
  `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (${esc(id("mem"))}, ${esc(FAM)}, ${esc(ANDERS)}, 'admin', ${now});`,
  `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (${esc(id("mem"))}, ${esc(FAM)}, ${esc(KRISTINE)}, 'member', ${now});`,
);

// Nora (~10 months) and big brother Emil (~2.5 years).
const birth = now - Math.round(10 * 30.4 * 24) * H;
const emilBirth = now - Math.round(30 * 30.4 * 24) * H;
rows.push(
  `INSERT INTO baby (id, family_id, name, birth_date, sex, created_at) VALUES (${esc(NORA)}, ${esc(FAM)}, 'Nora', ${birth}, 'girl', ${now});`,
  `INSERT INTO baby (id, family_id, name, birth_date, sex, created_at) VALUES (${esc(EMIL)}, ${esc(FAM)}, 'Emil', ${emilBirth}, 'boy', ${now + 1});`,
  `INSERT INTO feed_log (id, family_id, baby_id, caretaker_id, time, type, amount_ml, created_at) VALUES (${esc(id("feed"))}, ${esc(FAM)}, ${esc(EMIL)}, ${esc(KRISTINE)}, ${ms(3)}, 'solids', 250, ${now});`,
  `INSERT INTO sleep_log (id, family_id, baby_id, caretaker_id, start_time, end_time, location, created_at) VALUES (${esc(id("slp"))}, ${esc(FAM)}, ${esc(EMIL)}, ${esc(ANDERS)}, ${ms(6)}, ${ms(4.5)}, 'crib', ${now});`,
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

// Phase 3 activity types, sprinkled over the last days.
const simple = (table, hoursAgo, by, cols) => {
  const keys = Object.keys(cols);
  rows.push(
    `INSERT INTO ${table} (id, family_id, baby_id, caretaker_id, time${keys.length ? `, ${keys.map((k) => cols[k].col).join(", ")}` : ""}, created_at) VALUES (${esc(id("oth"))}, ${esc(FAM)}, ${esc(NORA)}, ${esc(by)}, ${ms(hoursAgo)}${keys.length ? `, ${keys.map((k) => cols[k].val).join(", ")}` : ""}, ${now});`,
  );
};
simple("medicine_log", 12.8, ANDERS, {
  name: { col: "name", val: esc("D-vitamin") },
  amount: { col: "amount", val: 5 },
  unit: { col: "unit", val: esc("drops") },
});
simple("bath_log", 26, KRISTINE, {});
simple("note_log", 30, ANDERS, {
  content: { col: "content", val: esc("Slept through the whole grocery run.") },
});
simple("milestone_log", 70, KRISTINE, {
  title: { col: "title", val: esc("Started crawling") },
});
simple("measurement_log", 50, ANDERS, {
  type: { col: "type", val: esc("weight") },
  value: { col: "value", val: 8.4 },
});
simple("measurement_log", 50.05, ANDERS, {
  type: { col: "type", val: esc("length") },
  value: { col: "value", val: 71.5 },
});
simple("pump_log", 9, KRISTINE, {
  side: { col: "side", val: esc("left") },
  amountMl: { col: "amount_ml", val: 90 },
  durationMin: { col: "duration_min", val: 15 },
});

writeFileSync(".seed.sql", `${rows.join("\n")}\n`);
console.log(`wrote .seed.sql (${rows.length} statements)`);
