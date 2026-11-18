import { type ReactNode, useEffect, useRef, useState } from "react";
import { type BoxState, LED } from "./box.ts";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import { HOLD_MS, sound } from "./sound.ts";

const PATHS: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  split: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="5" r="2" />
      <circle cx="12" cy="19" r="2" />
      <path d="M6 7v1a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V7M12 12v5" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  back: <path d="M15 5l-7 7 7 7" />,
  sound: (
    <>
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      <path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11" />
    </>
  ),
  mute: (
    <>
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      <path d="M17 9.5l5 5M22 9.5l-5 5" />
    </>
  ),
  folder: <path d="M3 6h6l2 2h10v11H3z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="1" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  term: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d="M7 9l3 3-3 3M12 15h5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />,
  restart: <path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" />,
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

export const Led = ({ state, className }: { state: BoxState; className?: string }) => (
  <span className={cn("led", LED[state], className)} aria-hidden="true" />
);

/** A square key with its label printed underneath. */
export function Tool({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: keyof typeof PATHS;
  label: string;
  onClick(): void;
  disabled?: boolean;
}) {
  return (
    <div className="tool">
      <Button variant="key" size="sq" aria-label={label} title={label} onClick={onClick} disabled={disabled}>
        <Icon name={icon} />
      </Button>
      <span aria-hidden="true">{label}</span>
    </div>
  );
}

/**
 * A key that fires only after a full press-and-hold (pointer, or Space/Enter held): a ring fills over
 * `HOLD_MS` with a rising tone, and springs back if let go early.
 */
export function HoldKey({ label, onConfirm }: { label: string; onConfirm(): void }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stopTone = useRef<() => void>(undefined);
  const end = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    stopTone.current?.();
    stopTone.current = undefined;
    setHolding(false);
  };
  const begin = () => {
    if (timer.current) return;
    stopTone.current = sound.hold();
    setHolding(true);
    timer.current = setTimeout(() => {
      end();
      onConfirm();
    }, HOLD_MS);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: stop the timer and tone on unmount only
  useEffect(() => end, []);
  return (
    <div className={cn("tool", holding && "armed")}>
      <button
        type="button"
        className={cn("key sq hold", holding && "holding")}
        aria-label={`${label}: press and hold`}
        title="Press and hold"
        onPointerDown={(e) => {
          e.preventDefault();
          begin();
        }}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            begin();
          }
        }}
        onKeyUp={(e) => (e.key === " " || e.key === "Enter") && end()}
      >
        <svg className="hold-ring" viewBox="0 0 50 50" aria-hidden="true">
          <rect
            x="2"
            y="2"
            width="46"
            height="46"
            rx="13"
            pathLength="1"
            strokeDasharray="1 1"
            strokeDashoffset={holding ? 0 : 1}
          />
        </svg>
        <Icon name="trash" />
      </button>
      <span aria-hidden="true">{holding ? "Keep holding" : label}</span>
    </div>
  );
}
