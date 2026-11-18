import { Dialog } from "radix-ui";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import type { Actions } from "./App.tsx";
import type { Api, DirEntry, Sandbox } from "./api.ts";
import { type BoxState, basename, HELPERS, helperOf, WORD } from "./box.ts";
import { Button } from "./components/ui/button.tsx";
import { Desktop } from "./Desktop.tsx";
import { Icon, Led } from "./keys.tsx";
import { cn, showError, typing } from "./lib/utils.ts";
import { SavePoints } from "./SavePoints.tsx";
import { Folder, Screen, Tools } from "./Shelf.tsx";
import { Terminal } from "./Terminal.tsx";

export type Mode = "screen" | "terminal" | "files" | "previews";

type Props = {
  api: Api;
  sandbox: Sandbox;
  state: BoxState;
  initialMode: Mode | undefined;
  actions: Actions;
  /** Bumped after each save point: the strip reloads. */
  saves: number;
  /** A rewind is running: the screen plays it. */
  rewinding: boolean;
  /** Flip the AGENT / YOU lever; handing back may carry a note for the agent. */
  onTakeover(on: boolean, note?: string): void;
  /** The Terminal is showing: a pending sign-in is now in front of you. */
  onTerminal(): void;
  onBack(): void;
};

/** Guest ports Beambox itself publishes for the desktop, said in words instead of offered as a web page. */
const DESKTOP_PORTS: Record<number, string> = { 5900: "Desktop (VNC): shown on the Screen" };

export function BoxView({
  api,
  sandbox: s,
  state,
  initialMode,
  actions,
  saves,
  rewinding,
  onTakeover,
  onTerminal,
  onBack,
}: Props) {
  const hasScreen = s.template === "desktop";
  const [mode, setMode] = useState<Mode>(initialMode ?? (hasScreen ? "screen" : "terminal"));
  const [handBack, setHandBack] = useState(false);
  /** The screen covers the whole window, with no header, mode buttons or tools. */
  const [full, setFull] = useState(false);
  const helper = HELPERS[helperOf(s)];
  const running = s.status === "running";
  const driving = state === "driving";
  const terminalShown = useRef(onTerminal);
  terminalShown.current = onTerminal;
  useEffect(() => {
    if (mode === "terminal") terminalShown.current();
  }, [mode]);
  // Esc goes back to the shelf, unless it's meant for the terminal, a field or the hand-back dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || handBack || typing(event.target)) return;
      if (full) setFull(false);
      else onBack();
    };
    // ⌘⇧F toggles the full window. Caught before noVNC or the terminal sees it, so it never reaches the box.
    const onToggle = (event: KeyboardEvent) => {
      if (!(event.metaKey && event.shiftKey && event.key.toLowerCase() === "f")) return;
      event.preventDefault();
      event.stopPropagation();
      setFull((f) => !f);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onToggle, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onToggle, true);
    };
  }, [full, handBack, onBack]);

  const modes = (
    [
      ["screen", "Screen", "monitor"],
      ["terminal", "Terminal", "term"],
      ["files", "Files", "folder"],
      ["previews", "Web previews", "globe"],
    ] as const
  ).filter(([id]) => id !== "screen" || hasScreen);
  const off = <p className="empty-screen">Wake the box to use this.</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[18px]">
      {/* The header and the screen fill the window's height; Save points are below, a scroll away. */}
      <div className="flex h-[calc(100dvh-20px)] min-h-[520px] flex-col gap-[18px]">
        <header className="d-head">
          <Button aria-label="Back to the shelf" onClick={onBack}>
            <Icon name="back" /> Shelf <kbd>Esc</kbd>
          </Button>
          <div className="d-title">
            <h1 className="flex items-center gap-2.5">
              <Led state={state} />
              {s.name}
            </h1>
            <p>
              <span className="mono">{WORD[state]}</span> · {helper.name} · {s.cpus} CPU ·{" "}
              {Math.round(s.memoryMib / 1024)} GB
            </p>
            {s.mount && <Folder path={s.mount} />}
          </div>
          {s.harness && state !== "agent-stopped" && (
            <Lever
              on={driving}
              disabled={!running}
              onToggle={() => (driving ? setHandBack(true) : onTakeover(true))}
            />
          )}
        </header>
        <section
          className={cn(
            "panel flex min-h-0 flex-1 flex-col gap-3.5",
            rewinding && "rewinding",
            full && "full-window",
          )}
        >
          {full ? (
            <Button
              className="exit-full"
              aria-label="Exit full window"
              title="Exit full window (⌘⇧F)"
              onClick={() => setFull(false)}
            >
              <Icon name="shrink" size={16} />
            </Button>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <fieldset className="dial" aria-label="What the screen shows">
                {modes.map(([id, label, icon]) => (
                  <Button key={id} aria-pressed={mode === id} onClick={() => setMode(id)}>
                    <Icon name={icon} size={16} />
                    {label}
                  </Button>
                ))}
              </fieldset>
              <Button title="Full window (⌘⇧F)" onClick={() => setFull(true)}>
                <Icon name="expand" size={16} />
                Full window
              </Button>
            </div>
          )}
          <Screen state={state} big>
            {mode === "screen" && (running ? <Desktop api={api} name={s.name} /> : off)}
            {mode === "terminal" &&
              (running ? (
                <div className="size-full p-2">
                  <Terminal api={api} name={s.name} />
                </div>
              ) : (
                off
              ))}
            {mode === "files" && (running ? <Files api={api} name={s.name} start="/workspace" /> : off)}
            {mode === "previews" && <Ports sandbox={s} onScreen={() => setMode("screen")} />}
          </Screen>
          <div className="status-strip" hidden={full}>
            <span className="mono dim">
              {driving
                ? "Your keyboard and mouse go to the box. The agent waits."
                : s.harness
                  ? `${WORD[state]} · ${helper.name}`
                  : "Your own computer in a box"}
            </span>
            <div className="lifecycle">
              {state === "agent-stopped" && (
                <Button variant="accent" onClick={() => actions.restartAgent(s.name)}>
                  <Icon name="restart" size={16} /> Start agent again
                </Button>
              )}
              <Tools box={{ sandbox: s, state }} actions={actions} className="lifecycle" />
            </div>
          </div>
        </section>
      </div>
      <SavePoints
        api={api}
        name={s.name}
        version={saves}
        onCopy={(snapshot, n) => actions.copyFrom(s, snapshot, n)}
        onRewind={(snapshot, n) => actions.rewind(s.name, snapshot, n)}
      />
      {handBack && (
        <HandBack
          helper={helper.short}
          onCancel={() => setHandBack(false)}
          onHandBack={(note) => {
            setHandBack(false);
            onTakeover(false, note);
          }}
        />
      )}
    </div>
  );
}

/** AGENT / YOU: YOU freezes the agent so you can drive. */
function Lever({ on, disabled, onToggle }: { on: boolean; disabled: boolean; onToggle(): void }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="You drive"
        className="lever"
        disabled={disabled}
        onClick={onToggle}
      >
        <span className="lv-label y" aria-hidden="true">
          YOU
        </span>
        <span className="lv-label a" aria-hidden="true">
          AGENT
        </span>
        <span className="lv-knob" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </button>
      <span className="mono dim">{on ? "You're driving · agent paused" : "Agent is driving"}</span>
    </div>
  );
}

function HandBack({
  helper,
  onCancel,
  onHandBack,
}: {
  helper: string;
  onCancel(): void;
  onHandBack(note: string): void;
}) {
  const [note, setNote] = useState("");
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <div className="sheet-wrap">
          <Dialog.Content asChild aria-describedby={undefined}>
            <form
              className="dialog"
              onSubmit={(e) => {
                e.preventDefault();
                onHandBack(note.trim());
              }}
            >
              <Dialog.Title asChild>
                <h2>Hand back to {helper}?</h2>
              </Dialog.Title>
              <p>
                Tell it what you changed, so it doesn't undo your work. It carries on from where it paused.
              </p>
              <textarea
                aria-label="Note for the agent"
                className="field"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional. For example: I renamed the menu file and fixed the opening hours myself"
              />
              <div className="row-end">
                <Button onClick={onCancel}>Keep driving</Button>
                <Button type="submit" variant="accent">
                  Hand back
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const join = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;

/** Hidden from the root: microsandbox's own files, not the sandbox's. */
const HIDDEN = ["/.msb"];

function Files({ api, name, start }: { api: Api; name: string; start: string }) {
  const [path, setPath] = useState(start);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [dragging, setDragging] = useState(false);
  const load = useCallback(
    () =>
      void api.listDir(name, path).then(
        (all) => setEntries(all.filter((e) => !HIDDEN.includes(join(path, basename(e.path))))),
        // A start folder that isn't there (no /workspace) falls back to the root.
        (error) => (path === start && start !== "/" ? setPath("/") : showError(error)),
      ),
    [api, name, path, start],
  );
  useEffect(load, [load]);
  // A link may lead to a folder (Debian's /bin → usr/bin): open it as one if it lists, else download it.
  const openLink = (target: string) =>
    void api.listDir(name, target).then(
      () => setPath(target),
      () => download(target),
    );

  const download = (file: string) =>
    void api.readFile(name, file).then((bytes) => {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
      link.download = basename(file);
      link.click();
      URL.revokeObjectURL(link.href);
    }, showError);
  const drop = async (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    for (const file of Array.from(event.dataTransfer.files)) {
      await api
        .writeFile(name, join(path, file.name), new Uint8Array(await file.arrayBuffer()))
        .catch(showError);
    }
    load();
  };

  return (
    <section
      aria-label="Files"
      className={cn(
        "absolute inset-0 flex flex-col gap-2 overflow-y-auto p-4 font-mono text-[13px]",
        dragging && "bg-[rgba(255,91,20,0.12)] shadow-[inset_0_0_0_2px_var(--accent)]",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          aria-label="Up"
          disabled={path === "/"}
          onClick={() => setPath(path.replace(/\/[^/]+\/?$/, "") || "/")}
        >
          ↑
        </Button>
        <code>{path}</code>
        <span className="ml-auto text-[var(--screen-dim)] text-xs">Drop files here to upload</span>
      </div>
      {entries.length === 0 && (
        <p className="px-2 py-1 text-[var(--screen-dim)]">
          This folder is empty. Drop files here to add some.
        </p>
      )}
      <ul>
        {entries.map((e) => (
          <li key={e.path}>
            <button
              type="button"
              className="w-full rounded px-2 py-1 text-left hover:bg-white/5"
              onClick={() => {
                const target = join(path, basename(e.path));
                if (e.dir) setPath(target);
                else if (e.link) openLink(target);
                else download(target);
              }}
            >
              {e.dir ? "📁" : e.link ? "🔗" : "📄"} {basename(e.path)}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Ports({ sandbox, onScreen }: { sandbox: Sandbox; onScreen(): void }) {
  const [port, setPort] = useState<number | null>(null);
  const desktop = (guest: number) => sandbox.template === "desktop" && DESKTOP_PORTS[guest];
  const own = sandbox.ports.filter((p) => !desktop(p.guest));
  if (port !== null)
    return (
      <div className="absolute inset-4 flex flex-col gap-3">
        <div className="flex items-center gap-2.5 font-mono text-[13px]">
          <Button size="sm" onClick={() => setPort(null)}>
            <Icon name="back" size={14} /> All previews
          </Button>
          <code>127.0.0.1:{port}</code>
        </div>
        <iframe
          title={`Port ${port}`}
          src={`http://127.0.0.1:${port}`}
          className="flex-1 rounded-lg bg-white"
        />
      </div>
    );
  return (
    <ul className="absolute inset-0 flex flex-col gap-2.5 overflow-y-auto p-4 font-mono text-[13px]">
      {own.length === 0 && (
        <li className="text-[var(--screen-dim)]">
          Nothing to preview yet. Share a web port under New box → More options, and it shows up here so you
          can try it.
        </li>
      )}
      {sandbox.ports.map((p) => (
        <li key={p.guest} className="flex items-center gap-3">
          <span className="text-[var(--screen-dim)]">port {p.guest} →</span>
          <code>127.0.0.1:{p.host}</code>
          {desktop(p.guest) ? (
            <>
              <span className="text-[var(--screen-dim)] text-xs">{desktop(p.guest)}</span>
              <Button size="sm" aria-label="Show the screen" onClick={onScreen}>
                Screen
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setPort(p.host)}>
              Open
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
