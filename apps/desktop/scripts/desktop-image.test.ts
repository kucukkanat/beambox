import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { expect, it } from "vitest";
import { grabFrame } from "./vnc-frame.mjs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const dockerfile = read("../images/desktop/Dockerfile");
const workflow = read("../../../.github/workflows/desktop-image.yml");
// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
const PUSH = "${{ startsWith(github.ref, 'refs/tags/desktop-v') }}";

it("the Dockerfile runs install.sh from the copied folder and starts the desktop in the foreground", () => {
  expect(dockerfile).toMatch(/^FROM debian:trixie-slim$/m);
  expect(dockerfile).toMatch(/^COPY \. \/tmp\/beambox-desktop\/?$/m);
  expect(dockerfile).toMatch(
    /^RUN sh \/tmp\/beambox-desktop\/install\.sh && rm -rf \/tmp\/beambox-desktop$/m,
  );
  expect(dockerfile).toMatch(/^CMD \["beambox-desktop"\]$/m);
  for (const label of ["source", "licenses", "version"]) {
    expect(dockerfile).toContain(`org.opencontainers.image.${label}=`);
  }
});

it("the workflow builds both architectures natively and smoke-tests each", () => {
  expect(workflow).toMatch(/tags: \["desktop-v\*"\]/);
  expect(workflow).toMatch(
    /pull_request:\n\s+paths:\n(\s+- .*\n)*\s+- "apps\/desktop\/images\/desktop\/\*\*"/,
  );
  expect(workflow).toMatch(/platform: linux\/amd64\n\s+runner: ubuntu-24\.04\n/);
  expect(workflow).toMatch(/platform: linux\/arm64\n\s+runner: ubuntu-24\.04-arm\n/);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
  expect(workflow).toContain("runs-on: ${{ matrix.runner }}");
  for (const action of ["setup-buildx-action", "build-push-action", "metadata-action", "login-action"]) {
    expect(workflow).toContain(`uses: docker/${action}@`);
  }
  expect(workflow).toContain("-p 127.0.0.1:5900:5900");
  expect(workflow).toContain("node apps/desktop/scripts/vnc-frame.mjs 5900");
  expect(workflow).toContain("ghcr.io/OWNER/beambox-desktop");
});

it("the workflow pushes a multi-arch manifest only on desktop-v tags, never from pull requests", () => {
  expect(workflow).toContain(`push-by-digest=true,name-canonical=true,push=${PUSH}`);
  expect(workflow).not.toMatch(/push(: |=)true/);
  // In the build job, which pull requests run, logging in and every push step happen on tags only. The merge
  // job runs on tags only as a whole.
  const build = workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("  merge:"));
  const steps = build.split(/\n\s+- (?=name:|uses:)/);
  const guarded = steps.filter((s) => /login-action|Push by digest|upload-artifact/.test(s));
  expect(guarded).toHaveLength(3);
  for (const step of guarded) expect(step).toContain(`if: ${PUSH.slice(4, -3)}`);
  expect(workflow).toMatch(
    /merge:\n\s+needs: build\n\s+if: startsWith\(github\.ref, 'refs\/tags\/desktop-v'\)/,
  );
  expect(workflow).toContain("docker buildx imagetools create");
  expect(workflow).toContain("type=match,pattern=desktop-v(.*),group=1");
  expect(workflow).toContain("type=raw,value=latest");
  expect(workflow).toContain("packages: write");
});

/** A VNC server without a password that sends one raw frame: `pixels` are [r, g, b] in 32 bpp. */
function fakeVnc(width: number, height: number, pixels: [number, number, number][]) {
  const server = createServer((socket) => {
    let stage = 0;
    socket.write("RFB 003.008\n");
    socket.on("data", (data: Buffer) => {
      stage += 1;
      if (stage === 1) socket.write(Buffer.from([1, 1])); // one security type: None
      if (stage === 2 && data[0] === 1) socket.write(Buffer.from([0, 0, 0, 0])); // security result: OK
      if (stage === 3) {
        const init = Buffer.alloc(4 + 16 + 4 + 4);
        init.writeUInt16BE(width, 0);
        init.writeUInt16BE(height, 2);
        init[4] = 32; // bits per pixel
        init.writeUInt32BE(4, 20);
        init.write("test", 24);
        socket.write(init);
      }
      // SetEncodings and FramebufferUpdateRequest can arrive together or apart; answer the request.
      if (data.includes(3) && stage >= 4) {
        const header = Buffer.alloc(4 + 12);
        header.writeUInt16BE(1, 2);
        header.writeUInt16BE(width, 8);
        header.writeUInt16BE(height, 10);
        const body = Buffer.from(pixels.flatMap(([r, g, b]) => [b, g, r, 0]));
        socket.end(Buffer.concat([header, body]));
      }
    });
  });
  return new Promise<{ port: number; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || !address) throw new Error("no port");
      resolve({ port: address.port, close: () => server.close() });
    }),
  );
}

it("vnc-frame grabs one frame and counts the pixels that aren't black", async () => {
  const black: [number, number, number] = [0, 0, 0];
  const vnc = await fakeVnc(2, 2, [[26, 34, 56], black, [255, 255, 255], [0, 0, 1]]);
  try {
    expect(await grabFrame("127.0.0.1", vnc.port)).toEqual({ width: 2, height: 2, lit: 3, total: 4 });
  } finally {
    vnc.close();
  }
});
