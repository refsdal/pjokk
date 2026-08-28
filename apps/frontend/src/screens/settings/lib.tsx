export function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="px-1 pt-5 pb-2 text-xs font-bold tracking-wider text-muted uppercase">
      {children}
    </h2>
  );
}
