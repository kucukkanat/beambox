import RFB from "@novnc/novnc";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { Api } from "./api.ts";

/** The sandbox's X desktop: noVNC through the app's local TCP→WebSocket proxy. */
export function Desktop({ api, name }: { api: Api; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let rfb: RFB | undefined;
    let closed = false;
    api.desktopPort(name).then(
      (port) => {
        if (closed || !ref.current) return;
        rfb = new RFB(ref.current, `ws://127.0.0.1:${port}`, { wsProtocols: [] });
        rfb.scaleViewport = true;
        rfb.resizeSession = true;
      },
      (error) => toast.error(String(error)),
    );
    return () => {
      closed = true;
      rfb?.disconnect();
    };
  }, [api, name]);
  return <div ref={ref} className="size-full bg-black" />;
}
