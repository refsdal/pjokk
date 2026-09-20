import { IconChevronLeft } from "@tabler/icons-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { whatsNew } from "@/data/whats-new";
import { useBabies } from "@/lib/data";
import { t } from "@/lib/i18n";
import { familyTracks } from "@/lib/tracking";
import { cn } from "@/lib/utils";
import { visible } from "@/lib/whats-new";

// Every entry ever written, newest first (issue #140). Deliberately a list
// and not a carousel: three new things are three cards read in one glance,
// and making someone swipe is friction applied to the person we are
// protecting.
//
// Not filtered by the person's marker — dismissal controls the nag, never
// the content. It IS filtered by what the family tracks, so the page never
// advertises a feature they have switched off.
export function WhatsNewScreen() {
  const router = useRouter();
  const navigate = useNavigate();
  const babies = useBabies();
  // whatsNew() is a function so t() resolves against the CURRENT language;
  // its strings are already translated, so nothing here re-wraps them.
  const entries = visible(whatsNew(), (k) => familyTracks(babies.data, k));

  return (
    <div className="mx-auto max-w-md px-4 pt-safe pb-tabbar md:max-w-lg">
      <div className="flex items-center gap-2 py-3">
        {/* History back, not a fixed destination: this screen is reached
            from Home's row AND from Settings, and sending a parent who
            tapped the row on Home into Settings costs exactly the extra
            taps this feature exists not to cost. Falls back to /profile
            when there is no history to go back to (a deep link, or a fresh
            PWA launch). 44 px and the house back-button idiom — see
            Profile.tsx. */}
        <button
          type="button"
          onClick={() => {
            if (window.history.length > 1) router.history.back();
            else void navigate({ to: "/profile" });
          }}
          className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-ink-soft active:bg-surface-2"
          aria-label={t("Back")}
        >
          <IconChevronLeft className="h-6 w-6" />
        </button>
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
                  {/* Already translated by whatsNew() — do NOT wrap in
                      t() again: a second pass cannot map a Norwegian
                      string back to English. */}
                  <div className="space-y-1">
                    <h2 className="font-semibold text-ink">{e.title}</h2>
                    <p className="text-sm text-ink-soft">{e.body}</p>
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
