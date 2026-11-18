import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

/** A chassis panel (styles in index.css). */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("panel", className)} {...props} />;
}
