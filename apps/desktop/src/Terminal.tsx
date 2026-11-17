import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import type { Api } from "./api.ts";

/** A login shell in the sandbox: xterm.js over an SDK exec session with a TTY. */
export function Terminal({ api, name }: { api: Api; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current as HTMLDivElement;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, Menlo, Consolas, monospace",
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();
    let id: number | undefined;
    let closed = false;
    api
      .terminalOpen(name, (data) => term.write(data))
      .then(
        (opened) => {
          if (closed) return void api.terminalClose(opened);
          id = opened;
          void api.terminalResize(opened, term.rows, term.cols);
          term.focus();
        },
        (error) => term.write(`\r\n${error}\r\n`),
      );
    const input = term.onData((data) => id !== undefined && void api.terminalInput(id, data));
    const resize = new ResizeObserver(() => {
      fit.fit();
      if (id !== undefined) void api.terminalResize(id, term.rows, term.cols);
    });
    resize.observe(element);
    return () => {
      closed = true;
      if (id !== undefined) void api.terminalClose(id);
      resize.disconnect();
      input.dispose();
      term.dispose();
    };
  }, [api, name]);
  return <div ref={ref} className="size-full" />;
}
