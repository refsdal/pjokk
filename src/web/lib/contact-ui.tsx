import {
  IconBuildingHospital,
  IconDental,
  IconMoodSmile,
  IconNurse,
  IconOld,
  IconPhone,
  IconSchool,
  IconStethoscope,
  IconUser,
  IconUsers,
  type TablerIcon,
} from "@tabler/icons-react";
import type { ContactIcon } from "@pjokk/shared";

// Icon key → Tabler glyph. `role` carries the meaning; the icon is only
// there so a contact is recognizable at a glance in the list.
export const contactIconMeta: Record<
  ContactIcon,
  { icon: TablerIcon; label: string }
> = {
  user: { icon: IconUser, label: "Person" },
  doctor: { icon: IconStethoscope, label: "Doctor" },
  nurse: { icon: IconNurse, label: "Nurse" },
  hospital: { icon: IconBuildingHospital, label: "Clinic" },
  dental: { icon: IconDental, label: "Dentist" },
  family: { icon: IconUsers, label: "Family" },
  grandparent: { icon: IconOld, label: "Grandparent" },
  daycare: { icon: IconSchool, label: "Daycare" },
  friend: { icon: IconMoodSmile, label: "Friend" },
  phone: { icon: IconPhone, label: "Other" },
};

export const contactIconFor = (key: ContactIcon | null): TablerIcon =>
  key ? contactIconMeta[key].icon : IconUser;

// People type "legesenteret.no"; a bare host is not a valid href.
export function websiteHref(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}
