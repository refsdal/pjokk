import { IconArrowLeft } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { whatsNew } from "@/data/whats-new";
import { useBabies } from "@/lib/data";
import { t } from "@/lib/i18n";
import { familyTracks } from "@/lib/tracking";
import { cn } from "@/lib/utils";

// Every entry ever written, newest first (issue #140). Deliberately a list
// and not a carousel: three new things are three cards read in one glance,
// and making someone swipe is friction applied to the person we are
// protecting.
//
// Not filtered by the person's marker — dismissal controls the nag, never
// the content. It IS filtered by what the family tracks, so the page never
// advertises a feature they have switched off.
export function WhatsNewScreen() {
  const babies = useBabies();
  const entries = whatsNew
    .filter((e) => !e.feature || familyTracks(babies.data, e.feature))
    .sort((a, b) => b.seq - a.seq);

  return (
    <div className="mx-auto max-w-md px-4 pt-safe pb-tabbar md:max-w-lg">
      <div className="flex items-center gap-2 py-3">
        <Link
          to="/profile"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-ink"
          aria-label={t("Back")}
        >
          <IconArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-extrabold text-ink">{t("What's new")}</h1>
      </div>

      {entries.length === 0 ? (
        <p className="py-8 text-center text-ink-soft">
          {t("Nothing new yet.")}
        </p>
      ) : (
        <ul className="space-y-3" data-testid="whats-new-list">
          {entries.map((e) => {
            const Icon = e.icon;
            return (
              <li
                key={e.seq}
                className="rounded-xl2 border border-line bg-surface p-4"
                data-testid={`whats-new-entry-${e.seq}`}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2",
                      e.tint,
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="space-y-1">
                    <h2 className="font-semibold text-ink">{t(e.title)}</h2>
                    <p className="text-sm text-ink-soft">{t(e.body)}</p>
                    <p className="text-xs text-muted">{e.version}</p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
