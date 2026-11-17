import { describe, expect, it } from "vitest";
import { linkToOpen } from "./links.ts";

describe("links from the sandbox", () => {
  it("opens https sign-in links", () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&state=x";
    expect(linkToOpen(`BeamboxOpen=${url}`)).toBe(url);
  });

  it("ignores other schemes, other OSC 1337 messages and malformed links", () => {
    for (const osc of [
      "BeamboxOpen=file:///etc/passwd",
      "BeamboxOpen=http://example.com",
      "BeamboxOpen=https://a b",
      "BeamboxOpen=",
      "SetMark",
    ]) {
      expect(linkToOpen(osc), osc).toBeNull();
    }
  });
});
