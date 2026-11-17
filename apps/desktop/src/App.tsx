import { MotionConfig } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import type { Activity, Api, CreateOpts, Sandbox, Status } from "./api.ts";
import { Home } from "./Home.tsx";
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
};

const UNDO_MS = 5000;
const showError = (error: unknown) => void toast.error(String(error));

export function App({ api }: { api: Api }) {
  const reduced = useReducedMotion();
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [deleting, setDeleting] = useState<string[]>([]);
  // `n` remounts the view, so a repeated `beambox desktop` request switches back to the Desktop tab.
  const [opened, setOpened] = useState<{ name: string; tab: string; n: number } | null>(null);
  const openSandbox = useCallback(
    (name: string, tab = "terminal") => setOpened((o) => ({ name, tab, n: (o?.n ?? 0) + 1 })),
    [],
  );
  const [activity, setActivity] = useState<Activity[]>([]);

  // Polling also picks up sandboxes that agents create over MCP.
  const refresh = useCallback(() => api.list().then(setSandboxes, () => {}), [api]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [refresh]);
  // A finish event replaces its call's start event in place.
  useEffect(
    () =>
      api.onActivity((event) =>
        setActivity((all) =>
          all.some((a) => a.id === event.id)
            ? all.map((a) => (a.id === event.id ? event : a))
            : [...all.slice(-499), event],
        ),
      ),
    [api],
  );

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
      // The first Desktop sandbox builds the desktop snapshot (~10 s); later ones boot from it in ~1 s.
      if (opts.template === "desktop")
        toast.promise(call, {
          loading: "Starting the desktop… the first one takes about 10 seconds",
          success: (s) => `${s.name} is ready`,
          error: () => "Couldn't start the desktop",
        });
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
            activity={activity.filter((a) => a.sandbox === open.name)}
            onBack={() => setOpened(null)}
          />
        ) : (
          <Home
            api={api}
            sandboxes={sandboxes.filter((s) => !deleting.includes(s.name))}
            actions={actions}
            onOpen={openSandbox}
          />
        )}
      </main>
      <Toaster position="bottom-right" theme="system" />
    </MotionConfig>
  );
}
