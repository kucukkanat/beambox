import { describe, expect, it } from "vitest";
import { plainText } from "./ansi.ts";

describe("plainText", () => {
  it("removes colours, cursor moves, titles and charset switches", () => {
    // From a real Codex sign-in log: colour, clear-to-end-of-line, alternate screen, charset.
    const raw =
      "\x1b[34m\x1b[1mhttps://auth.openai.com/codex/device\x1b(B\x1b[m\x1b[K\x1b[?1049l\x1b]0;codex\x07";
    expect(plainText(raw)).toBe("https://auth.openai.com/codex/device");
  });

  it("keeps a line a carriage return rewrote as it ended up", () => {
    expect(plainText("Downloading 10%\rDownloading 100%\r\ndone\n")).toBe("Downloading 100%\ndone\n");
  });

  it("keeps tabs and newlines and drops other control characters", () => {
    expect(plainText("a\tb\x07\x08\nc")).toBe("a\tb\nc");
  });
});
