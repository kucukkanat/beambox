import RFB from "@novnc/novnc";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Api } from "./api.ts";

const LABELS = {
  connecting: "Connecting to the desktop…",
  disconnected: "The desktop disconnected.",
} as const;

/** The sandbox's X desktop: noVNC through the app's local TCP→WebSocket proxy. */
export function Desktop({ api, name }: { api: Api; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // A blank canvas looks the same whether it's connecting, connected or broken, so say which.
  const [state, setState] = useState<"connecting" | "connected" | "disconnected">("connecting");
  useEffect(() => {
    let rfb: RFB | undefined;
    let closed = false;
    setState("connecting");
    api.desktopPort(name).then(
      (port) => {
        if (closed || !ref.current) return;
        rfb = new RFB(ref.current, `ws://127.0.0.1:${port}`, { wsProtocols: [] });
        rfb.scaleViewport = true;
        rfb.resizeSession = true;
        rfb.addEventListener("connect", () => setState("connected"));
        rfb.addEventListener("disconnect", () => !closed && setState("disconnected"));
      },
      (error) => {
        setState("disconnected");
        toast.error(String(error));
      },
    );
    return () => {
      closed = true;
      rfb?.disconnect();
    };
  }, [api, name]);
  return (
    <div className="relative size-full bg-black">
      <div ref={ref} className="size-full" />
      {state !== "connected" && (
        <p className="absolute inset-0 grid place-items-center text-muted-foreground text-sm">
          {LABELS[state]}
        </p>
      )}
    </div>
  );
}
