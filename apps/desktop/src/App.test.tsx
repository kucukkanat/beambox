import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import type { Activity, Api, Hypervisor, Sandbox } from "./api.ts";

// xterm and noVNC need a real canvas; their wiring is covered by the Rust tests and the manual smoke test.
vi.mock("./Terminal.tsx", () => ({ Terminal: () => null }));
vi.mock("./Desktop.tsx", () => ({ Desktop: () => null }));

const sandbox = (over: Partial<Sandbox> = {}): Sandbox => ({
  name: "a",
  template: "base",
  status: "running",
  cpus: 1,
  memoryMib: 256,
  agent: null,
  ports: [],
  ...over,
});

function fakeApi(sandboxes: Sandbox[] = [], hypervisor: Hypervisor = { state: "ok", os: "macos" }): Api {
  return {
    list: vi.fn(async () => sandboxes),
    create: vi.fn(async () => sandbox({ name: "sandbox-1" })),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    fork: vi.fn(async () => sandbox({ name: "a-fork-1" })),
    snapshot: vi.fn(async () => "a-1"),
    delete: vi.fn(async () => {}),
    listDir: vi.fn(async () => []),
    readFile: vi.fn(async () => new Uint8Array()),
    writeFile: vi.fn(async () => {}),
    logs: vi.fn(async () => []),
    metrics: vi.fn(async () => ({ cpuPercent: 0, memoryBytes: 0 })),
    takeover: vi.fn(async () => false),
    setTakeover: vi.fn(async () => {}),
    hypervisor: vi.fn(async () => hypervisor),
    enableHypervisor: vi.fn(async () => {}),
    mcpCommand: vi.fn(async () => "/Applications/Beambox.app/Contents/MacOS/beambox"),
    installCli: vi.fn(async () => "Installed. Run `beambox --help` in a terminal."),
    takeOpen: vi.fn(async () => null),
    onOpen: vi.fn(() => () => {}),
    desktopPort: vi.fn(async () => 6080),
    terminalOpen: vi.fn(async () => 1),
    terminalInput: vi.fn(async () => {}),
    terminalResize: vi.fn(async () => {}),
    terminalClose: vi.fn(async () => {}),
    onActivity: vi.fn(() => () => {}),
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

beforeEach(() => prefersReducedMotion(false));
afterEach(() => vi.useRealTimers());

describe("home", () => {
  it("one click on New sandbox calls the backend once with defaults", async () => {
    const api = fakeApi();
    render(<App api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "New sandbox" }));
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledWith({});
  });

  it("says a Desktop sandbox is starting until it is ready", async () => {
    const api = fakeApi();
    let finish = (_: Sandbox) => {};
    api.create = vi.fn(() => new Promise<Sandbox>((resolve) => (finish = resolve)));
    render(<App api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Sandbox options" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Template" }), "desktop");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText(/Starting the desktop/)).toBeInTheDocument();
    await act(async () => finish(sandbox({ name: "sandbox-1", template: "desktop" })));
    expect(await screen.findByText("sandbox-1 is ready")).toBeInTheDocument();
  });

  describe("delete", () => {
    // Reduced motion: cards leave at once instead of after an exit animation jsdom can't run.
    beforeEach(() => {
      prefersReducedMotion(true);
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    it("shows an undo toast and does not delete when undo is clicked within 5 s", async () => {
      const api = fakeApi([sandbox()]);
      render(<App api={api} />);
      await user().click(await screen.findByRole("button", { name: "Delete a" }));
      expect(await screen.findByText("Deleted a")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "a" })).not.toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(4000));
      await user().click(await screen.findByRole("button", { name: "Undo" }));
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(api.delete).not.toHaveBeenCalled();
      expect(await screen.findByRole("heading", { name: "a" })).toBeInTheDocument();
    });

    it("deletes after 5 s without undo", async () => {
      // A different name: sonner's toast store outlives each render.
      const api = fakeApi([sandbox({ name: "b" })]);
      render(<App api={api} />);
      await user().click(await screen.findByRole("button", { name: "Delete b" }));
      expect(await screen.findByText("Deleted b")).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(4900));
      expect(api.delete).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(api.delete).toHaveBeenCalledExactlyOnceWith("b");
    });
  });

  it("animates cards and pulses the booting dot normally", async () => {
    render(<App api={fakeApi([sandbox({ status: "booting" })])} />);
    expect(await screen.findByLabelText("booting")).toHaveClass("animate-pulse");
  });

  it("has no animations with reduced motion", async () => {
    prefersReducedMotion(true);
    render(<App api={fakeApi([sandbox({ status: "booting" })])} />);
    const dot = await screen.findByLabelText("booting");
    expect(dot.className).not.toMatch(/animate-|transition/);
    // Cards render in their final state at once: no enter opacity/transform to animate from.
    const card = screen.getByRole("article", { name: "a" });
    expect(card.style.opacity).toBe("");
    expect(card.style.transform).toBe("");
  });
});

describe("sandbox view", () => {
  async function open(api: Api) {
    render(<App api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open a" }));
  }

  it("shows the Desktop tab only for the desktop template", async () => {
    await open(fakeApi([sandbox({ template: "base" })]));
    expect(screen.getByRole("tab", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Desktop" })).not.toBeInTheDocument();
  });

  it("shows the Desktop tab for the desktop template", async () => {
    await open(fakeApi([sandbox({ template: "desktop", ports: [{ guest: 5900, host: 5901 }] })]));
    expect(screen.getByRole("tab", { name: "Desktop" })).toBeInTheDocument();
  });

  it("shows the actual host port of a published port", async () => {
    await open(fakeApi([sandbox({ ports: [{ guest: 8080, host: 8081 }] })]));
    await userEvent.click(screen.getByRole("tab", { name: "Ports" }));
    expect(screen.getByText("127.0.0.1:8081")).toBeInTheDocument();
  });

  it("shows agent commands live and updates them when they finish", async () => {
    const api = fakeApi([sandbox()]);
    let emit = (_: Activity) => {};
    api.onActivity = (handler) => {
      emit = handler;
      return () => {};
    };
    await open(api);
    act(() => emit({ id: "7-1", sandbox: "a", agent: "claude-code", command: "make test", exitCode: null }));
    expect(screen.getByText(/make test/)).toHaveTextContent("running…");
    act(() => emit({ id: "7-1", sandbox: "a", agent: "claude-code", command: "make test", exitCode: 2 }));
    expect(screen.getAllByText(/make test/)).toHaveLength(1);
    expect(screen.getByText(/make test/)).toHaveTextContent("exit 2");
  });

  it("take over pauses the agent's calls", async () => {
    const api = fakeApi([sandbox()]);
    await open(api);
    await userEvent.click(screen.getByRole("button", { name: "Take over" }));
    expect(api.setTakeover).toHaveBeenCalledWith("a", true);
    expect(await screen.findByRole("button", { name: "Hand back" })).toBeInTheDocument();
  });
});

describe("command line", () => {
  const desktop = sandbox({ name: "d", template: "desktop", ports: [{ guest: 5900, host: 5900 }] });

  it("opens the Desktop tab of the sandbox `beambox desktop` launched the window for", async () => {
    const api = fakeApi([desktop]);
    api.takeOpen = vi.fn(async () => "d");
    render(<App api={api} />);
    expect(await screen.findByRole("tab", { name: "Desktop", selected: true })).toBeInTheDocument();
  });

  it("switches to a sandbox's desktop when asked while the window is open", async () => {
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
    expect(screen.getByRole("tab", { name: "Desktop", selected: true })).toBeInTheDocument();
  });

  it("installs the beambox command and says how to use it", async () => {
    const api = fakeApi();
    render(<App api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect an agent" }));
    await userEvent.click(screen.getByRole("button", { name: "Install the beambox command" }));
    expect(api.installCli).toHaveBeenCalledOnce();
    expect(await screen.findByText(/beambox --help/, { selector: "[data-title]" })).toBeInTheDocument();
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
    const api = fakeApi([], hypervisor);
    render(<App api={api} />);
    await screen.findByRole("button", { name: "New sandbox" });
    await act(() => Promise.resolve());
    const cards = screen.queryAllByRole("alert");
    if (text === null) return expect(cards).toHaveLength(0);
    expect(cards).toHaveLength(1);
    expect(
      within(cards[0] as HTMLElement).getAllByText(new RegExp(text.replace(/[./]/g, "\\$&"))),
    ).not.toHaveLength(0);
  });

  it("enables Windows Hypervisor Platform and asks for a reboot", async () => {
    const api = fakeApi([], { state: "missing", os: "windows" });
    render(<App api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Enable Windows Hypervisor Platform" }));
    expect(api.enableHypervisor).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Restart Windows/)).toBeInTheDocument();
  });
});
