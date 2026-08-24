import { ChartColumn } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { t } from "@/lib/i18n";

function Stub({
  icon: Icon,
  title,
  note,
}: {
  icon: LucideIcon;
  title: string;
  note: string;
}) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-8 pb-tabbar text-center">
      <Icon className="h-10 w-10 text-muted" />
      <h1 className="text-xl font-extrabold text-ink">{title}</h1>
      <p className="text-sm text-muted">{note}</p>
    </div>
  );
}

export function StatsScreen() {
  return (
    <Stub
      icon={ChartColumn}
      title={t("Stats")}
      note={t("Sleep and intake charts land in phase 4.")}
    />
  );
}
