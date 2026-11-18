import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import type { AgentStatus, Api, Hypervisor, Sandbox } from "./api.ts";

// xterm and noVNC need a real canvas; their wiring is covered by the Rust tests and the manual smoke test.
vi.mock("./Terminal.tsx", () => ({ Terminal: () => null }));
vi.mock("./Desktop.tsx", () => ({ Desktop: () => null }));

const sandbox = (over: Partial<Sandbox> = {}): Sandbox => ({
  name: "a",
  template: "base",
  status: "running",
  cpus: 1,
  memoryMib: 1024,
  harness: null,
  ports: [],
  mount: null,
  network: "public",
  ...over,
});

function fakeApi(
  sandboxes: Sandbox[] = [],
  agents: Record<string, AgentStatus> = {},
  hypervisor: Hypervisor = { state: "ok", os: "macos" },
): Api {
  return {
    list: vi.fn(async () => sandboxes),
    create: vi.fn(async () => sandbox({ name: "sandbox-1" })),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    fork: vi.fn(async () => sandbox({ name: "a-fork-1" })),
    snapshot: vi.fn(async () => "a-1"),
    savePoints: vi.fn(async () => []),
    copyFrom: vi.fn(async () => sandbox({ name: "a-copy-1" })),
    rewind: vi.fn(async () => sandbox()),
    removeSavePoint: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    listDir: vi.fn(async () => []),
    readFile: vi.fn(async () => new Uint8Array()),
    writeFile: vi.fn(async () => {}),
    logs: vi.fn(async () => []),
    metrics: vi.fn(async () => ({ cpuPercent: 0, memoryBytes: 0 })),
    takeover: vi.fn(async () => false),
    setTakeover: vi.fn(async () => {}),
    agentStatus: vi.fn(async (name: string) => agents[name] ?? "running"),
    baseReady: vi.fn(async () => true),
    restartAgent: vi.fn(async () => {}),
    pickFolder: vi.fn(async () => "/Users/me/project"),
    onFolderDrop: vi.fn(() => () => {}),
    credentials: vi.fn(async () => ["openai"]),
    setCredential: vi.fn(async () => {}),
    removeCredential: vi.fn(async () => {}),
    missingCredentials: vi.fn(async () => []),
    openUrl: vi.fn(async () => {}),
    hypervisor: vi.fn(async () => hypervisor),
    enableHypervisor: vi.fn(async () => {}),
    installCli: vi.fn(async () => "Installed. Run `beambox --help` in a terminal."),
    takeOpen: vi.fn(async () => null),
    onOpen: vi.fn(() => () => {}),
    desktopPort: vi.fn(async () => 6080),
    desktopResize: vi.fn(async () => {}),
    terminalOpen: vi.fn(async () => 1),
    terminalInput: vi.fn(async () => {}),
    terminalResize: vi.fn(async () => {}),
    terminalClose: vi.fn(async () => {}),
  };
}

function prefersReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion: reduce"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

// Reduced motion: cards come and go at once instead of after animations jsdom can't run.
beforeEach(() => {
  prefersReducedMotion(true);
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

const shelf = () => screen.getByRole("region", { name: "Shelf" });
const tray = () => screen.queryByRole("region", { name: "Waiting for you" });
const card = (name: string) => screen.findByRole("article", { name });

async function openSheet(user = userEvent.setup()) {
  await user.click(await screen.findByRole("button", { name: "New box" }));
  return screen.findByRole("dialog", { name: "New box" });
}

describe("shelf", () => {
  it("sorts boxes by state, each with its state word", async () => {
    const api = fakeApi(
      [
        sandbox({ name: "asleep", status: "stopped" }),
        sandbox({ name: "ready" }),
        sandbox({ name: "driving", harness: "codex" }),
        sandbox({ name: "working", harness: "codex" }),
        sandbox({ name: "booting", status: "booting" }),
        sandbox({ name: "signin", harness: "claude-code" }),
        sandbox({ name: "crashed", status: "crashed" }),
        sandbox({ name: "stopped", harness: "codex" }),
      ],
      { driving: "frozen", stopped: "exited" },
    );
    // "signin" is made by this window without a stored key.
    api.create = vi.fn(async () => sandbox({ name: "signin", harness: "claude-code" }));
    api.missingCredentials = vi.fn(async () => ["anthropic"]);
    render(<App api={api} />);
    const sheet = await openSheet();
    await userEvent.type(within(sheet).getByRole("textbox", { name: "The job" }), "fix it");
    await userEvent.click(within(sheet).getByRole("button", { name: /Build the box/ }));
    const expected = [
      ["stopped", "Agent stopped"],
      ["crashed", "Crashed"],
      ["signin", "Sign in"],
      ["booting", "Getting ready"],
      ["working", "Working"],
      ["driving", "You're driving"],
      ["ready", "Ready for you"],
      ["asleep", "Asleep"],
    ];
    await waitFor(() =>
      expect(
        within(shelf())
          .getAllByRole("article")
          .map((a) => a.getAttribute("aria-label")),
      ).toEqual(expected.map(([name]) => name)),
    );
    for (const [name, word] of expected) {
      expect(within(await card(name as string)).getByText(word as string)).toBeInTheDocument();
    }
  });

  it("restarts a stopped agent from the tray", async () => {
    const api = fakeApi([sandbox({ harness: "codex" })], { a: "exited" });
    render(<App api={api} />);
    const waiting = await screen.findByRole("region", { name: "Waiting for you" });
    await userEvent.click(await within(waiting).findByRole("button", { name: "Start agent again" }));
    expect(api.restartAgent).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("wakes a crashed box from the tray", async () => {
    const api = fakeApi([sandbox({ status: "crashed" })]);
    render(<App api={api} />);
    const waiting = await screen.findByRole("region", { name: "Waiting for you" });
    await userEvent.click(within(waiting).getByRole("button", { name: "Wake" }));
    expect(api.start).toHaveBeenCalledExactlyOnceWith("a");
  });

  async function signInBox() {
    const api = fakeApi([sandbox({ name: "sandbox-1", harness: "claude-code" })]);
    api.create = vi.fn(async () => sandbox({ name: "sandbox-1", harness: "claude-code" }));
    api.missingCredentials = vi.fn(async () => ["anthropic"]);
    render(<App api={api} />);
    const sheet = await openSheet();
    await userEvent.type(within(sheet).getByRole("textbox", { name: "The job" }), "fix it");
    await userEvent.click(within(sheet).getByRole("button", { name: /Build the box/ }));
    return screen.findByRole("region", { name: "Waiting for you" });
  }

  it("drops a sign-in item once its terminal opens", async () => {
    const waiting = await signInBox();
    await userEvent.click(within(waiting).getByRole("button", { name: "Open terminal" }));
    expect(await screen.findByRole("button", { name: "Terminal", pressed: true })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await screen.findByRole("region", { name: "Shelf" });
    expect(tray()).not.toBeInTheDocument();
  });

  it("drops a sign-in item on ✕", async () => {
    const waiting = await signInBox();
    await userEvent.click(within(waiting).getByRole("button", { name: "Dismiss" }));
    expect(tray()).not.toBeInTheDocument();
  });

  it("has no tray when nothing needs you", async () => {
    render(<App api={fakeApi([sandbox(), sandbox({ name: "b", harness: "codex" })])} />);
    await card("b");
    await act(() => Promise.resolve());
    expect(tray()).not.toBeInTheDocument();
  });

  it("shows the last lines of the logs as plain text on the box's screen", async () => {
    const api = fakeApi([sandbox()]);
    api.logs = vi.fn(async () => ["\x1b[34mhello\x1b[m\x1b[K\r\n", "world\n"]);
    render(<App api={api} />);
    const box = await card("a");
    await waitFor(() => expect(box.querySelector("pre")?.textContent).toBe("hello\nworld"));
  });

  it("Sleep calls stop, Wake calls start, and an asleep box shows its shutter", async () => {
    const api = fakeApi([sandbox(), sandbox({ name: "b", status: "stopped" })]);
    render(<App api={api} />);
    const b = await card("b");
    expect(within(b).getByLabelText("Asleep")).toBeInTheDocument();
    await userEvent.click(within(b).getByRole("button", { name: "Wake" }));
    expect(api.start).toHaveBeenCalledExactlyOnceWith("b");
    await userEvent.click(within(await card("a")).getByRole("button", { name: "Sleep" }));
    expect(api.stop).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("forks with Try another way and makes a save point", async () => {
    const api = fakeApi([sandbox()]);
    render(<App api={api} />);
    const a = await card("a");
    await userEvent.click(within(a).getByRole("button", { name: "Try another way" }));
    expect(api.fork).toHaveBeenCalledExactlyOnceWith("a");
    await userEvent.click(within(a).getByRole("button", { name: "Save point" }));
    expect(await screen.findByText("Made save point a-1")).toBeInTheDocument();
  });

  it("has no animations with reduced motion", async () => {
    render(<App api={fakeApi([sandbox({ status: "booting" })])} />);
    const box = await card("a");
    expect(box.style.opacity).toBe("");
    expect(box.style.transform).toBe("");
  });
});

describe("header", () => {
  it("counts boxes, working boxes and boxes waiting for you", async () => {
    render(
      <App
        api={fakeApi([
          sandbox(),
          sandbox({ name: "w", harness: "codex" }),
          sandbox({ name: "c", status: "crashed" }),
        ])}
      />,
    );
    expect(
      await screen.findByRole("status", { name: "3 boxes, 1 working, 1 waiting for you" }),
    ).toBeInTheDocument();
  });

  it("toggles sound and keeps the choice", async () => {
    // No AudioContext in jsdom: rendering and pressing keys must not throw.
    expect(window.AudioContext).toBeUndefined();
    const { unmount } = render(<App api={fakeApi()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn sounds off" }));
    expect(localStorage.getItem("beambox.muted")).toBe("1");
    expect(screen.getByRole("button", { name: "Turn sounds on" })).toHaveAttribute("aria-pressed", "true");
    unmount();
    render(<App api={fakeApi()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn sounds on" }));
    expect(localStorage.getItem("beambox.muted")).toBe("0");
  });

  it("installs the beambox command from the ⋯ menu", async () => {
    const api = fakeApi();
    render(<App api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("button", { name: "Install the beambox command" }));
    expect(api.installCli).toHaveBeenCalledOnce();
    expect(await screen.findByText(/beambox --help/, { selector: "[data-title]" })).toBeInTheDocument();
  });

  it("lists the licences in the ⋯ menu", async () => {
    render(<App api={fakeApi()} />);
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("button", { name: "Licences" }));
    expect(await screen.findByText(/LGPL-2.1/)).toBeInTheDocument();
  });

  it("stores and removes credentials under ⋯ → Settings, showing names only", async () => {
    const api = fakeApi();
    render(<App api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const openai = (await screen.findByText("OpenAI key")).parentElement as HTMLElement;
    expect(await within(openai).findByText("Stored")).toBeInTheDocument();
    const anthropic = screen.getByText("Anthropic key").parentElement as HTMLElement;
    expect(within(anthropic).getByText("Not set")).toBeInTheDocument();
    const key = screen.getByLabelText("anthropic key or token");
    expect(key).toHaveAttribute("type", "password");
    await userEvent.type(key, "sk-ant-api03-x");
    // Typing N in a field doesn't open the New box sheet.
    await userEvent.type(key, "n");
    expect(screen.queryByRole("dialog", { name: "New box" })).not.toBeInTheDocument();
    await userEvent.clear(key);
    await userEvent.type(key, "sk-ant-api03-x");
    await userEvent.click(screen.getByRole("button", { name: "Save anthropic" }));
    expect(api.setCredential).toHaveBeenCalledWith("anthropic", "sk-ant-api03-x");
    expect(key).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "Remove openai" }));
    expect(api.removeCredential).toHaveBeenCalledWith("openai");
  });
});

describe("new box sheet", () => {
  it("sends every option to create, mapped from the sheet", async () => {
    const api = fakeApi();
    render(<App api={api} />);
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("radio", { name: /Codex CLI/ }));
    await userEvent.type(within(sheet).getByRole("textbox", { name: "The job" }), "fix it");
    await userEvent.click(within(sheet).getByRole("button", { name: /choose a folder/ }));
    expect(await within(sheet).findByText("/Users/me/project")).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("switch", { name: "A screen" }));
    fireEvent.change(within(sheet).getByRole("slider", { name: "How big" }), { target: { value: "3" } });
    await userEvent.click(within(sheet).getByRole("button", { name: "Offline" }));
    await userEvent.click(within(sheet).getByText("More options"));
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Name" }), "web");
    await userEvent.type(within(sheet).getByRole("textbox", { name: /Web ports/ }), "3000, 8080");
    await userEvent.click(within(sheet).getByRole("button", { name: /Build the box/ }));
    expect(api.create).toHaveBeenCalledExactlyOnceWith({
      harness: "codex",
      task: "fix it",
      mount: "/Users/me/project",
      desktop: true,
      cpus: 4,
      memoryMib: 8192,
      network: "none",
      name: "web",
      ports: [3000, 8080],
    });
  });

  it("takes a folder dropped on the window", async () => {
    const api = fakeApi();
    let drop = (_: string) => {};
    api.onFolderDrop = (handler) => {
      drop = handler;
      return () => {};
    };
    render(<App api={api} />);
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("radio", { name: /Just a computer/ }));
    act(() => drop("/Users/me/photos"));
    await userEvent.click(within(sheet).getByRole("button", { name: /Build the box/ }));
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ mount: "/Users/me/photos" }));
  });

  it("sizes the box for who works in it and for the screen", async () => {
    const api = fakeApi();
    render(<App api={api} />);
    const sheet = await openSheet();
    const size = within(sheet).getByRole("slider", { name: "How big" });
    const build = within(sheet).getByRole("button", { name: /Build the box/ });
    // An agent gets Standard, and needs a job.
    expect(size).toHaveValue("1");
    expect(build).toBeDisabled();
    await userEvent.click(within(sheet).getByRole("radio", { name: /Just a computer/ }));
    expect(size).toHaveValue("0");
    expect(within(sheet).queryByRole("textbox", { name: "The job" })).not.toBeInTheDocument();
    expect(build).toBeEnabled();
    // A screen needs at least Roomy.
    await userEvent.click(within(sheet).getByRole("switch", { name: "A screen" }));
    expect(size).toHaveValue("2");
    fireEvent.change(size, { target: { value: "0" } });
    expect(size).toHaveValue("2");
    await userEvent.click(build);
    expect(api.create).toHaveBeenCalledExactlyOnceWith({
      desktop: true,
      cpus: 2,
      memoryMib: 4096,
      network: "public",
    });
  });

  it("opens on N, closes on Esc and builds on ⌘↵", async () => {
    const api = fakeApi();
    render(<App api={api} />);
    await screen.findByRole("button", { name: "New box" });
    await userEvent.keyboard("n");
    const sheet = await screen.findByRole("dialog", { name: "New box" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(sheet).not.toBeInTheDocument());
    await userEvent.keyboard("n");
    const again = await screen.findByRole("dialog", { name: "New box" });
    await userEvent.type(within(again).getByRole("textbox", { name: "The job" }), "sort my photos");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(api.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ harness: "claude-code", task: "sort my photos" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New box" })).not.toBeInTheDocument());
  });

  it("offers a missing key, stores it, then creates", async () => {
    const api = fakeApi();
    api.missingCredentials = vi.fn(async () => ["anthropic", "openai"]);
    render(<App api={api} />);
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("radio", { name: /OpenCode/ }));
    expect(within(sheet).getByRole("radio", { name: /OpenCode/ })).toHaveTextContent("Sign in once");
    await userEvent.type(within(sheet).getByRole("textbox", { name: "The job" }), "fix it");
    await userEvent.click(within(sheet).getByText("More options"));
    await userEvent.selectOptions(within(sheet).getByRole("combobox", { name: "Key provider" }), "openai");
    await userEvent.type(within(sheet).getByLabelText("OpenAI key"), "sk-proj-x");
    await userEvent.click(within(sheet).getByRole("button", { name: /Build the box/ }));
    expect(api.setCredential).toHaveBeenCalledExactlyOnceWith("openai", "sk-proj-x");
    const stored = vi.mocked(api.setCredential).mock.invocationCallOrder[0] ?? 0;
    expect(stored).toBeLessThan(vi.mocked(api.create).mock.invocationCallOrder[0] ?? 0);
  });

  it("says Signed in when the helper has a key, and doesn't create when storing a key fails", async () => {
    const api = fakeApi();
    api.missingCredentials = vi.fn(async (h: string) => (h === "codex" ? [] : ["anthropic"]));
    api.setCredential = vi.fn(async () => {
      throw new Error("keychain locked");
    });
    render(<App api={api} />);
    const sheet = await openSheet();
    await waitFor(() =>
      expect(within(sheet).getByRole("radio", { name: /Codex CLI/ })).toHaveTextContent("Signed in"),
    );
    await userEvent.type(within(sheet).getByRole("textbox", { name: "The job" }), "fix it");
    await userEvent.click(within(sheet).getByText("More options"));
    await userEvent.type(within(sheet).getByLabelText("Anthropic key"), "sk-ant-x");
    await userEvent.click(within(sheet).getByRole("button", { name: /Build the box/ }));
    expect(await screen.findByText(/keychain locked/)).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  });
});

describe("narrated boot", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));

  async function build(api: Api) {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let finish = (_: Sandbox) => {};
    api.create = vi.fn(() => new Promise<Sandbox>((resolve) => (finish = resolve)));
    render(<App api={api} />);
    const sheet = await openSheet(user);
    await user.type(within(sheet).getByRole("textbox", { name: "The job" }), "fix the tests");
    await user.click(within(sheet).getByRole("button", { name: /choose a folder/ }));
    await within(sheet).findByText("/Users/me/project");
    await user.click(within(sheet).getByRole("switch", { name: "A screen" }));
    await user.click(within(sheet).getByRole("button", { name: /Build the box/ }));
    return { box: await card("New box, getting ready"), finish: (s: Sandbox) => finish(s) };
  }

  it("names the stages for the box's options, holding the last until the create settles", async () => {
    const api = fakeApi();
    const { box, finish } = await build(api);
    for (const stage of [
      "Unpacking the box",
      "Waking the computer",
      "Moving in project",
      "Switching on the screen",
      "Getting Claude Code ready",
      "Reading the job",
    ]) {
      expect(within(box).getByText(`${stage}…`)).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(1200));
    }
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(within(box).getByText("Reading the job…")).toBeInTheDocument();
    await act(async () => finish(sandbox({ name: "sandbox-1", harness: "claude-code" })));
    await waitFor(() => expect(box).not.toBeInTheDocument());
  });

  it("says Beambox is preparing while the base snapshot isn't built", async () => {
    const api = fakeApi();
    api.baseReady = vi.fn(async () => false);
    const { box } = await build(api);
    expect(
      await within(box).findByText("Preparing Beambox (first time only, a few minutes)…"),
    ).toBeInTheDocument();
  });
});

describe("throw away", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const holdKey = async (name: string) =>
    within(await card(name)).getByRole("button", { name: "Throw away: press and hold" });

  it("fires nothing when released early, and the undo toast cancels a full hold", async () => {
    const api = fakeApi([sandbox()]);
    render(<App api={api} />);
    const key = await holdKey("a");
    fireEvent.pointerDown(key);
    await act(() => vi.advanceTimersByTimeAsync(600));
    fireEvent.pointerUp(key);
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(screen.queryByText("Threw away a")).not.toBeInTheDocument();
    expect(api.delete).not.toHaveBeenCalled();
    // Held from the keyboard this time.
    fireEvent.keyDown(key, { key: " " });
    await act(() => vi.advanceTimersByTimeAsync(1200));
    fireEvent.keyUp(key, { key: " " });
    expect(await screen.findByText("Threw away a")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "a" })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(4000));
    await user().click(await screen.findByRole("button", { name: "Undo" }));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(api.delete).not.toHaveBeenCalled();
    expect(await card("a")).toBeInTheDocument();
  });

  it("deletes 5 s after a full hold without undo", async () => {
    // A different name: sonner's toast store outlives each render.
    const api = fakeApi([sandbox({ name: "b" })]);
    render(<App api={api} />);
    const key = await holdKey("b");
    fireEvent.pointerDown(key);
    await act(() => vi.advanceTimersByTimeAsync(1200));
    fireEvent.pointerUp(key);
    expect(await screen.findByText("Threw away b")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(4900));
    expect(api.delete).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(api.delete).toHaveBeenCalledExactlyOnceWith("b");
  });
});

describe("box view", () => {
  async function open(api: Api, name = "a") {
    render(<App api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: `Open ${name}` }));
    return screen.findByRole("heading", { name });
  }
  const mode = (name: string) => screen.queryByRole("button", { name, pressed: true });

  it("offers Screen only for boxes with a screen, and goes back on Esc", async () => {
    await open(fakeApi([sandbox({ template: "base" })]));
    expect(mode("Terminal")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Screen" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByRole("region", { name: "Shelf" })).toBeInTheDocument();
  });

  it("opens a box with a screen on its Screen", async () => {
    await open(fakeApi([sandbox({ template: "desktop", ports: [{ guest: 5900, host: 5901 }] })]));
    expect(mode("Screen")).toBeInTheDocument();
  });

  it("flips the lever to take over, and hands back with a note typed to the agent", async () => {
    const api = fakeApi([sandbox({ harness: "claude-code" })]);
    // tmux attaches and redraws before the note is typed.
    api.terminalOpen = vi.fn(async (_name: string, onData: (data: Uint8Array) => void) => {
      setTimeout(() => onData(new Uint8Array([27])));
      return 1;
    });
    await open(api);
    const lever = screen.getByRole("switch", { name: "You drive" });
    await userEvent.click(lever);
    expect(api.setTakeover).toHaveBeenCalledExactlyOnceWith("a", true);
    expect(lever).toHaveAttribute("aria-checked", "true");
    await userEvent.click(lever);
    const dialog = await screen.findByRole("dialog", { name: "Hand back to Claude?" });
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Note for the agent" }),
      "I fixed it{Enter}and the menu",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Hand back" }));
    await waitFor(() => expect(api.terminalClose).toHaveBeenCalledWith(1));
    expect(api.setTakeover).toHaveBeenLastCalledWith("a", false);
    expect(api.terminalInput).toHaveBeenCalledExactlyOnceWith(1, "I fixed it and the menu\r");
    // The agent reads the note once it runs again (see Decisions in specs/shelf-ui.md).
    const handedBack = vi.mocked(api.setTakeover).mock.invocationCallOrder[1] ?? 0;
    expect(handedBack).toBeLessThan(vi.mocked(api.terminalInput).mock.invocationCallOrder[0] ?? 0);
  });

  it("closes the hand-back dialog on Esc without leaving the box", async () => {
    const api = fakeApi([sandbox({ harness: "codex" })], { a: "frozen" });
    await open(api);
    const lever = screen.getByRole("switch", { name: "You drive" });
    await waitFor(() => expect(lever).toHaveAttribute("aria-checked", "true"));
    await userEvent.click(lever);
    await screen.findByRole("dialog", { name: "Hand back to Codex?" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "a" })).toBeInTheDocument();
    expect(api.setTakeover).not.toHaveBeenCalled();
  });

  it("hands back without a note by only resuming the agent", async () => {
    const api = fakeApi([sandbox({ harness: "codex" })], { a: "frozen" });
    await open(api);
    const lever = screen.getByRole("switch", { name: "You drive" });
    await waitFor(() => expect(lever).toHaveAttribute("aria-checked", "true"));
    await userEvent.click(lever);
    const dialog = await screen.findByRole("dialog", { name: "Hand back to Codex?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Hand back" }));
    await waitFor(() => expect(api.setTakeover).toHaveBeenCalledExactlyOnceWith("a", false));
    expect(api.terminalOpen).not.toHaveBeenCalled();
    expect(api.terminalInput).not.toHaveBeenCalled();
  });

  it("offers Start agent again instead of the lever when the agent has stopped", async () => {
    const api = fakeApi([sandbox({ harness: "codex" })], { a: "exited" });
    await open(api);
    const restart = await screen.findByRole("button", { name: "Start agent again" });
    expect(screen.queryByRole("switch", { name: "You drive" })).not.toBeInTheDocument();
    await userEvent.click(restart);
    expect(api.restartAgent).toHaveBeenCalledWith("a");
  });

  it("has no lever for a box without an agent", async () => {
    await open(fakeApi([sandbox()]));
    expect(screen.queryByRole("switch", { name: "You drive" })).not.toBeInTheDocument();
  });

  it("lists the box's web previews with their real host ports", async () => {
    await open(fakeApi([sandbox({ ports: [{ guest: 8080, host: 8081 }] })]));
    await userEvent.click(screen.getByRole("button", { name: "Web previews" }));
    expect(screen.getByText("127.0.0.1:8081")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByTitle("Port 8081")).toHaveAttribute("src", "http://127.0.0.1:8081");
  });

  it("says the VNC port is the screen instead of offering it as a page", async () => {
    await open(fakeApi([sandbox({ template: "desktop", ports: [{ guest: 5900, host: 5901 }] })]));
    await userEvent.click(screen.getByRole("button", { name: "Web previews" }));
    expect(screen.getByText(/Desktop \(VNC\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show the screen" }));
    expect(mode("Screen")).toBeInTheDocument();
  });

  it("opens Files at /workspace, falls back to the root, and hides microsandbox's own folder", async () => {
    const api = fakeApi([sandbox()]);
    api.listDir = vi.fn(async (_name: string, path: string) => {
      if (path === "/workspace") throw new Error("not found");
      return [
        { path: "/etc", dir: true },
        { path: "/bin", dir: false, link: true },
        { path: "/.msb", dir: true },
      ];
    });
    await open(api);
    await userEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(await screen.findByText(/etc/)).toBeInTheDocument();
    expect(api.listDir).toHaveBeenCalledWith("a", "/workspace");
    expect(screen.queryByText(/\.msb/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "🔗 bin" }));
    expect(api.listDir).toHaveBeenLastCalledWith("a", "/bin");
  });

  it("uploads dropped files and downloads a clicked one", async () => {
    const api = fakeApi([sandbox()]);
    api.listDir = vi.fn(async () => [{ path: "/workspace/notes.txt", dir: false }]);
    api.readFile = vi.fn(async () => new Uint8Array([104, 105]));
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await open(api);
    await userEvent.click(screen.getByRole("button", { name: "Files" }));
    const file = new File(["hi"], "up.txt");
    fireEvent.drop(await screen.findByText(/Drop files here to upload/), { dataTransfer: { files: [file] } });
    await waitFor(() =>
      expect(api.writeFile).toHaveBeenCalledWith("a", "/workspace/up.txt", expect.any(Uint8Array)),
    );
    await userEvent.click(screen.getByRole("button", { name: "📄 notes.txt" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(api.readFile).toHaveBeenCalledWith("a", "/workspace/notes.txt");
    click.mockRestore();
  });
});

describe("command line", () => {
  const desktop = sandbox({ name: "d", template: "desktop", ports: [{ guest: 5900, host: 5900 }] });

  it("opens the Screen of the box `beambox desktop` launched the window for", async () => {
    const api = fakeApi([desktop]);
    api.takeOpen = vi.fn(async () => "d");
    render(<App api={api} />);
    expect(await screen.findByRole("button", { name: "Screen", pressed: true })).toBeInTheDocument();
  });

  it("switches to a box's screen when asked while the window is open", async () => {
    const api = fakeApi([sandbox(), desktop]);
    let open = (_: string) => {};
    api.onOpen = (handler) => {
      open = handler;
      return () => {};
    };
    render(<App api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open a" }));
    act(() => open("d"));
    expect(await screen.findByRole("heading", { name: "d" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Screen", pressed: true })).toBeInTheDocument();
  });
});

describe("hypervisor card", () => {
  const cases: [Hypervisor, string | null][] = [
    [{ state: "ok", os: "macos" }, null],
    [{ state: "missing", os: "windows" }, "Enable Windows Hypervisor Platform"],
    [{ state: "missing", os: "linux" }, "/dev/kvm"],
    [{ state: "missing", os: "macos" }, "Hypervisor.framework"],
    [{ state: "unsupported", os: "macos" }, "Apple Silicon"],
  ];
  it.each(cases)("%o shows %s", async (hypervisor, text) => {
    const api = fakeApi([], {}, hypervisor);
    render(<App api={api} />);
    await screen.findByRole("button", { name: "New box" });
    await act(() => Promise.resolve());
    const cards = screen.queryAllByRole("alert");
    if (text === null) return expect(cards).toHaveLength(0);
    expect(cards).toHaveLength(1);
    expect(
      within(cards[0] as HTMLElement).getAllByText(new RegExp(text.replace(/[./]/g, "\\$&"))),
    ).not.toHaveLength(0);
  });

  it("enables Windows Hypervisor Platform and asks for a reboot", async () => {
    const api = fakeApi([], {}, { state: "missing", os: "windows" });
    render(<App api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Enable Windows Hypervisor Platform" }));
    expect(api.enableHypervisor).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Restart Windows/)).toBeInTheDocument();
  });
});

describe("save points", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  const points = [
    { snapshot: "a-200", takenAt: 200 },
    { snapshot: "a-100", takenAt: 100 },
  ];
  async function openBox(api: Api) {
    render(<App api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open a" }));
    return screen.findByRole("region", { name: "Save points" });
  }

  it("shows the lent folder on the card and in the box view", async () => {
    const api = fakeApi([sandbox({ mount: "/Users/me/project" })]);
    render(<App api={api} />);
    expect(within(await card("a")).getByTitle("/Users/me/project")).toHaveTextContent("project");
    await userEvent.click(screen.getByRole("button", { name: "Open a" }));
    expect(await screen.findByTitle("/Users/me/project")).toBeInTheDocument();
  });

  it("reloads the strip after Save point in the box view", async () => {
    const api = fakeApi([sandbox()]);
    await openBox(api);
    expect(api.savePoints).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Save point" }));
    await waitFor(() => expect(api.savePoints).toHaveBeenCalledTimes(2));
  });

  it("starts a copy that boots on the shelf with where it came from", async () => {
    const api = fakeApi([sandbox({ harness: "codex" })]);
    api.savePoints = vi.fn(async () => points);
    api.copyFrom = vi.fn(() => new Promise<Sandbox>(() => {}));
    const strip = await openBox(api);
    await userEvent.click(await within(strip).findByRole("button", { name: /^Save point 1, / }));
    await userEvent.click(within(strip).getByRole("button", { name: "Try another way from here" }));
    expect(api.copyFrom).toHaveBeenCalledExactlyOnceWith("a-100");
    const booting = await screen.findByRole("article", { name: "New box, getting ready" });
    expect(within(booting).getByText("Copy of a · from save point 1")).toBeInTheDocument();
  });

  it("rewinds the box on a held Rewind to here, not a short press", async () => {
    const api = fakeApi([sandbox()]);
    api.savePoints = vi.fn(async () => points);
    const strip = await openBox(api);
    await userEvent.click(await within(strip).findByRole("button", { name: /^Save point 2, / }));
    const key = within(strip).getByRole("button", { name: "Rewind to here: press and hold" });
    fireEvent.pointerDown(key);
    await act(() => vi.advanceTimersByTimeAsync(600));
    fireEvent.pointerUp(key);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(api.rewind).not.toHaveBeenCalled();
    fireEvent.pointerDown(key);
    await act(() => vi.advanceTimersByTimeAsync(1200));
    expect(api.rewind).toHaveBeenCalledExactlyOnceWith("a", "a-200");
    expect(await screen.findByText("Rewound a to save point 2")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "a" })).toBeInTheDocument();
  });
});
