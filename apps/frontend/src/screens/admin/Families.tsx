import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconChevronRight, IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { InviteQR } from "@/components/InviteQR";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { client, unwrap } from "@/lib/api";
import { t } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";
import { toast } from "@/lib/toast";
import type { AdminFamily } from "./lib";

// The operator's family list. Rows are LINKS to the detail page and no
// longer carry a delete button: a cascade delete one fat-fingered tap from a
// list row is too cheap, so it lives in the detail page's danger zone where
// the operator can see what they are about to destroy.

type Created = {
  id: string;
  name: string;
  slug: string;
  firstAdmin?: {
    userId: string;
    email: string;
    accountCreated: boolean;
  } | null;
  invite?: { code: string; url: string } | null;
};

// The three creation behaviours in one form (see CreateAdminFamily's spec
// summary). The account-creation checkbox only appears once the server has
// said there is no account for the address, so it cannot be armed by
// accident — the whole point of the flag being explicit is that a mistyped
// address is refused rather than provisioned.
function CreateFamilySheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  const [createAccount, setCreateAccount] = useState(false);
  const [noAccount, setNoAccount] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  const reset = () => {
    setName("");
    setEmail("");
    setAdminName("");
    setCreateAccount(false);
    setNoAccount(false);
    setCreated(null);
  };

  const create = useMutation({
    mutationFn: async () =>
      unwrap<Created>(
        client.POST("/api/admin/families", {
          // createAccount is always sent: openapi-typescript types a
          // field with a `default:` as required on the request, and the
          // server reads false exactly as it reads absent.
          body: {
            name,
            createAccount,
            ...(email ? { adminEmail: email } : {}),
            ...(adminName ? { adminName } : {}),
          },
        }),
      ),
    onSuccess: (result) => {
      setCreated(result);
      onCreated();
    },
    onError: (err) => {
      // A 404 here means exactly one thing: no account for that address.
      // Reveal the provisioning option rather than making the operator
      // guess what to do next.
      if (/no account/i.test(err.message)) {
        setNoAccount(true);
        setCreateAccount(true);
      }
      toast(err.message, "error");
    },
  });

  const close = () => {
    reset();
    onOpenChange(false);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title={created ? t("Family created") : t("New family")}
    >
      {created ? (
        <div className="space-y-3 pb-4">
          <p className="font-semibold text-ink">{created.name}</p>
          {created.firstAdmin && (
            <p className="text-sm text-muted">
              {created.firstAdmin.accountCreated
                ? t(
                    "Account created. They sign in with Google using this address:",
                  )
                : t("Family admin:")}{" "}
              <span className="font-semibold text-ink">
                {created.firstAdmin.email}
              </span>
            </p>
          )}
          {created.invite && (
            <>
              <p className="text-sm text-muted">
                {t(
                  "Nobody runs this family yet. Send this link to whoever will — it makes them its admin.",
                )}
              </p>
              <button
                type="button"
                className="w-full rounded-xl bg-surface-2 px-3 py-2 text-center font-mono text-sm break-all text-ink"
                onClick={() => {
                  void navigator.clipboard?.writeText(
                    created.invite?.url ?? "",
                  );
                  toast(t("Link copied"));
                }}
              >
                {created.invite.url}
              </button>
              <InviteQR url={created.invite.url} />
            </>
          )}
          <Button size="full" onClick={close}>
            {t("Done")}
          </Button>
        </div>
      ) : (
        <div className="space-y-3 pb-4">
          <Input
            type="text"
            placeholder={t("Family name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div>
            <Input
              type="email"
              placeholder={t("Admin's email (optional)")}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setNoAccount(false);
                setCreateAccount(false);
              }}
            />
            <p className="px-1 pt-1 text-xs text-muted">
              {t(
                "Leave empty to create the family with an invite link instead.",
              )}
            </p>
          </div>

          {noAccount && (
            <div className="space-y-2 rounded-xl bg-surface-2 p-3">
              <p className="text-sm text-ink">
                {t("No account for that address.")}
              </p>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={createAccount}
                  onChange={(e) => setCreateAccount(e.target.checked)}
                />
                {t("Create one for them")}
              </label>
              {createAccount && (
                <Input
                  type="text"
                  placeholder={t("Their full name")}
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                />
              )}
              <p className="text-xs text-muted">
                {t(
                  "The account has no password — they claim it by signing in with Google on that address.",
                )}
              </p>
            </div>
          )}

          <Button
            size="full"
            disabled={
              !name.trim() ||
              create.isPending ||
              (createAccount && !adminName.trim())
            }
            onClick={() => create.mutate()}
          >
            {email ? t("Create family") : t("Create with invite link")}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

export function AdminFamilies() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const families = useQuery({
    queryKey: ["admin", "families", query],
    queryFn: async () =>
      unwrap<AdminFamily[]>(
        client.GET("/api/admin/families", {
          params: { query: query ? { query } : {} },
        }),
      ),
  });

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          type="search"
          placeholder={t("Search families")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button variant="secondary" onClick={() => setCreating(true)}>
          <IconPlus className="h-5 w-5" />
          {t("New")}
        </Button>
      </div>

      <Card className="divide-y divide-line p-0">
        {(families.data ?? []).map((f) => (
          <Link
            key={f.id}
            to="/admin/families/$id"
            params={{ id: f.id }}
            className="flex items-center gap-3 px-4 py-3 active:bg-surface-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-ink">
                {f.name}
                {!f.hasAdmin && (
                  // A family loses its last admin whenever that account is
                  // deleted — the membership cascades away without passing
                  // the last-admin guard. It keeps working for everyone in
                  // it and silently cannot be administered.
                  <span className="ml-2 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-bold text-danger uppercase">
                    {t("no admin")}
                  </span>
                )}
              </p>
              <p className="text-xs text-muted">
                {f.members} {t("members")} · {f.babies} {t("babies")} ·{" "}
                {f.lastFeedAt
                  ? `${t("last feed")} ${formatRelative(new Date(f.lastFeedAt))}`
                  : t("no feeds")}
              </p>
            </div>
            <IconChevronRight className="h-5 w-5 shrink-0 text-muted" />
          </Link>
        ))}
        {families.isSuccess && families.data.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-muted">
            {query ? t("No families match.") : t("No families yet.")}
          </p>
        )}
      </Card>

      <CreateFamilySheet
        open={creating}
        onOpenChange={setCreating}
        onCreated={() =>
          void queryClient.invalidateQueries({ queryKey: ["admin"] })
        }
      />
    </div>
  );
}
