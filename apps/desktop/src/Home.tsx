import { AnimatePresence, motion } from "motion/react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import type { Actions } from "./App.tsx";
import type { Api, CreateOpts, Sandbox } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Card } from "./components/ui/card.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.tsx";
import { cn } from "./lib/utils.ts";
import { useItemMotion, usePulse } from "./motion.ts";

type Props = { api: Api; sandboxes: Sandbox[]; actions: Actions; onOpen(name: string): void };

export function Home({ api, sandboxes, actions, onOpen }: Props) {
  return (
    <>
      <header className="flex items-center gap-2">
        <h1 className="mr-auto font-semibold text-xl">Sandboxes</h1>
        <Licences />
        <ConnectAgent api={api} />
        <NewSandbox onCreate={actions.create} />
      </header>
      {sandboxes.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No sandboxes yet. Create one, or connect an agent and let it.
        </p>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
        <AnimatePresence initial={false}>
          {sandboxes.map((s) => (
            <SandboxCard key={s.name} api={api} sandbox={s} actions={actions} onOpen={() => onOpen(s.name)} />
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}

const DOT: Record<Sandbox["status"], string> = {
  booting: "bg-amber-500",
  running: "bg-emerald-500",
  stopped: "bg-muted-foreground",
  crashed: "bg-destructive",
};

export function StatusDot({ status }: { status: Sandbox["status"] }) {
  const pulse = usePulse();
  return (
    <span
      role="img"
      aria-label={status}
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full",
        DOT[status],
        status === "booting" && pulse,
      )}
    />
  );
}

function SandboxCard({
  api,
  sandbox: s,
  actions,
  onOpen,
}: {
  api: Api;
  sandbox: Sandbox;
  actions: Actions;
  onOpen(): void;
}) {
  const item = useItemMotion();
  const running = s.status === "running";
  return (
    <motion.article aria-label={s.name} {...item}>
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <StatusDot status={s.status} />
          <h3 className="truncate font-medium">{s.name}</h3>
          <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
            {s.template}
          </span>
        </div>
        <p className="text-muted-foreground text-xs">
          {s.agent ? `by ${s.agent}` : "by you"} · {s.cpus} vCPU · {s.memoryMib} MiB
        </p>
        <Sparkline api={api} sandbox={s} />
        <div className="flex flex-wrap gap-1">
          <Button size="sm" aria-label={`Open ${s.name}`} onClick={onOpen}>
            Open
          </Button>
          <motion.span whileTap={{ scale: 0.92 }}>
            {running ? (
              <Button size="sm" variant="outline" onClick={() => actions.stop(s.name)}>
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={s.status === "booting"}
                onClick={() => actions.start(s.name)}
              >
                Start
              </Button>
            )}
          </motion.span>
          <Button size="sm" variant="ghost" disabled={!running} onClick={() => actions.fork(s.name)}>
            Fork
          </Button>
          <Button size="sm" variant="ghost" onClick={() => actions.snapshot(s.name)}>
            Snapshot
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Delete ${s.name}`}
            onClick={() => actions.remove(s.name)}
          >
            Delete
          </Button>
        </div>
      </Card>
    </motion.article>
  );
}

/** CPU (sky) and RAM (violet) over the last minute. */
function Sparkline({ api, sandbox }: { api: Api; sandbox: Sandbox }) {
  const [samples, setSamples] = useState<[number, number][]>([]);
  const active = sandbox.status === "running";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () =>
        void api.metrics(sandbox.name).then(
          (m) =>
            setSamples((all) => [
              ...all.slice(-29),
              [m.cpuPercent, (100 * m.memoryBytes) / (sandbox.memoryMib * 1024 * 1024)],
            ]),
          () => {},
        ),
      2000,
    );
    return () => clearInterval(timer);
  }, [api, sandbox.name, sandbox.memoryMib, active]);
  const line = (i: 0 | 1) =>
    samples.map((s, x) => `${x * (100 / 29)},${24 - (Math.min(s[i], 100) * 24) / 100}`).join(" ");
  return (
    <svg viewBox="0 0 100 24" className="h-6 w-full" preserveAspectRatio="none" aria-hidden>
      <polyline points={line(0)} fill="none" className="stroke-sky-500" strokeWidth="1.5" />
      <polyline points={line(1)} fill="none" className="stroke-violet-500" strokeWidth="1.5" />
    </svg>
  );
}

function NewSandbox({ onCreate }: { onCreate(opts: CreateOpts): void }) {
  const [open, setOpen] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    const opts: CreateOpts = { template: text("template"), network: text("network") };
    if (text("mount")) opts.mount = text("mount");
    const ports = text("ports")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (ports.length) opts.ports = ports;
    onCreate(opts);
    setOpen(false);
  };
  const field = "flex flex-col gap-1 text-sm";
  const input = "h-8 rounded-md border border-border bg-background px-2";
  return (
    <div className="flex">
      <Button className="rounded-r-none" onClick={() => onCreate({})}>
        New sandbox
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            className="rounded-l-none border-l border-primary-foreground/20 px-2"
            aria-label="Sandbox options"
          >
            ▾
          </Button>
        </PopoverTrigger>
        <PopoverContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <label className={field}>
              Template
              <select name="template" className={input}>
                <option value="base">Base (Alpine, 256 MiB)</option>
                <option value="desktop">Desktop (Xvfb + VNC, 512 MiB)</option>
              </select>
            </label>
            <label className={field}>
              Mount a folder at /workspace
              <input name="mount" placeholder="/Users/me/project" className={input} />
            </label>
            <label className={field}>
              Network
              <select name="network" className={input}>
                <option value="public">Internet, no local network</option>
                <option value="none">No network</option>
                <option value="all">Internet and local network</option>
              </select>
            </label>
            <label className={field}>
              Publish guest ports
              <input name="ports" placeholder="3000, 8080" className={input} />
            </label>
            <Button type="submit">Create</Button>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ConnectAgent({ api }: { api: Api }) {
  const [command, setCommand] = useState("");
  useEffect(() => void api.mcpCommand().then(setCommand, () => {}), [api]);
  const json = JSON.stringify({ mcpServers: { beambox: { command, args: ["--mcp"] } } }, null, 2);
  const configs = [
    ["Claude Code", `claude mcp add beambox -- "${command}" --mcp`],
    ["Cursor (~/.cursor/mcp.json)", json],
    ["Other MCP clients", json],
  ] as const;
  const copy = (label: string, text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.success(`Copied the ${label} config`),
      () => toast.error("Couldn't copy to the clipboard"),
    );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Connect an agent</Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <p className="mb-3 text-muted-foreground text-sm">
          Copy a config, paste it into your agent, and it can create and use sandboxes.
        </p>
        <div className="flex flex-col gap-2">
          {configs.map(([label, text]) => (
            <Button key={label} variant="outline" className="justify-start" onClick={() => copy(label, text)}>
              Copy for {label}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Licences() {
  const items = [
    ["Beambox", "MIT", null],
    ["microsandbox", "Apache-2.0", "https://github.com/superradcompany/microsandbox"],
    ["libkrunfw (bundled Linux kernel)", "LGPL-2.1 / GPL-2.0", "https://github.com/containers/libkrunfw"],
    ["noVNC", "MPL-2.0", "https://github.com/novnc/noVNC"],
  ] as const;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost">Licences</Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm">
        <ul className="flex flex-col gap-2">
          {items.map(([name, licence, source]) => (
            <li key={name}>
              <span className="font-medium">{name}</span> · {licence}
              {source && (
                <a
                  href={source}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-muted-foreground text-xs underline"
                >
                  Source: {source}
                </a>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
