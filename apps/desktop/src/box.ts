import type { AgentStatus, CreateOpts, Harness, Sandbox } from "./api.ts";

/** What a box is doing, in the shelf's sort order: the first three need you. */
export const STATES = [
  "agent-stopped",
  "crashed",
  "sign-in",
  "booting",
  "working",
  "driving",
  "ready",
  "asleep",
] as const;
export type BoxState = (typeof STATES)[number];

export const WORD: Record<BoxState, string> = {
  "agent-stopped": "Agent stopped",
  crashed: "Crashed",
  "sign-in": "Sign in",
  booting: "Getting ready",
  working: "Working",
  driving: "You're driving",
  ready: "Ready for you",
  asleep: "Asleep",
};

/** The LED class (see index.css) for each state. */
export const LED: Record<BoxState, string> = {
  "agent-stopped": "led-amber",
  crashed: "led-red",
  "sign-in": "led-amber",
  booting: "led-booting",
  working: "led-working",
  driving: "led-driving",
  ready: "led-green",
  asleep: "led-off",
};

export const needsYou = (state: BoxState) => STATES.indexOf(state) < 3;

/** `agent` is the harness's status while the box runs; `signIn` whether it still waits for a sign-in. */
export function boxState(s: Sandbox, agent: AgentStatus | undefined, signIn: boolean): BoxState {
  if (s.status === "crashed") return "crashed";
  if (s.status === "stopped") return "asleep";
  if (s.status === "booting") return "booting";
  if (!s.harness) return "ready";
  if (agent === "exited") return "agent-stopped";
  if (signIn) return "sign-in";
  return agent === "frozen" ? "driving" : "working";
}

/** Who works in a box: its harness, or nobody ("none"). */
export type Helper = Harness | "none";
export const HELPERS: Record<Helper, { name: string; short: string; by: string; mark: string }> = {
  "claude-code": { name: "Claude Code", short: "Claude", by: "Anthropic · great at code", mark: "Cl" },
  codex: { name: "Codex CLI", short: "Codex", by: "OpenAI · great at code", mark: "Cx" },
  opencode: { name: "OpenCode", short: "OpenCode", by: "Open source · free models", mark: "Oc" },
  none: { name: "Just a computer", short: "Computer", by: "No agent. A clean computer for you", mark: "□" },
};
export const helperOf = (s: Sandbox): Helper => (s.harness as Harness | null) ?? "none";

export const SIZES = [
  { label: "Light", cpus: 1, gb: 1 },
  { label: "Standard", cpus: 2, gb: 2 },
  { label: "Roomy", cpus: 2, gb: 4 },
  { label: "Heavy", cpus: 4, gb: 8 },
] as const;
/** The smallest size with a screen: Chromium crawls on less. */
export const ROOMY = 2;

export const basename = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** The narrated boot of a new box: timed in the UI, only the end of the create is real. */
export function bootStages(opts: CreateOpts, preparing: boolean): { label: string; log: string }[] {
  const helper = opts.harness ? HELPERS[opts.harness].name : null;
  const stages = [
    preparing
      ? { label: "Preparing Beambox (first time only, a few minutes)", log: "build the base snapshot, once" }
      : { label: "Unpacking the box", log: "restore base snapshot" },
    { label: "Waking the computer", log: `vm up · ${opts.cpus ?? 1} CPU · ${opts.memoryMib ?? 1024} MiB` },
    opts.mount && { label: `Moving in ${basename(opts.mount)}`, log: `${opts.mount} → /workspace` },
    opts.desktop && { label: "Switching on the screen", log: "start the desktop" },
    helper && { label: `Getting ${helper} ready`, log: `start ${opts.harness} in tmux` },
    helper && { label: "Reading the job", log: (opts.task ?? "").slice(0, 60) },
  ];
  return stages.filter((s) => !!s);
}
