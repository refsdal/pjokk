import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      aria-label={
        props["aria-label"] ??
        (typeof props.placeholder === "string" ? props.placeholder : undefined)
      }
      className={cn(
        "h-12 w-full rounded-xl2 border border-line bg-surface px-4 text-base text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/40",
        className,
      )}
      {...props}
    />
  );
}
