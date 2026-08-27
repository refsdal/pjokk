import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { schema } from "../src/worker/db";
import { familyScope } from "../src/worker/db/scoped";
import {
  addMember,
  api,
  createBaby,
  createFamily,
  createUser,
  db,
  rig,
  setPlan,
  signIn,
} from "./helpers";

const BASE = "http://localhost";

// Multipart upload goes straight through SELF: the `api` helper always sends
// a JSON content-type.
async function upload(
  vaccineId: string,
  cookie: string,
  file: { name: string; type: string; bytes: Uint8Array },
) {
  const form = new FormData();
  form.append(
    "file",
    new File([file.bytes as BufferSource], file.name, { type: file.type }),
  );
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

describe("vaccine documents", () => {
  it("requires premium to upload, but never to read or delete", async () => {
    const { family, cookie, baby } = await rig();
    const entry = await makeVaccine(cookie, baby.id);

    const denied = await upload(entry.id, cookie, {
      name: "card.png",
      type: "image/png",
      bytes: png(),
    });
    expect(denied.status).toBe(402);
    expect(((await denied.json()) as { code: string }).code).toBe(
      "PLAN_REQUIRED",
    );

    await setPlan(family.id, "premium");
    const ok = await upload(entry.id, cookie, {
      name: "card.png",
      type: "image/png",
      bytes: png(),
    });
    expect(ok.status).toBe(201);
    const doc = (await ok.json()) as { id: string; url: string };
    expect(doc.url).toBe(`/api/files/${doc.id}`);

    // Downgrade: the file must stay readable and deletable.
    await setPlan(family.id, "free");
    const fetched = await api(`/api/files/${doc.id}`, { cookie });
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(png());

    const removed = await api(`/api/files/${doc.id}`, {
      method: "DELETE",
      cookie,
    });
    expect(removed.status).toBe(200);
    expect((await api(`/api/files/${doc.id}`, { cookie })).status).toBe(404);
  });

  it("serves attachments as downloads, never inline", async () => {
    const { family, cookie, baby } = await rig();
    await setPlan(family.id, "premium");
    const entry = await makeVaccine(cookie, baby.id);
    const res = await upload(entry.id, cookie, {
      name: "card.png",
      type: "image/png",
      bytes: png(),
    });
    const doc = (await res.json()) as { id: string };

    const fetched = await api(`/api/files/${doc.id}`, { cookie });
    expect(fetched.headers.get("content-disposition")).toContain("attachment");
    expect(fetched.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses types outside the images-and-PDF allowlist", async () => {
    const { family, cookie, baby } = await rig();
    await setPlan(family.id, "premium");
    const entry = await makeVaccine(cookie, baby.id);

    const res = await upload(entry.id, cookie, {
      name: "evil.html",
      type: "text/html",
      bytes: new TextEncoder().encode("<script>alert(1)</script>"),
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { code: string }).code).toBe("BAD_TYPE");
  });

  it("refuses a file over the size cap", async () => {
    const { family, cookie, baby } = await rig();
    await setPlan(family.id, "premium");
    const entry = await makeVaccine(cookie, baby.id);

    const res = await upload(entry.id, cookie, {
      name: "huge.pdf",
      type: "application/pdf",
      bytes: new Uint8Array(10 * 1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });

  it("caps the number of files per entry", async () => {
    const { family, cookie, baby } = await rig();
    await setPlan(family.id, "premium");
    const entry = await makeVaccine(cookie, baby.id);

    for (let i = 0; i < 5; i++) {
      const res = await upload(entry.id, cookie, {
        name: `card${i}.png`,
        type: "image/png",
        bytes: png(),
      });
      expect(res.status).toBe(201);
    }
    const sixth = await upload(entry.id, cookie, {
      name: "card5.png",
      type: "image/png",
      bytes: png(),
    });
    expect(sixth.status).toBe(400);
    expect(((await sixth.json()) as { code: string }).code).toBe("TOO_MANY");
  });

  it("hydrates documents onto the entry", async () => {
    const { family, cookie, baby } = await rig();
    await setPlan(family.id, "premium");
    const entry = await makeVaccine(cookie, baby.id);
    await upload(entry.id, cookie, {
      name: "card.png",
      type: "image/png",
      bytes: png(),
    });

    const listed = await api(`/api/vaccines?babyId=${baby.id}`, { cookie });
    const rows = (await listed.json()) as {
      documents: { filename: string; size: number; url: string }[];
    }[];
    expect(rows[0]!.documents).toHaveLength(1);
    expect(rows[0]!.documents[0]!.filename).toBe("card.png");
    expect(rows[0]!.documents[0]!.size).toBe(png().length);
  });

  it("removes the R2 object when the entry is deleted", async () => {
    const { family, cookie, baby } = await rig();
    await setPlan(family.id, "premium");
    const entry = await makeVaccine(cookie, baby.id);
    await upload(entry.id, cookie, {
      name: "card.png",
      type: "image/png",
      bytes: png(),
    });

    const fam = familyScope(db(), family.id);
    const before = await fam.getVaccine(entry.id);
    const key = (await db().select().from(schema.vaccineDocument)).find(
      (d) => d.vaccineLogId === entry.id,
    )!.objectKey;
    expect(before!.documents).toHaveLength(1);
    expect(await env.FILES.get(key)).not.toBeNull();

    const removed = await api(`/api/vaccines/${entry.id}`, {
      method: "DELETE",
      cookie,
    });
    expect(removed.status).toBe(200);
    // No orphan bytes left behind in the bucket.
    expect(await env.FILES.get(key)).toBeNull();
  });

  it("never serves another family's document", async () => {
    const { family, cookie, baby } = await rig();
    await setPlan(family.id, "premium");
    const entry = await makeVaccine(cookie, baby.id);
    const uploaded = await upload(entry.id, cookie, {
      name: "card.png",
      type: "image/png",
      bytes: png(),
    });
    const doc = (await uploaded.json()) as { id: string };

    const outsider = await createUser("Outsider");
    const otherFamily = await createFamily("Other family");
    await addMember(outsider.id, otherFamily.id, "admin");
    const otherCookie = await signIn(outsider.email);

    expect(
      (await api(`/api/files/${doc.id}`, { cookie: otherCookie })).status,
    ).toBe(404);
    expect(
      (
        await api(`/api/files/${doc.id}`, {
          method: "DELETE",
          cookie: otherCookie,
        })
      ).status,
    ).toBe(404);
    // And ours still works, i.e. the refusal above deleted nothing.
    expect((await api(`/api/files/${doc.id}`, { cookie })).status).toBe(200);
  });

  it("refuses to attach to another family's vaccine entry", async () => {
    const { family, cookie, baby } = await rig();
    await setPlan(family.id, "premium");
    const entry = await makeVaccine(cookie, baby.id);

    const outsider = await createUser("Outsider");
    const otherFamily = await createFamily("Other family");
    await addMember(outsider.id, otherFamily.id, "admin");
    await setPlan(otherFamily.id, "premium");
    const otherCookie = await signIn(outsider.email);

    const res = await upload(entry.id, otherCookie, {
      name: "card.png",
      type: "image/png",
      bytes: png(),
    });
    expect(res.status).toBe(404);
  });
});

describe("vaccine dismissals", () => {
  // One sign-in for the whole block: the KV brute-force brake caps sign-ins
  // per IP, and a file that logs in per test eventually trips it. Each test
  // gets its own baby instead, which is the isolation that actually matters
  // here — dismissals are per-baby.
  let shared: Awaited<ReturnType<typeof rig>>;
  beforeAll(async () => {
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
