import type { components } from "@/lib/api-schema";

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  banned?: boolean | null;
};

export type AdminFamily = components["schemas"]["AdminFamily"];
export type AdminFamilyDetail = components["schemas"]["AdminFamilyDetail"];
export type AdminFamilyMember = components["schemas"]["AdminFamilyMember"];
export type AdminInvite = components["schemas"]["Invite"];
export type AdminUserDetail = components["schemas"]["AdminUserDetail"];
export type AdminSession = components["schemas"]["AdminSession"];
export type AuditEntry = components["schemas"]["AuditEntry"];

// One page of a console list (spec 2026-09-11-admin-user-support §2):
// pass nextCursor back as `cursor` for the next; null on the last page.
export type Page<T> = { items: T[]; nextCursor: string | null };

// The two roles a family membership can hold. "owner" also exists — Limen's
// organization plugin can still assign its own default — and is read as
// equivalent to admin everywhere (auth.IsPrivilegedRole), but nothing in
// this app ever writes it, so it is not offered as a choice.
export const FAMILY_ROLES = ["admin", "member"] as const;
export type FamilyRole = (typeof FAMILY_ROLES)[number];

// Whether a member counts as running the family. Mirrors the server's
// auth.IsPrivilegedRole: a family that holds no such member is stranded and
// cannot be administered from inside the app at all.
export function isPrivilegedRole(role: string): boolean {
  return role === "admin" || role === "owner";
}

// Whether acting on this member would leave the family with nobody able to
// administer it — the client-side mirror of the server's guard, used to
// disable the control rather than to enforce anything. The server refuses
// regardless; this only stops the operator from discovering it by being
// told no.
//
// nextRole is undefined for a removal and the requested role for a role
// change: only a change AWAY from admin shrinks the count, so re-setting an
// admin to admin is never a demotion.
export function wouldStrandFamily(
  members: AdminFamilyMember[],
  member: AdminFamilyMember,
  nextRole?: FamilyRole,
): boolean {
  if (!isPrivilegedRole(member.role)) return false;
  if (nextRole === "admin") return false;
  return members.filter((m) => isPrivilegedRole(m.role)).length <= 1;
}

// An invite that can still be redeemed right now. Mirrors the server's
// classifyInvite (internal/api/invites.go) so the list can separate live
// codes from spent ones without a second endpoint; the server re-checks all
// three conditions at redemption.
export function isInviteLive(
  invite: AdminInvite,
  now: Date = new Date(),
): boolean {
  if (invite.revokedAt) return false;
  if (new Date(invite.expiresAt) <= now) return false;
  return invite.usedCount < invite.maxUses;
}

// Why a code cannot be redeemed, for the one-line status under it. Returns
// an empty string while the invite is live.
export function inviteState(
  invite: AdminInvite,
  now: Date = new Date(),
): string {
  if (invite.revokedAt) return "revoked";
  if (new Date(invite.expiresAt) <= now) return "expired";
  if (invite.usedCount >= invite.maxUses) return "used up";
  return "";
}
