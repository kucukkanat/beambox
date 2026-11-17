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
  const [openName, setOpenName] = useState<string | null>(null);
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

  const run = (call: Promise<unknown>) => void call.then(refresh, showError);
  const setStatus = (name: string, status: Status) =>
    setSandboxes((all) => all.map((s) => (s.name === name ? { ...s, status } : s)));
  const undelete = (name: string) => setDeleting((all) => all.filter((n) => n !== name));

  const actions: Actions = {
    create: (opts) => run(api.create(opts)),
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

  const open = sandboxes.find((s) => s.name === openName);
  return (
    <MotionConfig
      reducedMotion={reduced ? "always" : "never"}
      transition={reduced ? { duration: 0 } : spring}
    >
      <main className="flex h-screen flex-col gap-4 p-6">
        <HypervisorCard api={api} />
        {open ? (
          <SandboxView
            api={api}
            sandbox={open}
            activity={activity.filter((a) => a.sandbox === open.name)}
            onBack={() => setOpenName(null)}
          />
        ) : (
          <Home
            api={api}
            sandboxes={sandboxes.filter((s) => !deleting.includes(s.name))}
            actions={actions}
            onOpen={setOpenName}
          />
        )}
      </main>
      <Toaster position="bottom-right" theme="system" />
    </MotionConfig>
  );
}
