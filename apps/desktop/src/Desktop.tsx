import RFB from "@novnc/novnc";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Api } from "./api.ts";

const LABELS = {
  connecting: "Connecting to the desktop…",
  disconnected: "The desktop disconnected.",
} as const;

/** "fit" follows the tab's size; the rest are screen sizes Xvnc offers through `xrandr -s`. */
export const RESOLUTIONS = ["fit", "1280x800", "1680x1050", "1920x1080", "1920x1200"] as const;
type Resolution = (typeof RESOLUTIONS)[number];
const STORAGE_KEY = "beambox.desktop-resolution";

function savedResolution(): Resolution {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return RESOLUTIONS.find((r) => r === saved) ?? "fit";
  } catch {
    return "fit";
  }
}

/**
 * The sandbox's X desktop: noVNC through the app's local TCP→WebSocket proxy. With "Fit window", Xvnc resizes its
 * screen to this element (`resizeSession`), so it's drawn 1:1. A fixed resolution sets the screen to that size and
 * scales it down to fit, so everything on it looks smaller.
 */
export function Desktop({ api, name }: { api: Api; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB>(undefined);
  // A blank canvas looks the same whether it's connecting, connected or broken, so say which.
  const [state, setState] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [resolution, setResolution] = useState(savedResolution);
  useEffect(() => {
    let closed = false;
    setState("connecting");
    api.desktopPort(name).then(
      (port) => {
        if (closed || !ref.current) return;
        const client = new RFB(ref.current, `ws://127.0.0.1:${port}`, { wsProtocols: [] });
        rfb.current = client;
        client.scaleViewport = true;
        client.addEventListener("connect", () => setState("connected"));
        client.addEventListener("disconnect", () => !closed && setState("disconnected"));
        // Text copied in the sandbox (vncconfig relays it) lands on this computer's clipboard.
        client.addEventListener(
          "clipboard",
          (event) => void navigator.clipboard.writeText(event.detail.text).catch(() => {}),
        );
      },
      (error) => {
        setState("disconnected");
        toast.error(String(error));
      },
    );
    return () => {
      closed = true;
      rfb.current?.disconnect();
      rfb.current = undefined;
    };
  }, [api, name]);
  // Applied on every connect too: the sandbox restarts at 1280x800.
  useEffect(() => {
    const client = rfb.current;
    if (state !== "connected" || !client) return;
    try {
      localStorage.setItem(STORAGE_KEY, resolution);
    } catch {}
    // Turning resizeSession on asks Xvnc for the tab's size straight away.
    client.resizeSession = resolution === "fit";
    if (resolution === "fit") return;
    const [width, height] = resolution.split("x");
    api.desktopResize(name, Number(width), Number(height)).catch((error) => toast.error(String(error)));
  }, [api, name, resolution, state]);
  return (
    <div className="relative size-full bg-black">
      <div ref={ref} className="size-full" />
      {state !== "connected" && (
        <p className="absolute inset-0 grid place-items-center text-muted-foreground text-sm">
          {LABELS[state]}
        </p>
      )}
      <select
        aria-label="Resolution"
        value={resolution}
        onChange={(e) => setResolution(e.target.value as Resolution)}
        className="absolute top-1 right-2 h-6 rounded-md border border-border bg-background/80 px-1.5 text-xs opacity-60 transition-opacity hover:opacity-100 focus:opacity-100"
      >
        {RESOLUTIONS.map((r) => (
          <option key={r} value={r}>
            {r === "fit" ? "Fit window" : r.replace("x", " × ")}
          </option>
        ))}
      </select>
    </div>
  );
}
