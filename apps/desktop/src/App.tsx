import { MotionConfig } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import type { Api, CreateOpts, Sandbox, Status } from "./api.ts";
import { Home, type Pending } from "./Home.tsx";
import { HypervisorCard } from "./HypervisorCard.tsx";
import { spring, useReducedMotion } from "./motion.ts";
import { SandboxView } from "./SandboxView.tsx";

export type Actions = {
  create(opts: CreateOpts): void;
  start(name: string): void;
  stop(name: string): void;
  fork(name: string): void;
  snapshot(name: string): void;
  remove(name: string): void;
  /** Start an agent sandbox's harness again after it stopped, and show its terminal. */
  restartAgent(name: string): void;
};

const UNDO_MS = 5000;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** A loading toast with a running clock, replaced by the outcome when `call` settles. */
function waitToast<T>(call: Promise<T>, loading: string, success: (value: T) => string, error: string) {
  const started = Date.now();
  const id = toast.loading(`${loading} · ${clock(0)}`);
  const tick = setInterval(() => {
    toast.loading(`${loading} · ${clock(Math.floor((Date.now() - started) / 1000))}`, { id });
  }, 1000);
  void call
    .then(
      (value) => void toast.success(success(value), { id }),
      () => void toast.error(error, { id }),
    )
    .finally(() => clearInterval(tick));
}
const showError = (error: unknown) => void toast.error(String(error));

export function App({ api }: { api: Api }) {
  const reduced = useReducedMotion();
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [deleting, setDeleting] = useState<string[]>([]);
  // Creates still booting: a card for each until its sandbox shows up in the list.
  const [pending, setPending] = useState<Pending[]>([]);
  // `n` remounts the view, so a repeated `beambox desktop` request switches back to the Desktop tab.
  const [opened, setOpened] = useState<{ name: string; tab: string; n: number } | null>(null);
  const openSandbox = useCallback(
    (name: string, tab = "terminal") => setOpened((o) => ({ name, tab, n: (o?.n ?? 0) + 1 })),
    [],
  );

  // Polling also picks up sandboxes created from the command line.
  const refresh = useCallback(() => api.list().then(setSandboxes, () => {}), [api]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [refresh]);
  // `beambox desktop <name>` opens a sandbox's desktop, at launch or in the running window.
  useEffect(() => {
    void api.takeOpen().then(
      (name) => name && openSandbox(name, "desktop"),
      () => {},
    );
    return api.onOpen((name) => openSandbox(name, "desktop"));
  }, [api, openSandbox]);

  const run = (call: Promise<unknown>) => void call.then(refresh, showError);
  const setStatus = (name: string, status: Status) =>
    setSandboxes((all) => all.map((s) => (s.name === name ? { ...s, status } : s)));
  const undelete = (name: string) => setDeleting((all) => all.filter((n) => n !== name));

  const actions: Actions = {
    create: (opts) => {
      const call = api.create(opts);
      const id = Date.now() + Math.random();
      const kind = [opts.harness, opts.desktop && "desktop"].filter(Boolean).join(" with a ") || "sandbox";
      setPending((all) => [...all, { id, label: opts.name ? `${opts.name} · ${kind}` : kind }]);
      void call.then(refresh, () => {}).finally(() => setPending((all) => all.filter((p) => p.id !== id)));
      // The first sandbox of each kind builds its snapshot; later ones boot from it in seconds. The toast counts
      // the seconds, so a first build of a minute or two doesn't look stuck.
      const harness = opts.harness;
      if (harness) {
        // Without a usable stored key the agent asks you to sign in, so show its terminal straight away.
        const signIn = call.then(async (s) => ({
          s,
          signIn: (await api.missingCredentials(harness)).length > 0,
        }));
        const what = opts.desktop ? `${harness} with a desktop` : harness;
        const first = opts.desktop ? "about 2 minutes" : "about a minute";
        waitToast(
          signIn,
          `Starting ${what}… the first one takes ${first}`,
          ({ s, signIn }) =>
            signIn ? `Sign in to ${harness} in ${s.name}'s terminal` : `${s.name} is ready`,
          `Couldn't start ${harness}`,
        );
        void signIn.then(
          ({ s, signIn }) => signIn && openSandbox(s.name, "terminal"),
          () => {},
        );
      } else if (opts.desktop)
        waitToast(
          call,
          "Starting the desktop… the first one takes about 2 minutes",
          (s) => `${s.name} is ready`,
          "Couldn't start the desktop",
        );
      // Such as: the desktop image couldn't be downloaded, so the desktop was built locally.
      void call.then(
        (s) => s.notice && toast.warning(s.notice),
        () => {},
      );
      run(call);
    },
    start: (name) => {
      setStatus(name, "booting");
      run(api.start(name));
    },
    stop: (name) => {
      setStatus(name, "stopped");
      run(api.stop(name));
    },
    fork: (name) => run(api.fork(name)),
    restartAgent: (name) => {
      void api.restartAgent(name).then(() => {
        toast.success(`Restarted the agent in ${name}`);
        openSandbox(name, "terminal");
      }, showError);
    },
    snapshot: (name) => void api.snapshot(name).then((s) => toast.success(`Saved snapshot ${s}`), showError),
    remove: (name) => {
      setDeleting((all) => [...all, name]);
      const timer = setTimeout(
        () =>
          void api
            .delete(name)
            .then(refresh, showError)
            .finally(() => undelete(name)),
        UNDO_MS,
      );
      toast(`Deleted ${name}`, {
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

  const open = sandboxes.find((s) => s.name === opened?.name);
  return (
    <MotionConfig
      reducedMotion={reduced ? "always" : "never"}
      transition={reduced ? { duration: 0 } : spring}
    >
      <main className="flex h-screen flex-col gap-4 p-6">
        <HypervisorCard api={api} />
        {open && opened ? (
          <SandboxView
            key={opened.n}
            initialTab={opened.tab}
            api={api}
            sandbox={open}
            onRestartAgent={() => actions.restartAgent(open.name)}
            onBack={() => setOpened(null)}
          />
        ) : (
          <Home
            api={api}
            sandboxes={sandboxes.filter((s) => !deleting.includes(s.name))}
            pending={pending}
            actions={actions}
            onOpen={openSandbox}
          />
        )}
      </main>
      <Toaster position="bottom-right" theme="system" />
    </MotionConfig>
  );
}
