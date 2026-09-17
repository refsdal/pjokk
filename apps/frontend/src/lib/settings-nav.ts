import type { Feature } from "@pjokk/shared";

// Settings → Family: the sections that open as their own page. ONE list
// feeds the Family page's rows and the /settings/family/$section route, so
// a row cannot point at a page that does not exist, and an admin-only
// section is hidden and refused by the same flag. The server enforces the
// role on every route these pages call; this only keeps a member from
// landing on a page of errors.
//
// A section with a `feature` is a shared list some switch uses (spec
// 2026-09-17-per-baby-tracking-design.md): its row shows while ANY baby
// in the family has that switch on, and a direct URL still opens it —
// hiding an entry point is not blocking a link.
export type FamilySectionKey =
  | "contacts"
  | "daycare"
  | "medicines"
  | "sleep-locations"
  | "care-days"
  | "api-keys"
  | "calendar-feed"
  | "data";

export type FamilySectionGroup = "lists" | "data";

export type FamilySectionMeta = {
  key: FamilySectionKey;
  // English; rendered through t().
  label: string;
  group: FamilySectionGroup;
  adminOnly?: boolean;
  feature?: Feature;
};

const sections: FamilySectionMeta[] = [
  { key: "contacts", label: "Contacts", group: "lists" },
  // Not admin-only: a grandparent needs the phone number. The page itself
  // is read-only for a member.
  { key: "daycare", label: "Daycare", group: "lists", feature: "daycare" },
  {
    key: "medicines",
    label: "Medicines",
    group: "lists",
    feature: "medicine",
  },
  {
    key: "sleep-locations",
    label: "Sleep locations",
    group: "lists",
    adminOnly: true,
    feature: "sleep",
  },
  {
    key: "care-days",
    label: "Days at home with a sick child",
    group: "lists",
    feature: "illness",
  },
  { key: "api-keys", label: "API keys", group: "data", adminOnly: true },
  { key: "calendar-feed", label: "Calendar subscription", group: "data" },
  { key: "data", label: "Export", group: "data" },
];

export function familySections(
  isAdmin: boolean,
  tracks: (key: Feature) => boolean = () => true,
): FamilySectionMeta[] {
  return sections.filter(
    (s) => (isAdmin || !s.adminOnly) && (!s.feature || tracks(s.feature)),
  );
}

export function familySection(
  key: string,
  isAdmin: boolean,
): FamilySectionMeta | undefined {
  return familySections(isAdmin).find((s) => s.key === key);
}
