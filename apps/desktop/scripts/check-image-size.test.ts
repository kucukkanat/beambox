import { expect, it } from "vitest";
import { overLimit } from "./check-image-size.mjs";

it("flags only images over their limit", () => {
  expect(overLimit({ base: 8e6, desktop: 119e6 })).toEqual([]);
  expect(overLimit({ base: 10.5e6, desktop: 121e6 })).toEqual([
    "base: 10.5 MB > 10 MB",
    "desktop: 121.0 MB > 120 MB",
  ]);
});
