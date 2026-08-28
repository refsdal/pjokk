import {
  SELF,
  addMember,
  api,
  createBaby,
  createFamily,
  createUser,
  db,
  rig,
  setPlan,
  signIn,
  storage,
} from "./helpers";
import { beforeEach, describe, expect, it } from "bun:test";
import { familyScope } from "../src/db/scoped";

const BASE = "http://localhost";

// Multipart upload goes straight through SELF: the `api` helper always sends
// a JSON content-type.
async function upload(
  vaccineId: string,
  cookie: string,
  file: { name: string; type: string; bytes: Uint8Array },
) {
  const form = new FormData();
  form.append("file", new File([file.bytes], file.name, { type: file.type }));
  return SELF.fetch(`${BASE}/api/vaccines/${vaccineId}/documents`, {
    method: "POST",
    headers: { origin: BASE, cookie },
    body: form,
  });
}

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

async function makeVaccine(cookie: string, babyId: string, name = "MMR") {
  const res = await api("/api/vaccines", {
    method: "POST",
    cookie,
    body: {
      babyId,
      time: new Date().toISOString(),
      name,
      doseNumber: 1,
      scheduleSlot: "mmr:1",
    },
  });
  return (await res.json()) as {
    id: string;
    name: string;
    doseNumber: number | null;
    scheduleSlot: string | null;
    documents: { id: string; url: string }[];
  };
}

describe("vaccine log", () => {
  it("is free to create — no premium gate on the record itself", async () => {
    const { cookie, baby } = await rig();

    const res = await api("/api/vaccines", {
      method: "POST",
      cookie,
      body: {
        babyId: baby.id,
        time: new Date().toISOString(),
        name: "DTP-IPV-Hib-HepB",
        doseNumber: 1,
        scheduleSlot: "dtp-ipv-hib-hepb:1",
      },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      name: string;
      scheduleSlot: string | null;
      documents: unknown[];
    };
    expect(created.name).toBe("DTP-IPV-Hib-HepB");
    expect(created.scheduleSlot).toBe("dtp-ipv-hib-hepb:1");
    expect(created.documents).toEqual([]);
  });

  it("accepts an off-programme vaccine with no slot", async () => {
    const { cookie, baby } = await rig();
    const created = await makeVaccine(cookie, baby.id, "Yellow fever");
    const res = await api(`/api/vaccines/${created.id}`, {
      method: "PATCH",
      cookie,
      body: { scheduleSlot: null, doseNumber: null },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as {
      scheduleSlot: string | null;
      doseNumber: number | null;
    };
    expect(updated.scheduleSlot).toBeNull();
    expect(updated.doseNumber).toBeNull();
  });

  it("appears in the timeline under the other filter", async () => {
    const { cookie, baby } = await rig();
    await makeVaccine(cookie, baby.id);

    const res = await api(`/api/timeline?babyId=${baby.id}&filter=other`, {
      cookie,
    });
    const { entries } = (await res.json()) as {
      entries: { kind: string; name?: string }[];
    };
    expect(entries.find((e) => e.kind === "vaccine")?.name).toBe("MMR");
  });

  it("404s on an unknown baby and keeps families apart", async () => {
    const { cookie } = await rig();
    const otherFamily = await createFamily("Other family");
    const theirBaby = await createBaby(otherFamily.id, "Their baby");

    const res = await api("/api/vaccines", {
      method: "POST",
      cookie,
      body: {
        babyId: theirBaby.id,
        time: new Date().toISOString(),
        name: "MMR",
      },
    });
    expect(res.status).toBe(404);
  });
});

describe("vaccine documents (uploads disabled)", () => {
  it("refuses uploads on every plan", async () => {
    const { family, cookie, baby } = await rig();
    const entry = await makeVaccine(cookie, baby.id);

    const onFree = await upload(entry.id, cookie, {
      name: "card.png",
      type: "image/png",
      bytes: png(),
    });
    expect(onFree.status).toBe(403);
    expect(((await onFree.json()) as { code: string }).code).toBe(
      "FEATURE_DISABLED",
    );

    // Not a paywall — premium is refused identically.
    await setPlan(family.id, "premium");
    const onPremium = await upload(entry.id, cookie, {
      name: "card.png",
      type: "image/png",
      bytes: png(),
    });
    expect(onPremium.status).toBe(403);
  });

  // Reading and erasing must keep working for anything already stored,
  // whatever the upload switch says — otherwise disabling the feature would
  // strand data a family has the right to get back and delete.
  it("still serves and deletes a document that already exists", async () => {
    const { family, cookie, baby } = await rig();
    const entry = await makeVaccine(cookie, baby.id);

    const fam = familyScope(db(), family.id);
    const objectKey = `vaccine-docs/${family.id}/seeded`;
    await storage.put(objectKey, new Blob([png()]), "image/png");
    const docId = await fam.createVaccineDocument({
      vaccineLogId: entry.id,
      objectKey,
      filename: "card.png",
      contentType: "image/png",
      size: png().length,
      uploadedBy: (await fam.members())[0]!.userId,
    });

    const fetched = await api(`/api/files/${docId}`, { cookie });
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-disposition")).toContain("attachment");
    expect(fetched.headers.get("x-content-type-options")).toBe("nosniff");

    const removed = await api(`/api/files/${docId}`, {
      method: "DELETE",
      cookie,
    });
    expect(removed.status).toBe(200);
    expect(await storage.read(objectKey)).toBeNull();
  });

  it("still removes stored objects when the vaccine is deleted", async () => {
    const { family, cookie, baby } = await rig();
    const entry = await makeVaccine(cookie, baby.id);

    const fam = familyScope(db(), family.id);
    const objectKey = `vaccine-docs/${family.id}/seeded-cascade`;
    await storage.put(objectKey, new Blob([png()]));
    await fam.createVaccineDocument({
      vaccineLogId: entry.id,
      objectKey,
      filename: "card.png",
      contentType: "image/png",
      size: png().length,
      uploadedBy: (await fam.members())[0]!.userId,
    });

    expect(
      (await api(`/api/vaccines/${entry.id}`, { method: "DELETE", cookie }))
        .status,
    ).toBe(200);
    // No orphan bytes left behind in the bucket.
    expect(await storage.read(objectKey)).toBeNull();
  });
});

describe("vaccine dismissals", () => {
  // One sign-in for the whole block: the KV brute-force brake caps sign-ins
  // per IP, and a file that logs in per test eventually trips it. Each test
  // gets its own baby instead, which is the isolation that actually matters
  // here — dismissals are per-baby.
  let shared: Awaited<ReturnType<typeof rig>>;
  // beforeEach, not beforeAll: the database is emptied before every test (see
  // test/setup.ts), so a fixture built once for the whole describe block would
  // be truncated out from under the second test.
  beforeEach(async () => {
    shared = await rig("Dismissal family");
  });
  const freshBaby = (name: string) => createBaby(shared.family.id, name);

  it("dismisses a slot, lists it, and restores it — all on the free plan", async () => {
    const { cookie } = shared;
    const baby = await freshBaby("Dismiss baby");

    const created = await api("/api/vaccines/dismissals", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, slotKey: "hpv:1" },
    });
    expect(created.status).toBe(201);
    const dismissal = (await created.json()) as {
      id: string;
      slotKey: string;
    };
    expect(dismissal.slotKey).toBe("hpv:1");

    const listed = await api(`/api/vaccines/dismissals?babyId=${baby.id}`, {
      cookie,
    });
    expect((await listed.json()) as unknown[]).toHaveLength(1);

    const restored = await api(`/api/vaccines/dismissals/${dismissal.id}`, {
      method: "DELETE",
      cookie,
    });
    expect(restored.status).toBe(200);
    const after = await api(`/api/vaccines/dismissals?babyId=${baby.id}`, {
      cookie,
    });
    expect((await after.json()) as unknown[]).toEqual([]);
  });

  it("is idempotent — dismissing twice returns the same row", async () => {
    const { cookie } = shared;
    const baby = await freshBaby("Idempotent baby");
    const body = { babyId: baby.id, slotKey: "mmr:1" };

    const first = await api("/api/vaccines/dismissals", {
      method: "POST",
      cookie,
      body,
    });
    const second = await api("/api/vaccines/dismissals", {
      method: "POST",
      cookie,
      body,
    });
    expect(second.status).toBe(201);
    expect(((await second.json()) as { id: string }).id).toBe(
      ((await first.json()) as { id: string }).id,
    );

    const listed = await api(`/api/vaccines/dismissals?babyId=${baby.id}`, {
      cookie,
    });
    expect((await listed.json()) as unknown[]).toHaveLength(1);
  });

  it("keeps dismissals per baby, not per family", async () => {
    const { cookie } = shared;
    const baby = await freshBaby("Has dismissal");
    const sibling = await freshBaby("Sibling");
    await api("/api/vaccines/dismissals", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, slotKey: "mmr:1" },
    });

    const theirs = await api(`/api/vaccines/dismissals?babyId=${sibling.id}`, {
      cookie,
    });
    expect((await theirs.json()) as unknown[]).toEqual([]);
  });

  it("does not block logging the vaccine afterwards", async () => {
    const { cookie } = shared;
    const baby = await freshBaby("Logs anyway");
    await api("/api/vaccines/dismissals", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, slotKey: "mmr:1" },
    });

    const logged = await api("/api/vaccines", {
      method: "POST",
      cookie,
      body: {
        babyId: baby.id,
        time: new Date().toISOString(),
        name: "MMR",
        doseNumber: 1,
        scheduleSlot: "mmr:1",
      },
    });
    expect(logged.status).toBe(201);
  });

  it("404s on an unknown baby", async () => {
    const { cookie } = shared;
    const otherFamily = await createFamily("Other dismissal family");
    const theirBaby = await createBaby(otherFamily.id, "Their baby");

    const foreign = await api("/api/vaccines/dismissals", {
      method: "POST",
      cookie,
      body: { babyId: theirBaby.id, slotKey: "mmr:1" },
    });
    expect(foreign.status).toBe(404);
  });

  it("never lets another family restore our dismissal", async () => {
    const { cookie } = shared;
    const baby = await freshBaby("Guarded baby");
    const ours = await api("/api/vaccines/dismissals", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, slotKey: "mmr:1" },
    });
    const { id } = (await ours.json()) as { id: string };

    const outsider = await createUser("Dismissal outsider");
    const otherFamily = await createFamily("Outsider family");
    await addMember(outsider.id, otherFamily.id, "admin");
    const otherCookie = await signIn(outsider.email);

    expect(
      (
        await api(`/api/vaccines/dismissals/${id}`, {
          method: "DELETE",
          cookie: otherCookie,
        })
      ).status,
    ).toBe(404);
    // Still ours, i.e. the refusal deleted nothing.
    const listed = await api(`/api/vaccines/dismissals?babyId=${baby.id}`, {
      cookie,
    });
    expect((await listed.json()) as unknown[]).toHaveLength(1);
  });

  it("does not mistake the dismissals path for a vaccine id", async () => {
    const { cookie } = shared;
    const baby = await freshBaby("Routing baby");
    // Ordering hazard: /api/vaccines/{id} could swallow "dismissals".
    const res = await api(`/api/vaccines/dismissals?babyId=${baby.id}`, {
      cookie,
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
