import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { it } from "node:test";
import { grabFrame } from "./vnc-frame.ts";

/** `text` contains `part` (shown as the failure message). */
const has = (text: string, part: string) => assert.ok(text.includes(part), part);
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const dockerfile = read("../image/Dockerfile");
const workflow = read("../../../.github/workflows/desktop-image.yml");
// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
const PUSH = "${{ startsWith(github.ref, 'refs/tags/desktop-v') }}";

it("the Dockerfile installs the packages in a layer the desktop's files don't invalidate", () => {
  assert.match(dockerfile, /^FROM debian:trixie-slim$/m);
  const steps = [
    "COPY install.sh /tmp/beambox-desktop/install.sh",
    "RUN sh /tmp/beambox-desktop/install.sh packages",
    "COPY . /tmp/beambox-desktop",
    "RUN sh /tmp/beambox-desktop/install.sh files && rm -rf /tmp/beambox-desktop",
    // A build arg changes on every release, and a changed arg reruns every RUN after it.
    "ARG VERSION",
    'CMD ["beambox-desktop"]',
  ].map((step) => dockerfile.indexOf(`\n${step}`));
  assert.ok(!steps.includes(-1), `missing a step: ${steps}`);
  assert.deepEqual(
    steps,
    steps.toSorted((a, b) => a - b),
  );
  for (const label of ["source", "licenses", "version"]) {
    has(dockerfile, `org.opencontainers.image.${label}=`);
  }
});

it("install.sh sets dpkg's filters before it installs, and does both steps when given no step", () => {
  const install = read("../image/install.sh");
  assert.ok(install.indexOf("/etc/dpkg/dpkg.cfg.d/beambox-desktop") < install.indexOf("apt-get install"));
  has(install, 'if [ "$1" != files ]; then');
  has(install, '[ "$1" = packages ] && exit 0');
  // The dock's 48 px icons and the weights the desktop uses stay.
  assert.doesNotMatch(install, /Papirus\*?\/(16|48|64)x/);
  for (const weight of ["Regular", "Medium", "SemiBold", "Bold"]) {
    has(install, `path-include=/usr/share/fonts/opentype/inter/Inter-${weight}.otf`);
  }
});

it("the workflow builds both architectures natively and smoke-tests each", () => {
  assert.match(workflow, /tags: \["desktop-v\*"\]/);
  assert.match(workflow, /pull_request:\n\s+paths:\n(\s+- .*\n)*\s+- "packages\/desktop-image\/\*\*"/);
  assert.match(workflow, /platform: linux\/amd64\n\s+runner: ubuntu-24\.04\n/);
  assert.match(workflow, /platform: linux\/arm64\n\s+runner: ubuntu-24\.04-arm\n/);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
  has(workflow, "runs-on: ${{ matrix.runner }}");
  for (const action of ["setup-buildx-action", "build-push-action", "metadata-action", "login-action"]) {
    has(workflow, `uses: docker/${action}@`);
  }
  has(workflow, "-p 127.0.0.1:5900:5900");
  has(workflow, "node packages/desktop-image/src/vnc-frame.ts 5900");
  has(workflow, "ghcr.io/OWNER/beambox-desktop");
});

it("the workflow pushes a multi-arch manifest only on desktop-v tags, never from pull requests", () => {
  has(workflow, `push-by-digest=true,name-canonical=true,push=${PUSH}`);
  assert.doesNotMatch(workflow, /push(: |=)true/);
  // In the build job, which pull requests run, logging in and every push step happen on tags only. The merge
  // job runs on tags only as a whole.
  const build = workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("  merge:"));
  const steps = build.split(/\n\s+- (?=name:|uses:)/);
  const guarded = steps.filter((s) => /login-action|Push by digest|upload-artifact/.test(s));
  assert.equal(guarded.length, 3);
  for (const step of guarded) has(step, `if: ${PUSH.slice(4, -3)}`);
  assert.match(
    workflow,
    /merge:\n\s+needs: build\n\s+if: startsWith\(github\.ref, 'refs\/tags\/desktop-v'\)/,
  );
  has(workflow, "docker buildx imagetools create");
  has(workflow, "type=match,pattern=desktop-v(.*),group=1");
  has(workflow, "type=raw,value=latest");
  has(workflow, "packages: write");
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
    assert.deepEqual(await grabFrame("127.0.0.1", vnc.port), { width: 2, height: 2, lit: 3, total: 4 });
  } finally {
    vnc.close();
  }
});
