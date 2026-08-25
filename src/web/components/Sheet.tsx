import { Drawer } from "vaul";
import type { ReactNode } from "react";

// Bottom sheet wrapper (vaul). Save button lives at the very bottom, inside
// the safe area — reachable with a thumb, one-handed.
export function Sheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      repositionInputs={false}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-3xl bg-bg outline-none">
          <div className="mx-auto mt-3 h-1.5 w-10 shrink-0 rounded-full bg-line" />
          <Drawer.Title className="px-5 pt-3 pb-1 text-lg font-bold text-ink">
            {title}
          </Drawer.Title>
          <div className="flex-1 overflow-y-auto px-5 pb-safe">{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
