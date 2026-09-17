import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { Link, type LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";

export function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="px-1 pt-5 pb-2 text-xs font-bold tracking-wider text-muted uppercase">
      {children}
    </h2>
  );
}

// A settings page one or two levels below the hub: a back chevron to the
// level above, the title, the sections. Profile's header, shared.
export function SettingsPage({
  title,
  back,
  children,
}: {
  title: string;
  back: Pick<LinkProps, "to" | "params">;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-md px-4 pt-safe md:max-w-lg md:px-6">
      <div className="flex items-center gap-2 py-4">
        <Link
          {...back}
          aria-label={t("Back")}
          className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-soft active:bg-surface-2"
        >
          <IconChevronLeft className="h-6 w-6" />
        </Link>
        <h1 className="min-w-0 truncate text-2xl font-extrabold text-ink">
          {title}
        </h1>
      </div>
      <div className="pb-tabbar">{children}</div>
    </div>
  );
}

// A row that goes somewhere: label, an optional quieter line under it, an
// optional face or icon in front, a chevron behind. Lives inside a
// `divide-y divide-line p-0` Card.
export function NavRow({
  label,
  sub,
  leading,
  ...link
}: {
  label: string;
  sub?: string;
  leading?: ReactNode;
} & Pick<LinkProps, "to" | "params">) {
  return (
    <Link
      {...link}
      className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left active:bg-surface-2"
    >
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-ink">{label}</span>
        {sub && (
          <span className="block truncate text-xs text-muted">{sub}</span>
        )}
      </span>
      <IconChevronRight className="h-5 w-5 shrink-0 text-muted" />
    </Link>
  );
}
