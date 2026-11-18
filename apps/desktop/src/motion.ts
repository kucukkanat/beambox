import { useSyncExternalStore } from "react";

export const spring = { type: "spring", stiffness: 500, damping: 34 } as const;

const QUERY = "(prefers-reduced-motion: reduce)";
const subscribe = (onChange: () => void) => {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};

/** Live `prefers-reduced-motion` (Motion's own hook caches the first answer). */
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches);
}

/** Enter/exit/layout animation for list items, or nothing at all with reduced motion. */
export function useItemMotion() {
  return useReducedMotion()
    ? {}
    : {
        layout: true,
        initial: { opacity: 0, scale: 0.96 },
        animate: { opacity: 1, scale: 1 },
        exit: { opacity: 0, scale: 0.96 },
        transition: spring,
      };
}
