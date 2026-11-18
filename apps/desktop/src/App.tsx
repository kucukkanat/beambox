import { MotionConfig } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import type { AgentStatus, Api, CreateOpts, Harness, Sandbox, Status } from "./api.ts";
import { BoxView, type Mode } from "./BoxView.tsx";
import { boxState, needsYou } from "./box.ts";
import { HypervisorCard } from "./HypervisorCard.tsx";
import { showError, typing } from "./lib/utils.ts";
import { spring, useReducedMotion } from "./motion.ts";
import { NewBoxSheet } from "./NewBoxSheet.tsx";
import { type Pending, Shelf } from "./Shelf.tsx";
import { sound } from "./sound.ts";

export type Actions = {
  start(name: string): void;
  stop(name: string): void;
  fork(name: string): void;
  snapshot(name: string): void;
  remove(name: string): void;
  /** Start an agent box's harness again after it stopped. */
  restartAgent(name: string): void;
  open(name: string, mode?: Mode): void;
  dismissSignIn(name: string): void;
  /** Boot `<name>-copy-<n>` from save point number `n` of `source`. */
  copyFrom(source: Sandbox, snapshot: string, n: number): void;
  /** Recreate a box from its save point number `n`. */
  rewind(name: string, snapshot: string, n: number): void;
};

const UNDO_MS = 5000;

/** What each running agent box's harness is doing, checked every 3 s. */
function useAgents(api: Api, sandboxes: Sandbox[]) {
  const [agents, setAgents] = useState<Record<string, AgentStatus>>({});
  const watched = sandboxes
    .filter((s) => s.harness && s.status === "running")
    .map((s) => s.name)
    .join("\n");
  useEffect(() => {
    if (!watched) return;
    let current = true;
    const poll = () => {
      for (const name of watched.split("\n"))
        void api.agentStatus(name).then(
          (status) =>
            current && setAgents((all) => (all[name] === status ? all : { ...all, [name]: status })),
          () => {},
        );
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [api, watched]);
  const setAgent = useCallback(
    (name: string, status: AgentStatus) => setAgents((all) => ({ ...all, [name]: status })),
    [],
  );
  const forget = useCallback((name: string) => setAgents(({ [name]: _, ...rest }) => rest), []);
  return [agents, setAgent, forget] as const;
}

/** Type a line into the agent's tmux session, once tmux has attached (its first redraw). */
async function typeNote(api: Api, name: string, note: string) {
  let attached = () => {};
  const ready = new Promise<void>((resolve) => (attached = resolve));
  const id = await api.terminalOpen(name, () => attached());
  try {
    await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 2000))]);
    // One line: a newline would send the note in pieces.
    await api.terminalInput(id, `${note.replace(/\s*\n\s*/g, " ")}\r`);
  } finally {
    await api.terminalClose(id);
  }
}

export function App({ api }: { api: Api }) {
  const reduced = useReducedMotion();
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [deleting, setDeleting] = useState<string[]>([]);
  // Creates still booting: a card for each until its box shows up in the list.
  const [pending, setPending] = useState<Pending[]>([]);
  // Boxes made by this window without a usable key, until you open their terminal or dismiss them.
  const [signIn, setSignIn] = useState<string[]>([]);
  // Jobs of boxes made by this window: the backend doesn't keep them.
  const [tasks, setTasks] = useState<Record<string, string>>({});
  const [sheet, setSheet] = useState(false);
  // Bumped after each save point, so an open save point strip reloads.
  const [saves, setSaves] = useState(0);
  const [rewinding, setRewinding] = useState<string[]>([]);
  // `n` remounts the view, so a repeated `beambox desktop` request switches back to the Screen.
  const [opened, setOpened] = useState<{ name: string; mode: Mode | undefined; n: number } | null>(null);
  const [agents, setAgent, forgetAgent] = useAgents(api, sandboxes);
  const open = useCallback(
    (name: string, mode?: Mode) => setOpened((o) => ({ name, mode, n: (o?.n ?? 0) + 1 })),
    [],
  );

  // Polling also picks up boxes created from the command line.
  const refresh = useCallback(() => api.list().then(setSandboxes, () => {}), [api]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [refresh]);
  // `beambox desktop <name>` opens a box's screen, at launch or in the running window.
  useEffect(() => {
    void api.takeOpen().then(
      (name) => name && open(name, "screen"),
      () => {},
    );
    return api.onOpen((name) => open(name, "screen"));
  }, [api, open]);
  const viewing = !!opened && sandboxes.some((s) => s.name === opened.name);
  // N opens the New box sheet, unless you're typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing(event.target) || viewing || sheet) return;
      event.preventDefault();
      setSheet(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing, sheet]);

  const shown = sandboxes.filter((s) => !deleting.includes(s.name));
  const boxes = shown.map((s) => ({
    sandbox: s,
    state: boxState(s, agents[s.name], signIn.includes(s.name)),
  }));

  // A double beep when a box starts needing you.
  const waiting = boxes.filter((b) => needsYou(b.state)).map((b) => b.sandbox.name);
  const seen = useRef<string[]>([]);
  useEffect(() => {
    if (waiting.some((name) => !seen.current.includes(name))) sound.needsYou();
    seen.current = waiting;
  });

  const run = (call: Promise<unknown>) => void call.then(refresh, showError);
  const setStatus = (name: string, status: Status) =>
    setSandboxes((all) => all.map((s) => (s.name === name ? { ...s, status } : s)));
  const undelete = (name: string) => setDeleting((all) => all.filter((n) => n !== name));
  const dropSignIn = useCallback(
    (name: string) => setSignIn((all) => (all.includes(name) ? all.filter((n) => n !== name) : all)),
    [],
  );

  const create = (opts: CreateOpts) => {
    const call = api.create(opts);
    const id = Date.now() + Math.random();
    setPending((all) => [...all, { id, opts, preparing: false }]);
    // Until the base snapshot is built (the app builds it at startup), a create waits minutes for it.
    void api.baseReady().then(
      (ready) => !ready && setPending((all) => all.map((p) => (p.id === id ? { ...p, preparing: true } : p))),
      () => {},
    );
    void call
      .then(async (s) => {
        sound.ready();
        if (opts.task) setTasks((all) => ({ ...all, [s.name]: opts.task as string }));
        // Without a usable stored key the agent asks you to sign in, in its terminal.
        if (opts.harness && (await api.missingCredentials(opts.harness)).length > 0)
          setSignIn((all) => [...all, s.name]);
        toast.success(`${s.name} is ready`);
        await refresh();
      })
      .catch(showError)
      .finally(() => setPending((all) => all.filter((p) => p.id !== id)));
  };

  const actions: Actions = {
    open,
    dismissSignIn: dropSignIn,
    start: (name) => {
      sound.wake();
      setStatus(name, "booting");
      run(api.start(name));
    },
    stop: (name) => {
      sound.sleep();
      sound.shutter();
      setStatus(name, "stopped");
      run(api.stop(name));
    },
    fork: (name) => run(api.fork(name)),
    restartAgent: (name) => {
      void api.restartAgent(name).then(() => {
        setAgent(name, "running");
        toast.success(`Started the agent in ${name} again`);
      }, showError);
    },
    snapshot: (name) =>
      void api.snapshot(name).then((s) => {
        toast.success(`Made save point ${s}`);
        setSaves((n) => n + 1);
      }, showError),
    copyFrom: (source, snapshot, n) => {
      const id = Date.now() + Math.random();
      const opts: CreateOpts = {
        cpus: source.cpus,
        memoryMib: source.memoryMib,
        desktop: source.template === "desktop",
        ...(source.harness && { harness: source.harness as Harness }),
        ...(source.mount && { mount: source.mount }),
      };
      const note = `Copy of ${source.name} · from save point ${n}`;
      setPending((all) => [...all, { id, opts, preparing: false, note }]);
      // Back to the shelf, where the copy boots.
      setOpened(null);
      void api
        .copyFrom(snapshot)
        .then((s) => {
          sound.ready();
          toast.success(`${s.name} is ready`);
          return refresh();
        }, showError)
        .finally(() => setPending((all) => all.filter((p) => p.id !== id)));
    },
    rewind: (name, snapshot, n) => {
      sound.rewind();
      setRewinding((all) => [...all, name]);
      void api
        .rewind(name, snapshot)
        .then(() => {
          toast.success(`Rewound ${name} to save point ${n}`);
          // Same name, new VM: remount the view so its terminal and screen connect to it.
          setOpened((o) => (o?.name === name ? { ...o, n: o.n + 1 } : o));
          return refresh();
        }, showError)
        .finally(() => setRewinding((all) => all.filter((r) => r !== name)));
    },
    remove: (name) => {
      sound.trash();
      setDeleting((all) => [...all, name]);
      setOpened((o) => (o?.name === name ? null : o));
      const timer = setTimeout(
        () =>
          void api
            .delete(name)
            .then(() => {
              // Names come back after a delete (sandbox-1…): a new box mustn't inherit this one's state.
              dropSignIn(name);
              setTasks(({ [name]: _, ...rest }) => rest);
              forgetAgent(name);
              return refresh();
            }, showError)
            .finally(() => undelete(name)),
        UNDO_MS,
      );
      toast(`Threw away ${name}`, {
        duration: UNDO_MS,
        action: {
          label: "Undo",
          onClick: () => {
            clearTimeout(timer);
            undelete(name);
          },
        },
      });
    },
  };

  const takeover = async (name: string, on: boolean, note = "") => {
    sound.clunk();
    try {
      await api.setTakeover(name, on);
      setAgent(name, on ? "frozen" : "running");
      // Typed into the agent's own session once it runs again, so it knows what you changed.
      if (note) await typeNote(api, name, note);
    } catch (error) {
      showError(error);
    }
  };

  const box = opened && boxes.find((b) => b.sandbox.name === opened.name);
  return (
    <MotionConfig
      reducedMotion={reduced ? "always" : "never"}
      transition={reduced ? { duration: 0 } : spring}
    >
      <main className="mx-auto flex min-h-screen max-w-[1320px] flex-col gap-[22px] px-4 pt-5 pb-16">
        <HypervisorCard api={api} />
        {box ? (
          <BoxView
            key={opened.n}
            api={api}
            sandbox={box.sandbox}
            state={box.state}
            initialMode={opened.mode}
            actions={actions}
            saves={saves}
            rewinding={rewinding.includes(box.sandbox.name)}
            onTakeover={(on, note) => void takeover(box.sandbox.name, on, note)}
            onTerminal={() => dropSignIn(box.sandbox.name)}
            onBack={() => setOpened(null)}
          />
        ) : (
          <Shelf
            api={api}
            boxes={boxes}
            pending={pending}
            tasks={tasks}
            actions={actions}
            onNew={() => setSheet(true)}
          />
        )}
      </main>
      <NewBoxSheet api={api} open={sheet} onOpenChange={setSheet} onCreate={create} />
      <Toaster position="bottom-center" theme="system" />
    </MotionConfig>
  );
}
