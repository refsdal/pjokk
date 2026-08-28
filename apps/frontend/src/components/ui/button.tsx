import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// Touch targets stay ≥44px on every log-flow control (CLAUDE.md).
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-xl2 font-semibold transition-colors select-none disabled:opacity-50 disabled:pointer-events-none active:scale-[0.98]",
  {
    variants: {
      variant: {
        primary: "bg-accent text-on-accent",
        secondary: "bg-surface-2 text-ink",
        outline: "border border-line bg-surface text-ink",
        ghost: "text-ink-soft",
        danger: "bg-danger text-on-accent",
      },
      size: {
        default: "h-12 px-5 text-base",
        lg: "h-14 px-6 text-lg",
        sm: "h-11 px-4 text-sm",
        full: "h-14 w-full text-lg",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
