import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";
import { sound } from "../../sound.ts";

// Raised hardware keys with 3 px of travel on :active and aria-pressed (styles in index.css).
const buttonVariants = cva("key", {
  variants: {
    variant: { key: "", accent: "orange" },
    size: { default: "", sq: "sq", big: "big", sm: "sm" },
  },
  defaultVariants: { variant: "key", size: "default" },
});

export function Button({
  className,
  variant,
  size,
  onPointerDown,
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      type="button"
      className={cn(buttonVariants({ variant, size }), className)}
      onPointerDown={(e) => {
        sound.press();
        onPointerDown?.(e);
      }}
      {...props}
    />
  );
}
