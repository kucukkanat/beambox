import { AnimatePresence, motion } from "motion/react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { Actions } from "./App.tsx";
import { plainText } from "./ansi.ts";
import type { Api, CreateOpts, Sandbox } from "./api.ts";
import { type BoxState, bootStages, HELPERS, helperOf, needsYou, STATES, WORD } from "./box.ts";
import { Button } from "./components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.tsx";
import { HoldKey, Icon, Led, Tool } from "./keys.tsx";
import { cn, showError } from "./lib/utils.ts";
import { useItemMotion } from "./motion.ts";
import { sound } from "./sound.ts";

/** A create that hasn't finished yet, shown as a booting card that narrates the boot. */
export type Pending = { id: number; opts: CreateOpts; preparing: boolean };
export type Box = { sandbox: Sandbox; state: BoxState };

type Props = {
  api: Api;
  boxes: Box[];
  pending: Pending[];
  tasks: Record<string, string>;
  actions: Actions;
  onNew(): void;
};

const rank = (state: BoxState) => STATES.indexOf(state);

export function Shelf({ api, boxes, pending, tasks, actions, onNew }: Props) {
  const item = useItemMotion();
  const waiting = boxes.filter((b) => needsYou(b.state));
  // Pending creates sit with the booting boxes; the sort is stable.
  const slots = [
    ...boxes.map((b) => ({ key: b.sandbox.name, rank: rank(b.state), box: b as Box | null, pending: null })),
    ...pending.map((p) => ({ key: `pending-${p.id}`, rank: rank("booting"), box: null, pending: p })),
  ].sort((a, b) => a.rank - b.rank);
  return (
    <>
      <Header
        boxes={boxes.length + pending.length}
        working={boxes.filter((b) => b.state === "working" || b.state === "booting").length + pending.length}
        waiting={waiting.length}
        api={api}
        onNew={onNew}
      />
      {waiting.length > 0 && (
        <section aria-label="Waiting for you" className="flex flex-col gap-3">
          <div className="sect">
            <Led state="agent-stopped" />
            <h2>Waiting for you · {waiting.length}</h2>
            <span className="rule" />
          </div>
          <div className="tray-row">
            {waiting.map((b) => (
              <NeedsCard key={b.sandbox.name} box={b} actions={actions} />
            ))}
          </div>
        </section>
      )}
      <section aria-label="Shelf" className="flex flex-col gap-3">
        <div className="sect">
          <h2>
            Shelf · {slots.length} {slots.length === 1 ? "box" : "boxes"}
          </h2>
          <span className="rule" />
          <span className="mono dim">Boxes that need you come first</span>
        </div>
        {slots.length === 0 ? (
          <div className="empty">
            <h3>Your shelf is empty</h3>
            <p>
              A box is a separate computer for one agent and one job. Nothing it does can touch your own
              computer, apart from a folder you choose to lend it. Press <kbd>N</kbd> to make one.
            </p>
          </div>
        ) : (
          <div className="shelf">
            <AnimatePresence initial={false}>
              {slots.map((slot) => (
                <motion.div key={slot.key} className="min-w-0" {...item}>
                  {slot.box ? (
                    <BoxCard api={api} box={slot.box} task={tasks[slot.box.sandbox.name]} actions={actions} />
                  ) : (
                    slot.pending && <PendingCard pending={slot.pending} />
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </section>
    </>
  );
}

function Header({
  boxes,
  working,
  waiting,
  api,
  onNew,
}: {
  boxes: number;
  working: number;
  waiting: number;
  api: Api;
  onNew(): void;
}) {
  const [muted, setMuted] = useState(sound.muted);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <header className="top">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <i />
        </div>
        <div>
          <h1>beambox</h1>
          <p className="mono dim mt-[3px]">A computer for every agent</p>
        </div>
      </div>
      <div
        className="lcd"
        role="status"
        aria-label={`${boxes} boxes, ${working} working, ${waiting} waiting for you`}
      >
        <div className="cell">
          <b>{pad(boxes)}</b>
          <small>Boxes</small>
        </div>
        <div className="cell green">
          <b>{pad(working)}</b>
          <small>Working</small>
        </div>
        <div className={cn("cell", waiting && "amber")}>
          <b>{pad(waiting)}</b>
          <small>For you</small>
        </div>
      </div>
      <Button
        size="sq"
        aria-label={muted ? "Turn sounds on" : "Turn sounds off"}
        aria-pressed={muted}
        title={muted ? "Sounds off" : "Sounds on"}
        onClick={() => {
          sound.setMuted(!muted);
          setMuted(!muted);
        }}
      >
        <Icon name={muted ? "mute" : "sound"} />
      </Button>
      <More api={api} />
      <Button variant="accent" size="big" aria-label="New box" onClick={onNew}>
        <Icon name="plus" /> New box <kbd>N</kbd>
      </Button>
    </header>
  );
}

function NeedsCard({ box, actions }: { box: Box; actions: Actions }) {
  const { name } = box.sandbox;
  const helper = HELPERS[helperOf(box.sandbox)];
  const say: Partial<Record<BoxState, [string, ReactNode]>> = {
    "agent-stopped": [
      `${helper.name} has stopped, for example because its sign-in timed out.`,
      <Button key="k" variant="accent" onClick={() => actions.restartAgent(name)}>
        Start agent again
      </Button>,
    ],
    crashed: [
      "This box crashed. Its files are kept.",
      <Button key="k" variant="accent" onClick={() => actions.start(name)}>
        Wake
      </Button>,
    ],
    "sign-in": [
      `${helper.name} needs you to sign in once, in its terminal.`,
      <Button key="k" variant="accent" onClick={() => actions.open(name, "terminal")}>
        <Icon name="term" size={16} /> Open terminal
      </Button>,
    ],
  };
  const [text, key] = say[box.state] ?? ["", null];
  return (
    <div className="needs">
      <div className="needs-top">
        <Led state={box.state} />
        <button type="button" className="needs-name" onClick={() => actions.open(name)}>
          {name}
        </button>
        <span className="state-word needs-you">{WORD[box.state]}</span>
        {box.state === "sign-in" && (
          <Button
            size="sq"
            className="ml-auto"
            aria-label="Dismiss"
            onClick={() => actions.dismissSignIn(name)}
          >
            <Icon name="close" size={16} />
          </Button>
        )}
      </div>
      <p>{text}</p>
      <div className="flex flex-wrap gap-2.5">{key}</div>
    </div>
  );
}

// When this window first saw each box run. Outside the cards: the shelf unmounts while a box is open.
const runningSince = new Map<string, number>();

/** How long a box has been running, counted from when this window first saw it run. */
function useUptime(name: string, running: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return void runningSince.delete(name);
    if (!runningSince.has(name)) runningSince.set(name, Date.now());
    tick((n) => n + 1);
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [name, running]);
  const since = runningSince.get(name);
  if (since === undefined) return null;
  const minutes = Math.round((Date.now() - since) / 60_000);
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes} min`
      : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function BoxCard({
  api,
  box,
  task,
  actions,
}: {
  api: Api;
  box: Box;
  task: string | undefined;
  actions: Actions;
}) {
  const s = box.sandbox;
  const helper = helperOf(s);
  const running = s.status === "running";
  const uptime = useUptime(s.name, running);
  return (
    <article className="box" aria-label={s.name}>
      <div className="screws" aria-hidden="true">
        <i />
        <i />
      </div>
      <button
        type="button"
        className="screen-btn"
        aria-label={`Open ${s.name}`}
        onClick={() => actions.open(s.name)}
      >
        <Screen state={box.state}>
          {box.state === "booting" ? (
            <BootPanel stages={[{ label: "Waking up", log: "start the box" }]} />
          ) : (
            <Logs api={api} name={s.name} running={running} />
          )}
        </Screen>
      </button>
      <div className="plate">
        <div className="plate-row">
          <Led state={box.state} />
          <span className={cn("state-word", needsYou(box.state) && "needs-you")}>{WORD[box.state]}</span>
          {uptime && <span className="mono dim">· {uptime}</span>}
          <span className="helper-chip">
            <span className="mark" aria-hidden="true">
              {HELPERS[helper].mark}
            </span>
            {HELPERS[helper].short}
          </span>
        </div>
        <h3>{s.name}</h3>
        <p className="task">
          {task ??
            (helper === "none"
              ? "A clean computer for you to use. No agent inside."
              : `${HELPERS[helper].name} at work.`)}
        </p>
        <Tools box={box} actions={actions} />
      </div>
    </article>
  );
}

/** Sleep/Wake, Save point, Try another way and Throw away, on a card and in the box view. */
export function Tools({
  box,
  actions,
  className = "controls",
}: {
  box: Box;
  actions: Actions;
  className?: string;
}) {
  const { name, status } = box.sandbox;
  const booting = status === "booting";
  return (
    <div className={className}>
      {status === "running" || booting ? (
        <Tool icon="moon" label="Sleep" onClick={() => actions.stop(name)} disabled={booting} />
      ) : (
        <Tool icon="sun" label="Wake" onClick={() => actions.start(name)} />
      )}
      <Tool icon="camera" label="Save point" onClick={() => actions.snapshot(name)} disabled={booting} />
      <Tool
        icon="split"
        label="Try another way"
        onClick={() => actions.fork(name)}
        disabled={status !== "running"}
      />
      <HoldKey label="Throw away" onConfirm={() => actions.remove(name)} />
    </div>
  );
}

/** A bezelled screen with a shutter that closes while the box is asleep. */
export function Screen({ state, big, children }: { state: BoxState; big?: boolean; children: ReactNode }) {
  const asleep = state === "asleep";
  return (
    <div
      className={cn("screen", big && "big", needsYou(state) && "needs-you", state === "driving" && "driving")}
    >
      <div className="screen-inner">{children}</div>
      <div className="glass" />
      <div
        className={cn("shutter", asleep && "closed")}
        {...(asleep ? { role: "img", "aria-label": "Asleep" } : { "aria-hidden": true })}
      >
        <span>ASLEEP</span>
      </div>
    </div>
  );
}

/** The last lines of the box's terminal output, as plain text, every 2 s while it runs. */
function Logs({ api, name, running }: { api: Api; name: string; running: boolean }) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (!running) return;
    const poll = () => void api.logs(name).then(setLines, () => {});
    poll();
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [api, name, running]);
  return (
    <pre className="term">
      {plainText(lines.join("")).replace(/\n$/, "").split("\n").slice(-9).join("\n")}
    </pre>
  );
}

const SEGMENTS = 24;
const STAGE_MS = 1200;

/** Named stages on a 1.2 s timer; the last one holds until the create settles. */
export function BootPanel({ stages }: { stages: { label: string; log: string }[] }) {
  const [at, setAt] = useState(0);
  const last = stages.length - 1;
  useEffect(() => {
    const timer = setInterval(() => setAt((n) => n + 1), STAGE_MS);
    return () => clearInterval(timer);
  }, []);
  const current = stages[Math.min(at, last)] ?? { label: "", log: "" };
  const linear = Math.min(1, (Math.min(at, last) + 1) / (stages.length + 1));
  // Fills faster near the end.
  const lit = Math.round((0.55 * linear + 0.45 * linear * linear) * SEGMENTS);
  return (
    <div className="boot" role="status">
      <div className="boot-title">{current.label}…</div>
      <div className="segs" aria-hidden="true">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed segments
          <i key={i} className={i < lit ? "on" : ""} />
        ))}
      </div>
      <div className="boot-log">› {current.log}</div>
    </div>
  );
}

function PendingCard({ pending }: { pending: Pending }) {
  const helper = pending.opts.harness ?? "none";
  // Remount on `preparing`, so the boot starts over at the first stage that says so.
  return (
    <article className="box" aria-label="New box, getting ready">
      <Screen state="booting">
        <BootPanel key={String(pending.preparing)} stages={bootStages(pending.opts, pending.preparing)} />
      </Screen>
      <div className="plate">
        <div className="plate-row">
          <Led state="booting" />
          <span className="state-word">{WORD.booting}</span>
          <span className="helper-chip">{HELPERS[helper].short}</span>
        </div>
        <h3>{pending.opts.name ?? "New box"}</h3>
        <p className="task">{pending.opts.task ?? HELPERS[helper].by}</p>
      </div>
    </article>
  );
}

/** ⋯: Settings (credentials), Licences and Install the beambox command. */
function More({ api }: { api: Api }) {
  const [panel, setPanel] = useState<"menu" | "settings" | "licences">("menu");
  const install = () =>
    void api.installCli().then(
      (message) => toast.success(message),
      (error) => toast.error(String(error)),
    );
  return (
    <Popover onOpenChange={(open) => open && setPanel("menu")}>
      <PopoverTrigger asChild>
        <Button size="sq" aria-label="More" title="More">
          <Icon name="more" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className={cn("text-sm", panel === "menu" ? "w-72" : "w-96")}>
        {panel === "menu" && (
          <div className="flex flex-col items-stretch gap-2.5">
            <Button onClick={() => setPanel("settings")}>Settings</Button>
            <Button onClick={() => setPanel("licences")}>Licences</Button>
            <Button onClick={install}>Install the beambox command</Button>
          </div>
        )}
        {panel === "settings" && <Settings api={api} />}
        {panel === "licences" && <Licences />}
      </PopoverContent>
    </Popover>
  );
}

export const KEY_HELP: Record<string, [label: string, help: string]> = {
  anthropic: ["Anthropic key", "An API key from console.anthropic.com → API keys."],
  openai: ["OpenAI key", "An API key from platform.openai.com → API keys."],
};

const PROVIDERS = [
  ["anthropic", "Anthropic API key, or a token from claude setup-token. Used by Claude Code and OpenCode."],
  ["openai", "OpenAI API key. Used by Codex CLI, and by OpenCode when there's no Anthropic key."],
] as const;

/** Credentials: keys stored once in the OS keychain and given to each harness at start. */
function Settings({ api }: { api: Api }) {
  const [stored, setStored] = useState<string[]>([]);
  const load = useCallback(() => void api.credentials().then(setStored, () => {}), [api]);
  useEffect(load, [load]);
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
    <>
      <h2 className="mb-1 font-semibold">Credentials</h2>
      <p className="mb-3 text-muted-foreground text-xs">
        Kept in your system keychain. Agents get them as environment variables, never on their disk.
      </p>
      <div className="flex flex-col gap-4">
        {PROVIDERS.map(([name, help]) => {
          const has = stored.includes(name);
          return (
            <form key={name} onSubmit={(e) => save(e, name)} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="font-medium">{KEY_HELP[name]?.[0] ?? name}</span>
                <span className={cn("mono mr-auto", has ? "text-[var(--led-green)]" : "dim")}>
                  {has ? "Stored" : "Not set"}
                </span>
                {has && (
                  <Button size="sm" aria-label={`Remove ${name}`} onClick={() => remove(name)}>
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
                  className="field small min-w-0 flex-1"
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
    </>
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
  );
}
