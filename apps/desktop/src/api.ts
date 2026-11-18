import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

export type Status = "booting" | "running" | "stopped" | "crashed";
export type Port = { guest: number; host: number };
export type Sandbox = {
  name: string;
  template: string;
  status: Status;
  cpus: number;
  memoryMib: number;
  /** The agent harness running in it, for agent sandboxes. */
  harness: string | null;
  ports: Port[];
};
export type Harness = "claude-code" | "codex" | "opencode";
/** Everything left out gets the Rust core's default (base, 1 vCPU, 1 GiB, auto name, public network). */
export type CreateOpts = {
  name?: string;
  cpus?: number;
  memoryMib?: number;
  harness?: Harness;
  /** The harness's first prompt. */
  task?: string;
  desktop?: boolean;
  mount?: string;
  network?: string;
  ports?: number[];
};
/** `link`: a symbolic link, which may lead to a folder. */
export type DirEntry = { path: string; dir: boolean; link?: boolean };
/** What an agent sandbox's harness is doing. `exited` leaves its terminal at a plain shell. */
export type AgentStatus = "running" | "frozen" | "exited";
export type Metrics = { cpuPercent: number; memoryBytes: number };
export type HypervisorState = "ok" | "missing" | "unsupported";
export type Hypervisor = { state: HypervisorState; os: string };

/** Everything the UI needs from the Rust side. Tests pass a fake. */
export type Api = {
  list(): Promise<Sandbox[]>;
  create(opts: CreateOpts): Promise<Sandbox>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  fork(name: string): Promise<Sandbox>;
  snapshot(name: string): Promise<string>;
  delete(name: string): Promise<void>;
  listDir(name: string, path: string): Promise<DirEntry[]>;
  readFile(name: string, path: string): Promise<Uint8Array>;
  writeFile(name: string, path: string, data: Uint8Array): Promise<void>;
  logs(name: string): Promise<string[]>;
  metrics(name: string): Promise<Metrics>;
  /** Whether the agent is frozen (Take over). */
  takeover(name: string): Promise<boolean>;
  setTakeover(name: string, on: boolean): Promise<void>;
  agentStatus(name: string): Promise<AgentStatus>;
  /** Whether the base snapshot every sandbox boots from is built; until then a create waits minutes for it. */
  baseReady(): Promise<boolean>;
  /** Start the harness again (without its task), signing in again if it needs to. */
  restartAgent(name: string): Promise<void>;
  /** A folder on this computer picked in the system dialog, or null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** A folder (or file) dropped on the window, by its path on this computer. */
  onFolderDrop(handler: (path: string) => void): () => void;
  /** Names of the stored credentials (`anthropic`, `openai`), never their values. */
  credentials(): Promise<string[]>;
  /** Open a link (e.g. a harness's sign-in page) in the computer's default browser. */
  openUrl(url: string): Promise<void>;
  /** Keys `harness` could use when none it can use is stored yet, in order of preference; empty when ready. */
  missingCredentials(harness: Harness): Promise<string[]>;
  setCredential(name: string, value: string): Promise<void>;
  removeCredential(name: string): Promise<void>;
  hypervisor(): Promise<Hypervisor>;
  enableHypervisor(): Promise<void>;
  /** Put `beambox` on the PATH; resolves to what to tell the user. */
  installCli(): Promise<string>;
  /** The sandbox `beambox desktop` launched the window for, once. */
  takeOpen(): Promise<string | null>;
  /** `beambox desktop <name>` while the window is already open. */
  onOpen(handler: (name: string) => void): () => void;
  desktopPort(name: string): Promise<number>;
  /** Set the desktop's screen to one of Xvnc's sizes, such as 1920x1080. */
  desktopResize(name: string, width: number, height: number): Promise<void>;
  /** The agent's tmux session in agent sandboxes, a login shell otherwise. */
  terminalOpen(name: string, onData: (data: Uint8Array) => void): Promise<number>;
  terminalInput(id: number, data: string): Promise<void>;
  terminalResize(id: number, rows: number, cols: number): Promise<void>;
  terminalClose(id: number): Promise<void>;
};

export const tauriApi: Api = {
  list: () => invoke("list"),
  create: (opts) => invoke("create", { opts }),
  start: (name) => invoke("start", { name }),
  stop: (name) => invoke("stop", { name }),
  fork: (name) => invoke("fork", { name }),
  snapshot: (name) => invoke("snapshot", { name }),
  delete: (name) => invoke("delete", { name }),
  listDir: (name, path) => invoke("list_dir", { name, path }),
  // Files cross IPC as raw bytes; names travel URI-encoded in headers.
  readFile: async (name, path) => new Uint8Array(await invoke<ArrayBuffer>("read_file", { name, path })),
  writeFile: (name, path, data) =>
    invoke("write_file", data, {
      headers: { name: encodeURIComponent(name), path: encodeURIComponent(path) },
    }),
  logs: (name) => invoke("logs", { name }),
  metrics: (name) => invoke("metrics", { name }),
  takeover: (name) => invoke("takeover", { name }),
  setTakeover: (name, on) => invoke("set_takeover", { name, on }),
  agentStatus: (name) => invoke("agent_status", { name }),
  baseReady: () => invoke("base_ready"),
  restartAgent: (name) => invoke("restart_agent", { name }),
  pickFolder: async () => {
    const folder = await open({ directory: true, title: "Mount a folder at /workspace" });
    return typeof folder === "string" ? folder : null;
  },
  onFolderDrop: (handler) => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const path = event.payload.type === "drop" ? event.payload.paths[0] : undefined;
      if (path) handler(path);
    });
    return () => void unlisten.then((stop) => stop());
  },
  credentials: () => invoke("credentials_list"),
  openUrl: (url) => openUrl(url),
  missingCredentials: (harness) => invoke("credentials_missing", { harness }),
  setCredential: (name, value) => invoke("credentials_set", { name, value }),
  removeCredential: (name) => invoke("credentials_remove", { name }),
  hypervisor: () => invoke("hypervisor_status"),
  enableHypervisor: () => invoke("enable_hypervisor"),
  installCli: () => invoke("install_cli"),
  takeOpen: () => invoke("take_open"),
  onOpen: (handler) => {
    const unlisten = listen<string>("open", (event) => handler(event.payload));
    return () => void unlisten.then((stop) => stop());
  },
  desktopPort: (name) => invoke("desktop_port", { name }),
  desktopResize: (name, width, height) => invoke("desktop_resize", { name, width, height }),
  terminalOpen: (name, onData) => {
    const output = new Channel<number[]>();
    output.onmessage = (bytes) => onData(new Uint8Array(bytes));
    return invoke("terminal_open", { name, output });
  },
  terminalInput: (id, data) => invoke("terminal_input", { id, data }),
  terminalResize: (id, rows, cols) => invoke("terminal_resize", { id, rows, cols }),
  terminalClose: (id) => invoke("terminal_close", { id }),
};
