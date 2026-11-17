import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Status = "booting" | "running" | "stopped" | "crashed";
export type Port = { guest: number; host: number };
export type Sandbox = {
  name: string;
  template: string;
  status: Status;
  cpus: number;
  memoryMib: number;
  agent: string | null;
  ports: Port[];
};
/** Everything left out gets the Rust core's default (base, 1 vCPU, 256 MiB, auto name, public network). */
export type CreateOpts = { template?: string; mount?: string; network?: string; ports?: number[] };
export type DirEntry = { path: string; dir: boolean };
export type Metrics = { cpuPercent: number; memoryBytes: number };
/** A call's start event (exitCode null) and finish event share an id. */
export type Activity = {
  id: string;
  sandbox: string;
  agent: string;
  command: string;
  exitCode: number | null;
};
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
  takeover(name: string): Promise<boolean>;
  setTakeover(name: string, on: boolean): Promise<void>;
  hypervisor(): Promise<Hypervisor>;
  enableHypervisor(): Promise<void>;
  mcpCommand(): Promise<string>;
  /** Put `beambox` on the PATH; resolves to what to tell the user. */
  installCli(): Promise<string>;
  /** The sandbox `beambox desktop` launched the window for, once. */
  takeOpen(): Promise<string | null>;
  /** `beambox desktop <name>` while the window is already open. */
  onOpen(handler: (name: string) => void): () => void;
  desktopPort(name: string): Promise<number>;
  terminalOpen(name: string, onData: (data: Uint8Array) => void): Promise<number>;
  terminalInput(id: number, data: string): Promise<void>;
  terminalResize(id: number, rows: number, cols: number): Promise<void>;
  terminalClose(id: number): Promise<void>;
  onActivity(handler: (event: Activity) => void): () => void;
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
  hypervisor: () => invoke("hypervisor_status"),
  enableHypervisor: () => invoke("enable_hypervisor"),
  mcpCommand: () => invoke("mcp_command"),
  installCli: () => invoke("install_cli"),
  takeOpen: () => invoke("take_open"),
  onOpen: (handler) => {
    const unlisten = listen<string>("open", (event) => handler(event.payload));
    return () => void unlisten.then((stop) => stop());
  },
  desktopPort: (name) => invoke("desktop_port", { name }),
  terminalOpen: (name, onData) => {
    const output = new Channel<number[]>();
    output.onmessage = (bytes) => onData(new Uint8Array(bytes));
    return invoke("terminal_open", { name, output });
  },
  terminalInput: (id, data) => invoke("terminal_input", { id, data }),
  terminalResize: (id, rows, cols) => invoke("terminal_resize", { id, rows, cols }),
  terminalClose: (id) => invoke("terminal_close", { id }),
  onActivity: (handler) => {
    const unlisten = listen<Activity>("activity", (event) => handler(event.payload));
    return () => void unlisten.then((stop) => stop());
  },
};
