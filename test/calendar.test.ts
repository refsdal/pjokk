import { describe, expect, it } from "vitest";
import { familyScope } from "../src/worker/db/scoped";
import {
  addMember,
  createBaby,
  createFamily,
  createUser,
  db,
  rig,
} from "./helpers";

const HOUR = 3600_000;

describe("calendar scoped helpers", () => {
  it("creates an event with babies + assignees and hydrates them back", async () => {
    const { user, family, baby } = await rig();
    const other = await createUser("Other parent");
    await addMember(other.id, family.id, "member");
    const fam = familyScope(db(), family.id);

    const start = new Date(Date.now() + 24 * HOUR);
    const created = await fam.createCalendarEvent({
      createdBy: user.id,
      title: "Doctor checkup",
      description: "6-month control",
      location: "Legesenteret",
      category: "doctor",
      startTime: start,
      allDay: false,
      durationMin: 30,
      remindMinutesBefore: 60,
      babyIds: [baby.id],
      assigneeUserIds: [user.id, other.id],
    });
    expect(created).not.toBeNull();
    expect(created!.title).toBe("Doctor checkup");
    expect(created!.createdByName).toBe("Rig admin");
    expect(created!.babies).toEqual([{ id: baby.id, name: "Rig baby" }]);
    expect(created!.assignees.map((a) => a.userId).sort()).toEqual(
      [user.id, other.id].sort(),
    );
  });

  it("lists only events inside the range, ascending, family-scoped", async () => {
    const { user, family } = await rig();
    const fam = familyScope(db(), family.id);
    const base = Date.now();
    const mk = (title: string, offsetH: number) =>
      fam.createCalendarEvent({
        createdBy: user.id,
        title,
        category: "other",
        startTime: new Date(base + offsetH * HOUR),
        allDay: false,
        babyIds: [],
        assigneeUserIds: [],
      });
    await mk("later", 48);
    await mk("sooner", 24);
    await mk("outside", 24 * 200);

    // Another family's event in the same window must not leak.
    const stranger = await createUser("Stranger");
    const otherFamily = await createFamily("Other family");
    await addMember(stranger.id, otherFamily.id, "admin");
    await familyScope(db(), otherFamily.id).createCalendarEvent({
      createdBy: stranger.id,
      title: "not yours",
      category: "other",
      startTime: new Date(base + 24 * HOUR),
      allDay: false,
      babyIds: [],
      assigneeUserIds: [],
    });

    const listed = await fam.listCalendarEvents(
      new Date(base),
      new Date(base + 96 * HOUR),
    );
    expect(listed.map((e) => e.title)).toEqual(["sooner", "later"]);
  });

  it("update replaces link rows exactly; empty arrays clear them", async () => {
    const { user, family, baby } = await rig();
    const baby2 = await createBaby(family.id, "Twin");
    const fam = familyScope(db(), family.id);
    const created = await fam.createCalendarEvent({
      createdBy: user.id,
      title: "Vaccine",
      category: "vaccination",
      startTime: new Date(Date.now() + 24 * HOUR),
      allDay: false,
      babyIds: [baby.id],
      assigneeUserIds: [user.id],
    });

    const updated = await fam.updateCalendarEvent(
      created!.id,
      { title: "Vaccine (both)" },
      { babyIds: [baby.id, baby2.id], assigneeUserIds: [] },
    );
    expect(updated!.title).toBe("Vaccine (both)");
    expect(updated!.babies.map((b) => b.id).sort()).toEqual(
      [baby.id, baby2.id].sort(),
    );
    expect(updated!.assignees).toEqual([]);

    // Omitted links stay untouched.
    const again = await fam.updateCalendarEvent(
      created!.id,
      { location: "Helsestasjonen" },
      {},
    );
    expect(again!.babies).toHaveLength(2);
  });

  it("update/delete of another family's event returns null/false", async () => {
    const { user, family } = await rig();
    const fam = familyScope(db(), family.id);
    const created = await fam.createCalendarEvent({
      createdBy: user.id,
      title: "Ours",
      category: "family",
      startTime: new Date(Date.now() + HOUR),
      allDay: true,
      babyIds: [],
      assigneeUserIds: [],
    });

    const stranger = await createUser("Stranger");
    const otherFamily = await createFamily("Other family");
    await addMember(stranger.id, otherFamily.id, "admin");
    const otherFam = familyScope(db(), otherFamily.id);
    expect(
      await otherFam.updateCalendarEvent(created!.id, { title: "Hijack" }, {}),
    ).toBeNull();
    expect(await otherFam.deleteCalendarEvent(created!.id)).toBe(false);
    expect(await fam.deleteCalendarEvent(created!.id)).toBe(true);
    expect(await fam.getCalendarEvent(created!.id)).toBeNull();
  });
});
