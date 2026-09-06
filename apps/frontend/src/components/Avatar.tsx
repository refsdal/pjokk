import { useState } from "react";
import { cn } from "@/lib/utils";

// One face, everywhere a person is shown (spec §4): the Home chip, the
// Caretakers list, the far right of a timeline row, the assignee chips in
// the event sheet, the account sheet and the profile screen.
//
// Falls back to the initial when there is no photo AND when the photo fails
// to load — offline with the image not in the service-worker cache looks
// exactly like "no photo", which is the calm default.
const sizes = {
  5: "h-5 w-5 text-[9px]",
  8: "h-8 w-8 text-xs",
  9: "h-9 w-9 text-sm",
  11: "h-11 w-11 text-base",
  20: "h-20 w-20 text-2xl",
} as const;

export type AvatarSize = keyof typeof sizes;

export function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}

export function Avatar({
  src,
  name,
  size,
  className,
}: {
  src: string | null | undefined;
  name: string;
  size: AvatarSize;
  className?: string;
}) {
  // Remember WHICH src failed, so a new upload (a new URL) gets a fresh try.
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = !!src && failed !== src;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-soft font-bold text-accent",
        sizes[size],
        className,
      )}
      title={name}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailed(src)}
        />
      ) : (
        initialOf(name)
      )}
    </span>
  );
}
