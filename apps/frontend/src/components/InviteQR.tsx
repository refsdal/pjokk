import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { t } from "@/lib/i18n";

// The invite code rendered for the other side of a dinner table. Shared by
// Settings → Family (where a parent invites a caretaker) and the operator
// console's family detail page (where a system admin mints a code for a
// family they are not a member of) — one component, so the two can never
// disagree about size, margin or alt text, and `qrcode` keeps exactly one
// call site.
//
// Encoding runs through TanStack Query with an infinite staleTime purely as
// a cache: the same URL re-rendering (a sheet reopening, a list re-sorting)
// does not re-encode, and the placeholder keeps the layout from jumping on
// the first pass.
export function InviteQR({ url }: { url: string }) {
  const { data } = useQuery({
    queryKey: ["qr", url],
    queryFn: () => QRCode.toDataURL(url, { width: 480, margin: 1 }),
    staleTime: Infinity,
  });
  if (!data)
    return <div className="mx-auto h-48 w-48 rounded-xl bg-surface-2" />;
  return (
    <img
      src={data}
      alt={t("Invite QR code")}
      className="mx-auto h-48 w-48 rounded-xl"
    />
  );
}
