// Grab one frame from a VNC server without a password (raw encoding) and check that the desktop is drawn.
// Usage: node scripts/vnc-frame.mjs <port> [--host 127.0.0.1] [--wait 60] [--min 20]
// Retries (up to --wait seconds) until the server answers with a frame of which at least --min % of the pixels
// aren't black, and fails otherwise. The desktop image's CI smoke test runs it, and so can you against any Beambox desktop.
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Reads exact byte counts from a socket. */
function reader(socket) {
  let buffered = Buffer.alloc(0);
  let wake = () => {};
  let failure;
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    wake();
  });
  const fail = (error) => {
    failure = error;
    wake();
  };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("VNC server closed the connection")));
  return async (n) => {
    while (buffered.length < n) {
      if (failure) throw failure;
      await new Promise((resolve) => (wake = resolve));
    }
    const out = buffered.subarray(0, n);
    buffered = buffered.subarray(n);
    return out;
  };
}

/** One full frame from `host:port`, as its size and how many of its pixels aren't black. */
export async function grabFrame(host, port) {
  const socket = connect(port, host);
  socket.setTimeout(10_000, () => socket.destroy(new Error("VNC server timed out")));
  const read = reader(socket);
  try {
    await read(12);
    socket.write("RFB 003.008\n");
    const types = await read((await read(1))[0]);
    if (!types.includes(1)) throw new Error(`VNC server needs a password (security types ${[...types]})`);
    socket.write(Buffer.from([1]));
    if ((await read(4)).readUInt32BE(0) !== 0) throw new Error("VNC security handshake failed");
    socket.write(Buffer.from([1])); // ClientInit: shared
    const init = await read(24);
    const [width, height, bytes] = [init.readUInt16BE(0), init.readUInt16BE(2), init[4] / 8];
    await read(init.readUInt32BE(20)); // desktop name
    socket.write(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0])); // SetEncodings: raw
    const request = Buffer.alloc(10);
    request[0] = 3; // FramebufferUpdateRequest, not incremental
    request.writeUInt16BE(width, 6);
    request.writeUInt16BE(height, 8);
    socket.write(request);
    const update = await read(4);
    if (update[0] !== 0) throw new Error(`unexpected VNC message ${update[0]}`);
    let lit = 0;
    let total = 0;
    for (let r = update.readUInt16BE(2); r > 0; r--) {
      const rect = await read(12);
      const data = await read(rect.readUInt16BE(4) * rect.readUInt16BE(6) * bytes);
      for (let i = 0; i < data.length; i += bytes) {
        total += 1;
        if (data[i] || data[i + 1] || data[i + 2]) lit += 1;
      }
    }
    return { width, height, lit, total };
  } finally {
    socket.destroy();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      wait: { type: "string", default: "60" },
      min: { type: "string", default: "20" },
    },
  });
  const [port, min] = [Number(positionals[0] ?? 5900), Number(values.min)];
  const deadline = Date.now() + Number(values.wait) * 1000;
  for (;;) {
    let outcome;
    try {
      const { width, height, lit, total } = await grabFrame(values.host, port);
      const share = (100 * lit) / Math.max(total, 1);
      outcome = `${width}x${height}: ${lit} of ${total} pixels not black (${share.toFixed(1)}%)`;
      if (share >= min) {
        console.log(outcome);
        break;
      }
    } catch (error) {
      outcome = String(error);
    }
    if (Date.now() > deadline) {
      console.error(
        `${outcome}\nThe desktop wasn't drawn (at least ${min}% non-black) within ${values.wait} s.`,
      );
      process.exit(1);
    }
    await sleep(1000);
  }
}
