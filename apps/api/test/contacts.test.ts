import { describe, expect, it } from "bun:test";
import { familyScope } from "../src/db/scoped";
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

describe("contact scoped helpers", () => {
  it("creates a contact with baby links and hydrates them back", async () => {
    const { family, baby } = await rig();
    const fam = familyScope(db(), family.id);

    const created = await fam.createContact({
      name: "Dr. Hansen",
      role: "doctor",
      icon: "doctor",
      phone: "+47 22 00 00 00",
      email: "hansen@legesenteret.no",
      website: "legesenteret.no",
      notes: "Fastlege",
      babyIds: [baby.id],
    });

    expect(created).not.toBeNull();
    expect(created!.name).toBe("Dr. Hansen");
    expect(created!.icon).toBe("doctor");
    expect(created!.babies).toEqual([{ id: baby.id, name: "Rig baby" }]);
  });

  it("treats zero baby links as a family-wide contact", async () => {
    const { family } = await rig();
    const fam = familyScope(db(), family.id);

    const created = await fam.createContact({ name: "Mormor", babyIds: [] });

    expect(created!.babies).toEqual([]);
    expect(created!.role).toBeNull();
  });

  it("shares one contact across several babies", async () => {
    const { family, baby } = await rig();
    const sibling = await createBaby(family.id, "Sibling");
    const fam = familyScope(db(), family.id);

    const shared = await fam.createContact({
      name: "Dr. Hansen",
      babyIds: [baby.id, sibling.id],
    });

    expect(shared!.babies.map((b) => b.name).sort()).toEqual([
      "Rig baby",
      "Sibling",
    ]);
  });

  it("lists only this family's contacts, by name", async () => {
    const { family } = await rig();
    const otherFamily = await createFamily("Other family");
    const fam = familyScope(db(), family.id);
    const otherFam = familyScope(db(), otherFamily.id);

    await fam.createContact({ name: "Zita", babyIds: [] });
    await fam.createContact({ name: "Anna", babyIds: [] });
    await otherFam.createContact({ name: "Not ours", babyIds: [] });

    const rows = await fam.listContacts();
    expect(rows.map((r) => r.name)).toEqual(["Anna", "Zita"]);
  });

  it("replaces the link set on update and leaves it alone when omitted", async () => {
    const { family, baby } = await rig();
    const sibling = await createBaby(family.id, "Sibling");
    const fam = familyScope(db(), family.id);
    const created = await fam.createContact({
      name: "Mormor",
      babyIds: [baby.id],
    });

    const relinked = await fam.updateContact(
      created!.id,
      {},
      { babyIds: [sibling.id] },
    );
    expect(relinked!.babies).toEqual([{ id: sibling.id, name: "Sibling" }]);

    const renamed = await fam.updateContact(
      created!.id,
      { name: "Farmor" },
      {},
    );
    expect(renamed!.name).toBe("Farmor");
    expect(renamed!.babies).toEqual([{ id: sibling.id, name: "Sibling" }]);

    const unlinked = await fam.updateContact(created!.id, {}, { babyIds: [] });
    expect(unlinked!.babies).toEqual([]);
  });

  it("refuses to update or delete another family's contact", async () => {
    const { family } = await rig();
    const otherFamily = await createFamily("Other family");
    const otherFam = familyScope(db(), otherFamily.id);
    const theirs = await otherFam.createContact({
      name: "Theirs",
      babyIds: [],
    });

    const fam = familyScope(db(), family.id);
    expect(await fam.getContact(theirs!.id)).toBeNull();
    expect(await fam.updateContact(theirs!.id, { name: "Hijacked" }, {})).toBe(
      null,
    );
    expect(await fam.deleteContact(theirs!.id)).toBe(false);
    expect((await otherFam.getContact(theirs!.id))!.name).toBe("Theirs");
  });

  it("drops link rows when the baby is deleted, keeping the contact", async () => {
    const { family, baby } = await rig();
    const fam = familyScope(db(), family.id);
    const created = await fam.createContact({
      name: "Dr. Hansen",
      babyIds: [baby.id],
    });

    await fam.deleteBaby(baby.id);

    const after = await fam.getContact(created!.id);
    expect(after).not.toBeNull();
    expect(after!.babies).toEqual([]);
  });
});

describe("contacts API", () => {
  it("requires premium to create, but never to read, edit or delete", async () => {
    const { family, cookie, baby } = await rig();

    const denied = await api("/api/contacts", {
      method: "POST",
      cookie,
      body: { name: "Dr. Hansen" },
    });
    expect(denied.status).toBe(402);
    expect(((await denied.json()) as { code: string }).code).toBe(
      "PLAN_REQUIRED",
    );

    await setPlan(family.id, "premium");
    const created = await api("/api/contacts", {
      method: "POST",
      cookie,
      body: { name: "Dr. Hansen", role: "doctor", babyIds: [baby.id] },
    });
    expect(created.status).toBe(201);
    const contact = (await created.json()) as {
      id: string;
      babies: { id: string; name: string }[];
    };
    expect(contact.babies).toEqual([{ id: baby.id, name: "Rig baby" }]);

    // Soft-lock: a downgrade keeps the address book fully usable.
    await setPlan(family.id, "free");

    const listed = await api("/api/contacts", { cookie });
    expect(listed.status).toBe(200);
    expect((await listed.json()) as unknown[]).toHaveLength(1);

    const edited = await api(`/api/contacts/${contact.id}`, {
      method: "PATCH",
      cookie,
      body: { phone: "+47 22 00 00 00" },
    });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { phone: string }).phone).toBe(
      "+47 22 00 00 00",
    );

    const removed = await api(`/api/contacts/${contact.id}`, {
      method: "DELETE",
      cookie,
    });
    expect(removed.status).toBe(200);
  });

  it("rejects a baby id from another family", async () => {
    const { family, cookie } = await rig();
    await setPlan(family.id, "premium");
    const otherFamily = await createFamily("Other family");
    const theirBaby = await createBaby(otherFamily.id, "Their baby");

    const res = await api("/api/contacts", {
      method: "POST",
      cookie,
      body: { name: "Sneaky", babyIds: [theirBaby.id] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "INVALID_REFERENCE",
    );
  });

  it("rejects a baby id from another family on update too", async () => {
    const { family, cookie } = await rig();
    await setPlan(family.id, "premium");
    const created = await api("/api/contacts", {
      method: "POST",
      cookie,
      body: { name: "Mormor" },
    });
    const { id } = (await created.json()) as { id: string };

    const otherFamily = await createFamily("Other family");
    const theirBaby = await createBaby(otherFamily.id, "Their baby");

    const res = await api(`/api/contacts/${id}`, {
      method: "PATCH",
      cookie,
      body: { babyIds: [theirBaby.id] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "INVALID_REFERENCE",
    );
  });

  it("never leaks another family's contacts across the API", async () => {
    const { family, cookie } = await rig();
    await setPlan(family.id, "premium");
    await api("/api/contacts", {
      method: "POST",
      cookie,
      body: { name: "Ours" },
    });

    const outsider = await createUser("Outsider");
    const otherFamily = await createFamily("Other family");
    await addMember(outsider.id, otherFamily.id, "admin");
    const otherCookie = await signIn(outsider.email);

    const listed = await api("/api/contacts", { cookie: otherCookie });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([]);
  });

  it("dedupes repeated baby ids instead of failing the batch", async () => {
    const { family, cookie, baby } = await rig();
    await setPlan(family.id, "premium");

    const res = await api("/api/contacts", {
      method: "POST",
      cookie,
      body: { name: "Mormor", babyIds: [baby.id, baby.id] },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { babies: unknown[] }).babies).toHaveLength(
      1,
    );
  });

  it("validates email and 404s on an unknown id", async () => {
    const { family, cookie } = await rig();
    await setPlan(family.id, "premium");

    const bad = await api("/api/contacts", {
      method: "POST",
      cookie,
      body: { name: "Nope", email: "not-an-email" },
    });
    expect(bad.status).toBe(400);

    const missing = await api("/api/contacts/does-not-exist", {
      method: "PATCH",
      cookie,
      body: { name: "Ghost" },
    });
    expect(missing.status).toBe(404);
  });
});
