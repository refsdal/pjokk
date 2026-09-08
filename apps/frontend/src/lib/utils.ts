import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Visible keyboard focus (spec §6). A shared string rather than a
// component so the log buttons, rail items, chips and steppers all get the
// same ring; Tailwind sees the literal here and emits the classes once.
export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
