import type { Member } from "@pjokk/shared";

// Who did the care (spec docs/superpowers/specs/2026-09-14-who-did-it-
// design.md), the pure half: what the chips show and what a sheet sends.
// The hook and the row itself live in components/CaretakerChips.tsx; the
// kiosk's caretaker row shares the label.

// A first name is what a finger looks for across the room. Someone who
// signed up without a name (the e-mail signup path has none) still needs a
// label, so they get the part of their address before the @.
export function firstName(m: Pick<Member, "name" | "email">): string {
  const name = m.name.trim();
  return name
    ? (name.split(/\s+/)[0] ?? name)
    : (m.email.split("@")[0] ?? m.email);
}

// The chips' order: yourself first, the rest as the family lists them.
export function caretakerOptions(
  members: Member[],
  meId: string | null | undefined,
): Member[] {
  if (!meId) return members;
  const me = members.filter((m) => m.userId === meId);
  return [...me, ...members.filter((m) => m.userId !== meId)];
}

// What a sheet puts in its body. `chosen` is what the chips report (null
// until tapped); `baseline` is who the entry belongs to already — yourself
// on create, the row's caretaker on edit. Only a real change is sent, so an
// untouched sheet sends the body it always sent, and a tap back to the
// default sends nothing either.
export function caretakerField(
  chosen: string | null,
  baseline: string | null | undefined,
): { caretakerId?: string } {
  return chosen && chosen !== baseline ? { caretakerId: chosen } : {};
}

// The "Logged by" line under the chips on an edit: only when the person who
// saved the row is not the person the chips name, which is the only time it
// says anything.
export function loggedByLine(
  edit: { loggedById: string; loggedByName: string } | null | undefined,
  shown: string | null,
): string | null {
  if (!edit || !shown || edit.loggedById === shown) return null;
  return edit.loggedByName || null;
}
