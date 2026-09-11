import { Card } from "@/components/ui/card";

// A titled card of rows, shared by the console's detail pages (the family
// page and the user page): a small uppercase title with an optional action
// beside it, and a card whose rows are separated by hairlines.
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-[11px] font-bold text-muted uppercase">{title}</h2>
        {action}
      </div>
      <Card className="divide-y divide-line p-0">{children}</Card>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-5 text-center text-sm text-muted">{children}</p>;
}
