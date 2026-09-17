// Settings → Family: the sections that open as their own page. ONE list
// feeds the Family page's rows and the /settings/family/$section route, so
// a row cannot point at a page that does not exist, and an admin-only
// section is hidden and refused by the same flag. The server enforces the
// role on every route these pages call; this only keeps a member from
// landing on a page of errors.
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
};

const sections: FamilySectionMeta[] = [
  { key: "contacts", label: "Contacts", group: "lists" },
  // Not admin-only: a grandparent needs the phone number. The page itself
  // is read-only for a member.
  { key: "daycare", label: "Daycare", group: "lists" },
  { key: "medicines", label: "Medicines", group: "lists" },
  {
    key: "sleep-locations",
    label: "Sleep locations",
    group: "lists",
    adminOnly: true,
  },
  {
    key: "care-days",
    label: "Days at home with a sick child",
    group: "lists",
  },
  { key: "api-keys", label: "API keys", group: "data", adminOnly: true },
  { key: "calendar-feed", label: "Calendar subscription", group: "data" },
  { key: "data", label: "Export", group: "data" },
];

export function familySections(isAdmin: boolean): FamilySectionMeta[] {
  return sections.filter((s) => isAdmin || !s.adminOnly);
}

export function familySection(
  key: string,
  isAdmin: boolean,
): FamilySectionMeta | undefined {
  return familySections(isAdmin).find((s) => s.key === key);
}
