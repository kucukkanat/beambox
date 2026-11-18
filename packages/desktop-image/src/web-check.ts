// Check the web desktop's lock (start-desktop's WEB_PORT): its token reaches VNC, and any other token doesn't.
// Usage: node packages/desktop-image/src/web-check.ts <port> <token> [--host 127.0.0.1]
// The desktop image's CI smoke test runs it with the token from the printed link.
import { parseArgs } from "node:util";

/** What the WebSocket at `url` sends first: VNC's greeting (`RFB 003.008`) when it's let through, else `closed`. */
export function firstMessage(url: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, ["binary"]);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      ws.close();
      resolve("no answer");
    }, timeoutMs);
    ws.onmessage = (event) => {
      clearTimeout(timer);
      ws.close();
      resolve(Buffer.from(event.data as ArrayBuffer).toString("latin1"));
    };
    ws.onclose = () => {
      clearTimeout(timer);
      resolve("closed");
    };
  });
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { host: { type: "string", default: "127.0.0.1" } },
});
const [port, token] = positionals;
if (!port || !token) {
  console.error("Usage: web-check.ts <port> <token> [--host 127.0.0.1]");
  process.exit(2);
}
const url = (t: string) => `ws://${values.host}:${port}/websockify?token=${t}`;
const [right, wrong] = await Promise.all([firstMessage(url(token)), firstMessage(url(`${token}x`))]);
console.log(`with the token: ${JSON.stringify(right)}\nwith another token: ${JSON.stringify(wrong)}`);
if (!right.startsWith("RFB ") || wrong.startsWith("RFB ")) {
  console.error("The web desktop must let its token through to VNC, and nothing else.");
  process.exit(1);
}
