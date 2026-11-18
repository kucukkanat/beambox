const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
// Terminal control sequences: colours and cursor moves (CSI), titles and links (OSC), and the short ESC ones.
const SEQUENCES = new RegExp(
  [
    `${ESC}\\[[0-9;?<=>!]*[ -/]*[@-~]`,
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
    `${ESC}[()*+][0-9A-Za-z]`,
    `${ESC}[@-_]`,
  ].join("|"),
  "g",
);
// Mouse reports (`ESC[<35;18;7M`) a shell echoed after its line editor ate the `ESC[<`: terminal input, not output.
const MOUSE_REPORTS = /(?:<)?\d{1,3};\d{1,4};\d{1,4}[Mm]/g;
// The other control characters, but tab and newline.
const CONTROLS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g",
);

/**
 * A terminal's raw output as plain text: sequences removed, and a line a carriage return rewrote (a progress bar,
 * a prompt redrawn) kept as it ended up.
 */
export function plainText(raw: string): string {
  return raw
    .replace(SEQUENCES, "")
    .replace(MOUSE_REPORTS, "")
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n")
    .replace(CONTROLS, "");
}
