import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { plainText } from "./ansi.ts";
import type { Api, DirEntry, Sandbox } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Card } from "./components/ui/card.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { Desktop } from "./Desktop.tsx";
import { StatusDot, useAgentStatus } from "./Home.tsx";
import { cn } from "./lib/utils.ts";
import { Terminal } from "./Terminal.tsx";

type Props = { api: Api; sandbox: Sandbox; initialTab?: string; onBack(): void; onRestartAgent?(): void };

/** Guest ports Beambox itself publishes for the desktop, said in words instead of offered as a web page. */
const DESKTOP_PORTS: Record<number, string> = { 5900: "Desktop (VNC): shown in the Desktop tab" };
const showError = (error: unknown) => void toast.error(String(error));

export function SandboxView({ api, sandbox: s, initialTab = "terminal", onBack, onRestartAgent }: Props) {
  const [tab, setTab] = useState(initialTab);
  const [openPorts, setOpenPorts] = useState<number[]>([]);
  const [takenOver, setTakenOver] = useState(false);
  const agent = s.harness !== null && s.status === "running";
  const agentStatus = useAgentStatus(api, s);
  useEffect(() => {
    if (agent) void api.takeover(s.name).then(setTakenOver, () => {});
  }, [api, s.name, agent]);

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
        <StatusDot status={s.status} agent={agentStatus} />
        <h1 className="font-semibold text-xl">{s.name}</h1>
        <span className="mr-auto text-muted-foreground text-sm">
          {s.harness ? `${s.harness} · ${s.template}` : s.template}
        </span>
        {/* Take over freezes the agent (SIGSTOP) so you can use the terminal and desktop; Hand back resumes it. */}
        {agent && agentStatus !== "exited" && (
          <Button variant={takenOver ? "destructive" : "outline"} onClick={toggleTakeover}>
            {takenOver ? "Hand back" : "Take over"}
          </Button>
        )}
      </header>
      {agentStatus === "exited" && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
        >
          <span className="mr-auto">
            {s.harness} has stopped, for example because its sign-in timed out. The terminal is a plain shell
            now.
          </span>
          <Button size="sm" onClick={onRestartAgent}>
            Restart agent
          </Button>
        </div>
      )}
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-2">
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
          {running ? <Files api={api} name={s.name} start="/workspace" /> : needsRunning}
        </TabsContent>
        <TabsContent value="logs">
          <Logs api={api} name={s.name} />
        </TabsContent>
        <TabsContent value="ports">
          <Ports sandbox={s} onOpen={openPort} onDesktop={() => setTab("desktop")} />
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
    </div>
  );
}

const join = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;
const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

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
      {entries.length === 0 && (
        <p className="px-2 py-1 text-muted-foreground">This folder is empty. Drop files here to add some.</p>
      )}
      <ul>
        {entries.map((e) => (
          <li key={e.path}>
            <button
              type="button"
              className="w-full rounded px-2 py-1 text-left hover:bg-muted"
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
      {/* The log is the terminal's raw output: shown as the text it drew, without its control codes. */}
      <pre className="whitespace-pre-wrap font-mono text-xs">{plainText(lines.join(""))}</pre>
      <div ref={end} />
    </Card>
  );
}

function Ports({
  sandbox,
  onOpen,
  onDesktop,
}: {
  sandbox: Sandbox;
  onOpen(host: number): void;
  onDesktop(): void;
}) {
  const desktop = (guest: number) => sandbox.template === "desktop" && DESKTOP_PORTS[guest];
  const own = sandbox.ports.filter((p) => !desktop(p.guest));
  return (
    <ul className="flex flex-col gap-2">
      {own.length === 0 && (
        <li className="py-2 text-muted-foreground text-sm">
          {sandbox.ports.length ? "No other published ports." : "No published ports."} Add some under New
          sandbox ▾.
        </li>
      )}
      {sandbox.ports.map((p) => (
        <li key={p.guest} className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">guest {p.guest} →</span>
          <code>127.0.0.1:{p.host}</code>
          {desktop(p.guest) ? (
            <>
              <span className="text-muted-foreground text-xs">{desktop(p.guest)}</span>
              <Button size="sm" variant="ghost" onClick={onDesktop}>
                Desktop tab
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => onOpen(p.host)}>
              Open
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
