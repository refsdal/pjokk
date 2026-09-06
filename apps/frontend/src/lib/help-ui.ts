import type { HelpRequest } from "@pjokk/shared";

// Everything the help card and sheet DECIDE lives here, so it can be unit
// tested without a DOM (the frontend suite is bun test over pure modules).
// HelpCard.tsx / HelpSheet.tsx only render what these return.

// One-tap messages for the sheet. Untranslated keys: the sheet passes each
// through t() for display AND for the message it sends, so the recipient
// reads it in the sender's language.
export const HELP_PRESETS = [
  "Come here",
  "Bring a bottle",
  "Take over",
] as const;
export const HELP_MESSAGE_MAX = 200;

export type HelpCardAction = "acknowledge" | "cancel" | "done" | null;

export type HelpCardView = {
  // "open" drives the red border and the animations.
  state: "open" | "acknowledged";
  from: string;
  to: string;
  ackBy: string | null;
  // The target sees "Anders needs a hand"; everyone else "… from Kari".
  viewerIsTarget: boolean;
  // acknowledge = "On my way", cancel = "Never mind", done = "Done".
  action: HelpCardAction;
  // What the relative time counts from.
  at: Date;
};

export function helpCardView(
  req: HelpRequest,
  viewer: { userId: string; isAdmin: boolean },
): HelpCardView {
  const isSender = viewer.userId === req.fromUserId;
  const open = req.acknowledgedAt === null;
  let action: HelpCardAction;
  if (open) {
    action = isSender ? "cancel" : "acknowledge";
  } else {
    action = isSender || viewer.isAdmin ? "done" : null;
  }
  return {
    state: open ? "open" : "acknowledged",
    from: req.fromName,
    to: req.toName,
    ackBy: open ? null : req.acknowledgedByName,
    viewerIsTarget: viewer.userId === req.toUserId,
    action,
    at: new Date(open ? req.createdAt : (req.acknowledgedAt as string)),
  };
}

// Prefill: the last person asked, if they are still here; else the only
// other member; else make the sender choose.
export function pickDefaultMember(
  others: { memberId: string }[],
  last: string | null,
): string | null {
  if (last && others.some((m) => m.memberId === last)) return last;
  if (others.length === 1) return others[0]!.memberId;
  return null;
}

// Per-family memory of who was asked last, one JSON map under one key —
// a family switcher must not carry Grandma's family's pick into yours.
const LAST_MEMBER_KEY = "pjokk.help.lastMember";

function readMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LAST_MEMBER_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function readLastHelpMember(familyId: string): string | null {
  return readMap()[familyId] ?? null;
}

export function writeLastHelpMember(familyId: string, memberId: string) {
  try {
    const map = readMap();
    map[familyId] = memberId;
    localStorage.setItem(LAST_MEMBER_KEY, JSON.stringify(map));
  } catch {
    // storage unavailable
  }
}
