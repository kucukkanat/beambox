import { AnimatePresence, motion } from "motion/react";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Activity, Api, DirEntry, Sandbox } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Card } from "./components/ui/card.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { Desktop } from "./Desktop.tsx";
import { StatusDot } from "./Home.tsx";
import { cn } from "./lib/utils.ts";
import { useItemMotion } from "./motion.ts";
import { Terminal } from "./Terminal.tsx";

type Props = { api: Api; sandbox: Sandbox; activity: Activity[]; onBack(): void };
const showError = (error: unknown) => void toast.error(String(error));

export function SandboxView({ api, sandbox: s, activity, onBack }: Props) {
  const [tab, setTab] = useState("terminal");
  const [openPorts, setOpenPorts] = useState<number[]>([]);
  const [takenOver, setTakenOver] = useState(false);
  useEffect(() => void api.takeover(s.name).then(setTakenOver, () => {}), [api, s.name]);

  const toggleTakeover = () =>
    void api.setTakeover(s.name, !takenOver).then(() => setTakenOver(!takenOver), showError);
  const openPort = (host: number) => {
    setOpenPorts((all) => (all.includes(host) ? all : [...all, host]));
    setTab(`port-${host}`);
  };
  const running = s.status === "running";
  const needsRunning = <p className="p-4 text-muted-foreground text-sm">Start the sandbox to use this.</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Sandboxes
        </Button>
        <StatusDot status={s.status} />
        <h1 className="font-semibold text-xl">{s.name}</h1>
        <span className="mr-auto text-muted-foreground text-sm">{s.template}</span>
        <Button variant={takenOver ? "destructive" : "outline"} onClick={toggleTakeover}>
          {takenOver ? "Hand back" : "Take over"}
        </Button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_300px] gap-4">
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-col gap-2">
          <TabsList>
            <TabsTrigger value="terminal">Terminal</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="ports">Ports</TabsTrigger>
            {s.template === "desktop" && <TabsTrigger value="desktop">Desktop</TabsTrigger>}
            {openPorts.map((port) => (
              <TabsTrigger key={port} value={`port-${port}`}>
                :{port}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="terminal" className="overflow-hidden rounded-lg bg-black p-2">
            {running ? <Terminal api={api} name={s.name} /> : needsRunning}
          </TabsContent>
          <TabsContent value="files">
            {running ? <Files api={api} name={s.name} /> : needsRunning}
          </TabsContent>
          <TabsContent value="logs">
            <Logs api={api} name={s.name} />
          </TabsContent>
          <TabsContent value="ports">
            <Ports sandbox={s} onOpen={openPort} />
          </TabsContent>
          {s.template === "desktop" && (
            <TabsContent value="desktop" className="overflow-hidden rounded-lg">
              {running ? <Desktop api={api} name={s.name} /> : needsRunning}
            </TabsContent>
          )}
          {openPorts.map((port) => (
            <TabsContent key={port} value={`port-${port}`}>
              <iframe
                title={`Port ${port}`}
                src={`http://127.0.0.1:${port}`}
                className="size-full rounded-lg border border-border"
              />
            </TabsContent>
          ))}
        </Tabs>
        <ActivityFeed activity={activity} />
      </div>
    </div>
  );
}

function ActivityFeed({ activity }: { activity: Activity[] }) {
  const item = useItemMotion();
  return (
    <Card className="flex min-h-0 flex-col p-3">
      <h2 className="mb-2 font-medium text-sm">Agent activity</h2>
      {activity.length === 0 && (
        <p className="text-muted-foreground text-xs">Commands an agent runs here show up live.</p>
      )}
      <ol className="flex min-h-0 flex-col gap-1 overflow-y-auto font-mono text-xs">
        <AnimatePresence initial={false}>
          {activity.map((a) => (
            <motion.li key={a.id} {...item} className="rounded bg-muted px-2 py-1">
              <span className="text-muted-foreground">{a.agent} $</span> {a.command}
              {a.exitCode === null && <span className="text-muted-foreground"> (running…)</span>}
              {a.exitCode !== null && a.exitCode !== 0 && (
                <span className="text-destructive"> (exit {a.exitCode})</span>
              )}
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </Card>
  );
}

const join = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;
const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

function Files({ api, name }: { api: Api; name: string }) {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [dragging, setDragging] = useState(false);
  const load = useCallback(() => void api.listDir(name, path).then(setEntries, showError), [api, name, path]);
  useEffect(load, [load]);

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
    <Card
      className={cn("flex h-full flex-col gap-2 overflow-y-auto p-3 text-sm", dragging && "ring-2 ring-ring")}
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
          variant="ghost"
          disabled={path === "/"}
          onClick={() => setPath(path.replace(/\/[^/]+\/?$/, "") || "/")}
        >
          ↑
        </Button>
        <code>{path}</code>
        <span className="ml-auto text-muted-foreground text-xs">Drop files here to upload</span>
      </div>
      <ul>
        {entries.map((e) => (
          <li key={e.path}>
            <button
              type="button"
              className="w-full rounded px-2 py-1 text-left hover:bg-muted"
              onClick={() =>
                e.dir ? setPath(join(path, basename(e.path))) : download(join(path, basename(e.path)))
              }
            >
              {e.dir ? "📁" : "📄"} {basename(e.path)}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Logs({ api, name }: { api: Api; name: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const poll = () => void api.logs(name).then(setLines, () => {});
    poll();
    const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  }, [api, name]);
  useEffect(() => {
    if (lines.length) end.current?.scrollIntoView?.();
  }, [lines]);
  return (
    <Card className="h-full overflow-y-auto p-3">
      <pre className="whitespace-pre-wrap font-mono text-xs">{lines.join("")}</pre>
      <div ref={end} />
    </Card>
  );
}

function Ports({ sandbox, onOpen }: { sandbox: Sandbox; onOpen(host: number): void }) {
  if (sandbox.ports.length === 0)
    return (
      <p className="p-4 text-muted-foreground text-sm">No published ports. Add some under New sandbox ▾.</p>
    );
  return (
    <ul className="flex flex-col gap-2">
      {sandbox.ports.map((p) => (
        <li key={p.guest} className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">guest {p.guest} →</span>
          <code>127.0.0.1:{p.host}</code>
          <Button size="sm" variant="outline" onClick={() => onOpen(p.host)}>
            Open
          </Button>
        </li>
      ))}
    </ul>
  );
}
