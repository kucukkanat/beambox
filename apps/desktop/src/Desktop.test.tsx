import { act, render, screen, waitFor } from "@testing-library/react";
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
});

const api = () => ({ desktopPort: vi.fn(async () => 1234) }) as unknown as Api;

async function connect(fake: Api) {
  render(<Desktop api={fake} name="a" />);
  await waitFor(() => expect(clients).toHaveLength(1));
  act(() => clients[0]?.fire("connect"));
}

it("follows the window's size, with no resolution menu", async () => {
  await connect(api());
  expect(clients[0]?.resizeSession).toBe(true);
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});
