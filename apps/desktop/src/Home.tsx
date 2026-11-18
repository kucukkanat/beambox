import { AnimatePresence, motion } from "motion/react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { Actions } from "./App.tsx";
import type { AgentStatus, Api, CreateOpts, Harness, Sandbox } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Card } from "./components/ui/card.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.tsx";
import { cn } from "./lib/utils.ts";
import { useItemMotion, usePulse } from "./motion.ts";

/** A create that hasn't finished yet, shown as a booting card so it's clear something is on its way. */
export type Pending = { id: number; label: string };

type Props = {
  api: Api;
  sandboxes: Sandbox[];
  pending?: Pending[];
  actions: Actions;
  onOpen(name: string): void;
};

export function Home({ api, sandboxes, pending = [], actions, onOpen }: Props) {
  return (
    <>
      <header className="flex items-center gap-2">
        <h1 className="mr-auto font-semibold text-xl">Sandboxes</h1>
        <Licences />
        <Settings api={api} />
        <InstallCli api={api} />
        <NewSandbox api={api} onCreate={actions.create} />
      </header>
      {sandboxes.length === 0 && pending.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No sandboxes yet. Create one, or pick an agent under ▾ to give it a computer and a task.
        </p>
      )}
      {/* Wide enough for a card's buttons on one line. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(380px,1fr))] gap-4">
        <AnimatePresence initial={false}>
          {pending.map((p) => (
            <PendingCard key={`pending-${p.id}`} label={p.label} />
          ))}
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

/** The sandbox's state; amber, not green, when it runs but its agent has stopped. */
export function StatusDot({ status, agent }: { status: Sandbox["status"]; agent?: AgentStatus | null }) {
  const pulse = usePulse();
  const stopped = status === "running" && agent === "exited";
  return (
    <span
      role="img"
      aria-label={stopped ? "running, agent stopped" : status}
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full",
        stopped ? "bg-amber-500" : DOT[status],
        status === "booting" && pulse,
      )}
    />
  );
}

/** What an agent sandbox's harness is doing, checked every few seconds while it runs; null for others. */
export function useAgentStatus(api: Api, sandbox: Sandbox): AgentStatus | null {
  const [state, setState] = useState<AgentStatus | null>(null);
  const watch = sandbox.harness !== null && sandbox.status === "running";
  useEffect(() => {
    setState(null);
    if (!watch) return;
    let current = true;
    const poll = () =>
      void api.agentStatus(sandbox.name).then(
        (s) => current && setState(s),
        () => {},
      );
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [api, sandbox.name, watch]);
  return state;
}

function PendingCard({ label }: { label: string }) {
  const item = useItemMotion();
  return (
    <motion.article aria-label="New sandbox, starting" {...item}>
      <Card className="flex h-full flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <StatusDot status="booting" />
          <h3 className="font-medium text-muted-foreground">Starting…</h3>
        </div>
        <p className="text-muted-foreground text-xs">{label}</p>
      </Card>
    </motion.article>
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
  const agent = useAgentStatus(api, s);
  return (
    <motion.article aria-label={s.name} {...item}>
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <StatusDot status={s.status} agent={agent} />
          <h3 className="truncate font-medium">{s.name}</h3>
          {agent === "exited" && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-500 text-xs">
              Agent stopped
            </span>
          )}
          {agent === "frozen" && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">Taken over</span>
          )}
          <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
            {s.template}
          </span>
        </div>
        <p className="text-muted-foreground text-xs">
          {s.harness ? `${s.harness} · ` : ""}
          {s.cpus} vCPU · {s.memoryMib} MiB
        </p>
        <Sparkline api={api} sandbox={s} />
        <div className="flex flex-wrap gap-1">
          {agent === "exited" && (
            <Button size="sm" variant="outline" onClick={() => actions.restartAgent(s.name)}>
              Restart agent
            </Button>
          )}
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
  const last = samples.at(-1);
  const percent = (i: 0 | 1) => (last ? `${Math.round(Math.min(last[i], 100))}%` : "–");
  return (
    <div className="flex flex-col gap-1" title="CPU and memory use over the last minute">
      <svg viewBox="0 0 100 24" className="h-6 w-full" preserveAspectRatio="none" aria-hidden>
        <polyline points={line(0)} fill="none" className="stroke-sky-500" strokeWidth="1.5" />
        <polyline points={line(1)} fill="none" className="stroke-violet-500" strokeWidth="1.5" />
      </svg>
      {active && (
        <p className="flex gap-3 text-muted-foreground text-xs">
          <span>
            <span className="text-sky-500">●</span> CPU {percent(0)}
          </span>
          <span>
            <span className="text-violet-500">●</span> Memory {percent(1)}
          </span>
        </p>
      )}
    </div>
  );
}

const HARNESSES: [Harness, string][] = [
  ["claude-code", "Claude Code"],
  ["codex", "Codex CLI"],
  ["opencode", "OpenCode"],
];

const KEY_HELP: Record<string, [label: string, help: string]> = {
  anthropic: ["Anthropic key", "An API key from console.anthropic.com → API keys."],
  openai: ["OpenAI key", "An API key from platform.openai.com → API keys."],
};

function NewSandbox({ api, onCreate }: { api: Api; onCreate(opts: CreateOpts): void }) {
  const [open, setOpen] = useState(false);
  const [harness, setHarness] = useState("");
  const [desktop, setDesktop] = useState(false);
  const [mount, setMount] = useState("");
  // Keys the chosen agent could use when none is stored yet. Optional: without one, the agent asks you to sign in
  // (subscription or key) in its own terminal, which the app opens after creating it.
  const [missing, setMissing] = useState<string[]>([]);
  const [provider, setProvider] = useState("");
  useEffect(() => {
    setMissing([]);
    if (!open || !harness) return;
    let current = true;
    api.missingCredentials(harness as Harness).then((keys) => {
      if (!current) return;
      setMissing(keys);
      setProvider(keys[0] ?? "");
    }, showError);
    return () => {
      current = false;
    };
  }, [api, open, harness]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    if (missing.length && text("key")) {
      try {
        await api.setCredential(provider, text("key"));
      } catch (error) {
        return showError(error);
      }
    }
    const opts: CreateOpts = { network: text("network") };
    if (text("name")) opts.name = text("name");
    if (Number(text("cpus")) > 0) opts.cpus = Number(text("cpus"));
    if (Number(text("memory")) > 0) opts.memoryMib = Number(text("memory"));
    if (harness) opts.harness = harness as Harness;
    if (harness && text("task")) opts.task = text("task");
    if (desktop) opts.desktop = true;
    if (mount.trim()) opts.mount = mount.trim();
    const ports = text("ports")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (ports.length) opts.ports = ports;
    onCreate(opts);
    setOpen(false);
    setMount("");
  };
  const browse = () => void api.pickFolder().then((folder) => folder && setMount(folder), showError);
  // The core's defaults, so the empty fields say what you get.
  const defaultCpus = harness || desktop ? 2 : 1;
  const defaultMemory = desktop ? 4096 : harness ? 2048 : 1024;
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
        <PopoverContent className="w-80">
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
            <label className={field}>
              Name
              <input name="name" placeholder="Automatic: sandbox-1, sandbox-2…" className={input} />
            </label>
            <label className={field}>
              Harness
              <select
                name="harness"
                className={input}
                value={harness}
                onChange={(e) => setHarness(e.target.value)}
              >
                <option value="">None: a plain sandbox</option>
                {HARNESSES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {missing.length > 0 && (
              <div className="flex flex-col gap-1 rounded-md border border-border p-2 text-sm">
                {missing.length > 1 && (
                  <select
                    aria-label="Key provider"
                    className={input}
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                  >
                    {missing.map((p) => (
                      <option key={p} value={p}>
                        {KEY_HELP[p]?.[0] ?? p}
                      </option>
                    ))}
                  </select>
                )}
                <label className={field}>
                  {KEY_HELP[provider]?.[0] ?? `${provider} key`}
                  <input
                    name="key"
                    type="password"
                    autoComplete="off"
                    placeholder="Optional: paste once, kept in your keychain"
                    className={input}
                  />
                </label>
                <p className="text-muted-foreground text-xs">
                  {KEY_HELP[provider]?.[1]} Or leave it empty and sign in with your subscription or key in the
                  agent's terminal.
                </p>
              </div>
            )}
            <label className={field}>
              Task
              <textarea
                name="task"
                rows={3}
                disabled={!harness}
                placeholder={harness ? "Fix the failing tests" : "Pick a harness first"}
                className="rounded-md border border-border bg-background px-2 py-1 disabled:opacity-50"
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-sm">
              Desktop
              <input
                type="checkbox"
                role="switch"
                aria-checked={desktop}
                checked={desktop}
                onChange={(e) => setDesktop(e.target.checked)}
                className={cn(
                  "relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full border border-border bg-muted transition-colors",
                  "before:absolute before:top-0.5 before:left-0.5 before:size-3.5 before:rounded-full before:bg-muted-foreground before:transition-transform",
                  "checked:border-primary checked:bg-primary checked:before:translate-x-4 checked:before:bg-primary-foreground",
                  "focus-visible:outline-2 focus-visible:outline-ring",
                )}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className={field}>
                vCPUs
                <input
                  name="cpus"
                  type="number"
                  min={1}
                  max={16}
                  placeholder={String(defaultCpus)}
                  className={input}
                />
              </label>
              <label className={field}>
                Memory (MiB)
                <input
                  name="memory"
                  type="number"
                  min={256}
                  placeholder={String(defaultMemory)}
                  className={input}
                />
              </label>
            </div>
            <div className={field}>
              <label htmlFor="mount">Mount a folder at /workspace</label>
              <div className="flex gap-2">
                <input
                  id="mount"
                  name="mount"
                  value={mount}
                  onChange={(e) => setMount(e.target.value)}
                  placeholder="/Users/me/project"
                  className={cn(input, "min-w-0 flex-1")}
                />
                <Button type="button" size="sm" variant="outline" onClick={browse}>
                  Browse…
                </Button>
              </div>
            </div>
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

function InstallCli({ api }: { api: Api }) {
  const install = () =>
    void api.installCli().then(
      (message) => toast.success(message),
      (error) => toast.error(String(error)),
    );
  return (
    <Button variant="outline" onClick={install}>
      Install the beambox command
    </Button>
  );
}

const PROVIDERS = [
  ["anthropic", "Anthropic API key, or a token from claude setup-token. Used by Claude Code and OpenCode."],
  ["openai", "OpenAI API key. Used by Codex CLI, and by OpenCode when there's no Anthropic key."],
] as const;

/** Settings → Credentials: keys stored once in the OS keychain and given to each harness at start. */
function Settings({ api }: { api: Api }) {
  const [stored, setStored] = useState<string[]>([]);
  const load = useCallback(() => void api.credentials().then(setStored, () => {}), [api]);
  const save = (event: FormEvent<HTMLFormElement>, name: string) => {
    event.preventDefault();
    const form = event.currentTarget;
    const value = String(new FormData(form).get("value") ?? "");
    void api.setCredential(name, value).then(() => {
      form.reset();
      toast.success(`Stored the ${KEY_HELP[name]?.[0] ?? name}`);
      load();
    }, showError);
  };
  const remove = (name: string) => void api.removeCredential(name).then(load, showError);
  return (
    <Popover onOpenChange={(open) => open && load()}>
      <PopoverTrigger asChild>
        <Button variant="ghost">Settings</Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 text-sm">
        <h2 className="mb-1 font-medium">Credentials</h2>
        <p className="mb-3 text-muted-foreground text-xs">
          Kept in your system keychain. Agents get them as environment variables, never on their disk.
        </p>
        <div className="flex flex-col gap-4">
          {PROVIDERS.map(([name, help]) => {
            const has = stored.includes(name);
            return (
              <form key={name} onSubmit={(e) => save(e, name)} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{KEY_HELP[name]?.[0] ?? name}</span>
                  <span
                    className={cn(
                      "mr-auto rounded px-1.5 py-0.5 text-xs",
                      has ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {has ? "Stored" : "Not set"}
                  </span>
                  {has && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${name}`}
                      onClick={() => remove(name)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    name="value"
                    type="password"
                    autoComplete="off"
                    aria-label={`${name} key or token`}
                    placeholder={has ? "Replace…" : "Paste a key"}
                    className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2"
                  />
                  <Button type="submit" size="sm" aria-label={`Save ${name}`}>
                    Save
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">{help}</p>
              </form>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const showError = (error: unknown) => void toast.error(String(error));

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
