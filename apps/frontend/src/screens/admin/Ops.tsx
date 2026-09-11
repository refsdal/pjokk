import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import {
  type AdminBackups,
  type AdminJobRun,
  type AdminOps as AdminOpsData,
  type AdminOpsJob,
  type DeletedFamily,
  type FamilyRestoreReport,
  formatBytes,
} from "@/lib/admin-ops";
import { API_BASE, ApiError, client, unwrap } from "@/lib/api";
import { t } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";
import { toast } from "@/lib/toast";
import { Empty, Section } from "./Section";
import { jobTitle, useAdminOps } from "./useAdminOps";

// The Ops tab (spec 2026-09-11-admin-ops): is this build on the schema it
// expects, where does the data live, did the jobs run, and the snapshots.
// Metadata about the deployment only — nothing here reads a log endpoint.

const clock = new Intl.DateTimeFormat("nb-NO", {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function Row({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: string;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-muted">{label}</span>
        <span className="text-right text-sm break-all text-ink">{value}</span>
      </div>
      {warn && <p className="pt-1 text-xs font-semibold text-danger">{warn}</p>}
    </div>
  );
}

function storageLine(s: AdminOpsData["storage"]): string {
  if (s.driver === "s3") {
    return ["S3", s.bucket, s.region, s.endpointHost]
      .filter(Boolean)
      .join(" · ");
  }
  if (s.driver === "fs")
    return [t("Filesystem"), s.path].filter(Boolean).join(" · ");
  return s.driver;
}

function statusLabel(status: AdminJobRun["status"]): string {
  switch (status) {
    case "ok":
      return t("OK");
    case "failed":
      return t("Failed");
    case "interrupted":
      return t("Interrupted");
    default:
      return t("Running");
  }
}

function triggerLabel(trigger: AdminJobRun["trigger"]): string {
  switch (trigger) {
    case "console":
      return t("from the console");
    case "cli":
      return t("from the CLI");
    default:
      return t("on schedule");
  }
}

function duration(run: AdminJobRun): string {
  if (!run.finishedAt) return "";
  const seconds = Math.max(
    0,
    Math.round(
      (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) /
        1000,
    ),
  );
  return seconds < 60
    ? ` · ${seconds} s`
    : ` · ${Math.round(seconds / 60)} min`;
}

function RunRow({ run }: { run: AdminJobRun }) {
  const tone =
    run.status === "ok"
      ? "text-ink"
      : run.status === "running"
        ? "text-accent"
        : "text-danger";
  return (
    <div className="px-4 py-2.5" data-testid="job-run">
      <p className="text-sm">
        <span className={`font-semibold ${tone}`}>
          {statusLabel(run.status)}
        </span>{" "}
        <span className="text-muted">
          {triggerLabel(run.trigger)} ·{" "}
          {formatRelative(new Date(run.startedAt))}
          {duration(run)}
        </span>
      </p>
      {run.error && (
        <p className="pt-0.5 font-mono text-xs break-all text-danger">
          {run.error}
        </p>
      )}
    </div>
  );
}

// Run now is a plain button, not tap-twice: both jobs are what the schedule
// runs anyway, and the server's lock refuses an overlap.
function JobCard({ job }: { job: AdminOpsJob }) {
  const queryClient = useQueryClient();
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["admin", "ops"] });
  const run = useMutation({
    mutationFn: async () =>
      unwrap(
        client.POST("/api/admin/jobs/{job}/run", {
          params: { path: { job: job.name as "nightly" | "frequent" } },
        }),
      ),
    onSuccess: () => {
      toast(t("Started"));
      refresh();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "JOB_RUNNING")
        toast(t("Already running"));
      else toast(err.message, "error");
      refresh();
    },
  });

  return (
    <Section
      title={jobTitle(job.name)}
      action={
        job.stale && (
          <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-bold text-danger uppercase">
            {job.lastSuccessAt ? t("stale") : t("never run")}
          </span>
        )
      }
    >
      <div
        className="space-y-0.5 px-4 py-3 text-sm"
        data-testid={`job-${job.name}`}
      >
        <p className="text-ink">
          {t("Last success")}:{" "}
          {job.lastSuccessAt
            ? formatRelative(new Date(job.lastSuccessAt))
            : t("never")}
        </p>
        <p className="text-muted">
          {t("Next due")} {clock.format(new Date(job.nextDue))} ·{" "}
          <span className="font-mono">{job.schedule}</span> UTC
        </p>
        <div className="pt-2">
          <Button
            size="full"
            variant="outline"
            disabled={job.running || run.isPending}
            onClick={() => run.mutate()}
          >
            {job.running ? t("Running…") : t("Run now")}
          </Button>
        </div>
      </div>
      {job.runs.length === 0 ? (
        <Empty>{t("No runs recorded yet.")}</Empty>
      ) : (
        job.runs.map((r) => <RunRow key={r.id} run={r} />)
      )}
    </Section>
  );
}

// fetch → blob → a temporary object URL: the request is never a navigation
// the service worker could answer with the app shell, and /api/admin/ is
// outside its cache (vite.config.ts), so the snapshot lands in the file the
// browser saves and nowhere else.
async function downloadSnapshot(date: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/admin/backups/${date}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // not JSON — keep the status
    }
    throw new Error(message);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `pjokk-backup-${date}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// refreshKey names the newest finished nightly run: when it changes, a new
// snapshot may exist, so the list is asked again. Skipped on mount, where
// the query is fetching anyway.
// Tap twice, like the console's other consequential row actions.
function ConfirmButton({
  label,
  busy,
  onConfirm,
}: {
  label: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      disabled={busy}
      className={
        armed
          ? "shrink-0 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent"
          : "shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold text-accent"
      }
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      {busy ? t("Restoring…") : armed ? t("Tap again to confirm") : label}
    </button>
  );
}

// What a family restore did, and what the operator should know about it
// (spec 2026-09-11-admin-restore §3).
function RestoreResult({ report }: { report: FamilyRestoreReport }) {
  const notes: string[] = [];
  if (report.membersDropped > 0)
    notes.push(
      `${report.membersDropped} ${t("left out: their accounts were deleted since, and what they logged is the Deleted user's")}`,
    );
  if (!report.hasAdmin)
    notes.push(
      t("Nobody left can administer it — make someone admin on its page"),
    );
  if (report.previousSlug)
    notes.push(`${t("Its slug had been taken; it is now")} ${report.slug}`);
  if (report.photosMissing.length > 0)
    notes.push(
      `${report.photosMissing.length} ${t("photos had no copy in the photo backup")}`,
    );
  notes.push(...report.warnings);
  notes.push(t("API keys, kiosk devices and push subscriptions stay gone."));
  return (
    <div className="space-y-2" data-testid="restore-result">
      <p className="font-semibold text-ink">
        {report.name} {t("is back")}
      </p>
      <p className="text-sm text-muted">
        {report.membersRejoined} {t("members rejoined")} ·{" "}
        {report.photosRestored} {t("photos restored")}
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <Link
        to="/admin/families/$id"
        params={{ id: report.familyId }}
        className="block rounded-xl bg-surface-2 px-4 py-3 text-center text-sm font-semibold text-ink"
      >
        {t("Open the family")}
      </Link>
    </div>
  );
}

// The families a snapshot holds that no longer exist, and the undo for a
// deletion made by mistake. Never for a family deleted at its owners'
// request: that deletion is their right.
function DeletedFamiliesSheet({
  date,
  onClose,
}: {
  date: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [report, setReport] = useState<FamilyRestoreReport | null>(null);
  useEffect(() => {
    if (date) setReport(null);
  }, [date]);
  const families = useQuery({
    queryKey: ["admin", "backups", date, "families"],
    enabled: date !== null,
    queryFn: async () =>
      unwrap<DeletedFamily[]>(
        client.GET("/api/admin/backups/{date}/families", {
          params: { path: { date: date ?? "" } },
        }),
      ),
  });
  const restoreFamily = useMutation({
    mutationFn: async (id: string) =>
      unwrap<FamilyRestoreReport>(
        client.POST("/api/admin/backups/{date}/families/{id}/restore", {
          params: { path: { date: date ?? "", id } },
        }),
      ),
    onSuccess: (rep) => {
      setReport(rep);
      toast(t("Family restored"));
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (err) => toast(err.message, "error"),
  });

  return (
    <Sheet
      open={date !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`${t("Deleted families")} · ${date ?? ""}`}
    >
      <div className="space-y-3 pb-4">
        {report ? (
          <RestoreResult report={report} />
        ) : (
          <>
            <p className="text-sm text-muted">
              {t(
                "Restore a family only to undo a mistake — never one deleted at its owners' request.",
              )}
            </p>
            {families.isPending && (
              <p className="text-sm text-muted">{t("Loading…")}</p>
            )}
            {families.data?.length === 0 && (
              <p className="text-sm text-muted">
                {t("Every family in this snapshot still exists.")}
              </p>
            )}
            {families.data?.map((f) => (
              <div
                key={f.id}
                className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2"
                data-testid="deleted-family"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-ink">{f.name}</p>
                  <p className="text-xs text-muted">
                    {f.members} {t("members")} · {f.babies} {t("babies")}
                    {f.deletedAt
                      ? ` · ${t("deleted")} ${formatRelative(new Date(f.deletedAt))}${f.deletedBy ? ` ${t("by")} ${f.deletedBy}` : ""}`
                      : ""}
                  </p>
                </div>
                <ConfirmButton
                  label={t("Restore")}
                  busy={restoreFamily.isPending}
                  onConfirm={() => restoreFamily.mutate(f.id)}
                />
              </div>
            ))}
          </>
        )}
      </div>
    </Sheet>
  );
}

function Backups({ refreshKey }: { refreshKey: string }) {
  const queryClient = useQueryClient();
  const backups = useQuery({
    queryKey: ["admin", "backups"],
    queryFn: async () => unwrap<AdminBackups>(client.GET("/api/admin/backups")),
  });
  const firstKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === firstKey.current) return;
    firstKey.current = refreshKey;
    void queryClient.invalidateQueries({ queryKey: ["admin", "backups"] });
  }, [refreshKey, queryClient]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [familiesFor, setFamiliesFor] = useState<string | null>(null);
  const b = backups.data;

  const download = async (date: string) => {
    setDownloading(date);
    try {
      await downloadSnapshot(date);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setDownloading(null);
    }
  };

  return (
    <Section title={t("Backups")}>
      <p className="px-4 py-3 text-xs text-muted">
        {t(
          "A snapshot holds every family's data. Download one only to restore the service, keep it inside the EU, and delete it afterwards. Every download is recorded in the audit trail.",
        )}
      </p>
      {b && b.snapshots.length === 0 && <Empty>{t("No snapshots yet.")}</Empty>}
      {b?.snapshots.map((s) => (
        <div
          key={s.date}
          className="flex items-center gap-3 px-4 py-3"
          data-testid="backup-snapshot"
        >
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-ink">{s.date}</p>
            <p className="text-xs text-muted">
              {formatBytes(s.sizeBytes)} ·{" "}
              {formatRelative(new Date(s.uploadedAt))}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end">
            <button
              type="button"
              className="rounded-full px-3 py-1 text-xs font-semibold text-accent"
              disabled={downloading !== null}
              onClick={() => void download(s.date)}
            >
              {downloading === s.date ? t("Downloading…") : t("Download")}
            </button>
            <button
              type="button"
              className="rounded-full px-3 py-1 text-xs font-semibold text-muted"
              onClick={() => setFamiliesFor(s.date)}
            >
              {t("Deleted families")}
            </button>
          </div>
        </div>
      ))}
      {b && (
        <p className="px-4 py-3 text-xs text-muted">
          {t("Kept")} {b.retentionDays} {t("days")} · {t("Photo backup")}:{" "}
          {b.photos.current} ({formatBytes(b.photos.currentBytes)}),{" "}
          {b.photos.deleted} {t("kept after deletion")}
        </p>
      )}
      <DeletedFamiliesSheet
        date={familiesFor}
        onClose={() => setFamiliesFor(null)}
      />
    </Section>
  );
}

function lastFinished(o: AdminOpsData, name: string): string {
  const run = o.jobs
    .find((j) => j.name === name)
    ?.runs.find((r) => r.status !== "running");
  return run ? `${run.id}:${run.status}` : "";
}

export function AdminOps() {
  const ops = useAdminOps();
  if (ops.isPending) {
    return (
      <p className="py-10 text-center text-sm text-muted">{t("Loading…")}</p>
    );
  }
  if (!ops.data) {
    return (
      <p className="py-10 text-center text-sm text-muted">
        {t("Could not load the health page.")}
      </p>
    );
  }
  const o = ops.data;
  const schemaWarn =
    o.schema.applied < o.schema.latest
      ? t("The database is behind this build — run migrate.")
      : o.schema.applied > o.schema.latest
        ? t("The database is ahead of this build — an older image?")
        : undefined;

  return (
    <div className="space-y-4">
      <Section title={t("Health")}>
        <Row label={t("Version")} value={o.version} />
        <Row
          label={t("Schema")}
          value={`${o.schema.applied} / ${o.schema.latest}`}
          warn={schemaWarn}
        />
        <Row label={t("Storage")} value={storageLine(o.storage)} />
        <Row
          label={t("Database")}
          value={`${formatBytes(o.database.sizeBytes)} · Postgres ${o.database.serverVersion}`}
        />
      </Section>
      {o.jobs.map((job) => (
        <JobCard key={job.name} job={job} />
      ))}
      <Backups refreshKey={lastFinished(o, "nightly")} />
    </div>
  );
}
