import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Api } from "./api.ts";
import { Desktop } from "./Desktop.tsx";

// noVNC needs a real canvas and server; this stands in for it and lets the test fire "connect".
const clients: { resizeSession?: boolean; fire: (type: string) => void }[] = [];
vi.mock("@novnc/novnc", () => ({
  default: class {
    resizeSession?: boolean;
    listeners: Record<string, () => void> = {};
    constructor() {
      clients.push(this);
    }
    addEventListener(type: string, listener: () => void) {
      this.listeners[type] = listener;
    }
    fire(type: string) {
      this.listeners[type]?.();
    }
    disconnect() {}
  },
}));

beforeEach(() => {
  clients.length = 0;
  localStorage.clear();
});

const api = () =>
  ({ desktopPort: vi.fn(async () => 1234), desktopResize: vi.fn(async () => {}) }) as unknown as Api;

async function connect(fake: Api) {
  render(<Desktop api={fake} name="a" />);
  await waitFor(() => expect(clients).toHaveLength(1));
  act(() => clients[0]?.fire("connect"));
}

it("fits the window by default, and sets a chosen resolution in the sandbox", async () => {
  const fake = api();
  await connect(fake);
  expect(clients[0]?.resizeSession).toBe(true);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Resolution" }), "1920 × 1080");
  expect(clients[0]?.resizeSession).toBe(false);
  expect(fake.desktopResize).toHaveBeenCalledWith("a", 1920, 1080);
});

it("remembers the resolution and sets it again on the next connect", async () => {
  localStorage.setItem("beambox.desktop-resolution", "1280x800");
  const fake = api();
  await connect(fake);
  expect(screen.getByRole("combobox", { name: "Resolution" })).toHaveValue("1280x800");
  expect(fake.desktopResize).toHaveBeenCalledWith("a", 1280, 800);
});
