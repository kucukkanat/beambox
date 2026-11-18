import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, SavePoint } from "./api.ts";
import { SavePoints } from "./SavePoints.tsx";
import { HOLD_MS } from "./sound.ts";

// Newest first, as the core returns them.
const twoPoints = [
  { snapshot: "a-200", takenAt: 200 },
  { snapshot: "a-100", takenAt: 100 },
];

async function renderStrip(points: SavePoint[] = twoPoints) {
  const api = { savePoints: vi.fn(async () => points), removeSavePoint: vi.fn(async () => {}) };
  const [onCopy, onRewind] = [vi.fn(), vi.fn()];
  const strip = (version: number) => (
    <SavePoints api={api as unknown as Api} name="a" version={version} onCopy={onCopy} onRewind={onRewind} />
  );
  const { rerender } = render(strip(0));
  await act(async () => {});
  return { api, onCopy, onRewind, reload: () => act(async () => rerender(strip(1))) };
}

const pick = (n: number) =>
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Save point ${n}, `) }));

describe("SavePoints", () => {
  afterEach(() => vi.useRealTimers());

  it("lists the save points oldest to newest, ending at NOW", async () => {
    await renderStrip();
    const cards = screen.getAllByRole("button", { name: /^Save point \d/ });
    expect(cards.map((c) => c.getAttribute("aria-label")?.split(",")[0])).toEqual([
      "Save point 1",
      "Save point 2",
    ]);
    expect(screen.getByText("NOW")).toBeTruthy();
  });

  it("explains save points when there are none", async () => {
    await renderStrip([]);
    expect(
      screen.getByText(
        "No save points yet. Take one before a risky step, then rewind to it or start a copy from it.",
      ),
    ).toBeTruthy();
  });

  it("reloads when its version changes, and polls nothing", async () => {
    vi.useFakeTimers();
    const { api, reload } = await renderStrip();
    act(() => vi.advanceTimersByTime(60_000));
    expect(api.savePoints).toHaveBeenCalledTimes(1);
    await reload();
    expect(api.savePoints).toHaveBeenCalledTimes(2);
  });

  it("starts a copy from the selected save point", async () => {
    const { onCopy, onRewind } = await renderStrip();
    pick(1);
    fireEvent.click(screen.getByRole("button", { name: "Try another way from here" }));
    expect(onCopy).toHaveBeenCalledExactlyOnceWith("a-100", 1);
    expect(onRewind).not.toHaveBeenCalled();
  });

  it("rewinds only on a held press, not a short one", async () => {
    vi.useFakeTimers();
    const { onRewind } = await renderStrip();
    pick(2);
    const rewind = screen.getByRole("button", { name: "Rewind to here: press and hold" });
    fireEvent.pointerDown(rewind);
    act(() => vi.advanceTimersByTime(HOLD_MS / 2));
    fireEvent.pointerUp(rewind);
    act(() => vi.advanceTimersByTime(HOLD_MS));
    expect(onRewind).not.toHaveBeenCalled();
    fireEvent.pointerDown(rewind);
    act(() => vi.advanceTimersByTime(HOLD_MS));
    expect(onRewind).toHaveBeenCalledExactlyOnceWith("a-200", 2);
  });

  it("removes a save point on a held press and reloads", async () => {
    vi.useFakeTimers();
    const { api } = await renderStrip();
    pick(1);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Remove: press and hold" }));
    act(() => vi.advanceTimersByTime(HOLD_MS));
    await act(async () => {});
    expect(api.removeSavePoint).toHaveBeenCalledWith("a-100");
    expect(api.savePoints).toHaveBeenCalledTimes(2);
  });
});
