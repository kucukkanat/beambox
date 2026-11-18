import RFB from "@novnc/novnc";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Api } from "./api.ts";

const LABELS = {
  connecting: "Connecting to the desktop…",
  disconnected: "The desktop disconnected.",
} as const;

/**
 * The sandbox's X desktop: noVNC through the app's local TCP→WebSocket proxy. Xvnc resizes its screen to this
 * element (`resizeSession`), so it's always drawn 1:1.
 */
export function Desktop({ api, name }: { api: Api; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB>(undefined);
  // A blank canvas looks the same whether it's connecting, connected or broken, so say which.
  const [state, setState] = useState<"connecting" | "connected" | "disconnected">("connecting");
  useEffect(() => {
    let closed = false;
    setState("connecting");
    api.desktopPort(name).then(
      (port) => {
        if (closed || !ref.current) return;
        const client = new RFB(ref.current, `ws://127.0.0.1:${port}`, { wsProtocols: [] });
        rfb.current = client;
        client.scaleViewport = true;
        // Asks Xvnc for this element's size on connect, and again whenever it changes.
        client.resizeSession = true;
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
