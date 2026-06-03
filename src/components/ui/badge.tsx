import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-white/10 bg-white/5 text-zinc-200",
        success: "border-emerald-300/25 bg-emerald-300/10 text-emerald-100",
        warning: "border-amber-300/25 bg-amber-300/10 text-amber-100",
        danger: "border-red-300/25 bg-red-300/10 text-red-100",
        info: "border-cyan-300/25 bg-cyan-300/10 text-cyan-100",
        demo: "border-violet-300/25 bg-violet-300/10 text-violet-100",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}
