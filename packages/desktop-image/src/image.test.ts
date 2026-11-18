import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it("the dock pins a file manager that install.sh installs and gives a launcher", () => {
  const install = read("../image/install.sh");
  assert.match(install, /apt-get install(?:[^\n]|\\\n)*\bpcmanfm\b/);
  has(install, '"$src/applications/files.desktop" /usr/share/applications/files.desktop');
  has(install, "Launcher=file:///usr/share/applications/files.desktop");
  has(read("../image/plank.dconf"), "'files.dockitem'");
  has(read("../image/applications/files.desktop"), "Exec=pcmanfm");
});

it("desktop-watch refits the background and the dock when the screen changes size, and shows a wallpaper", () => {
  // Stand-ins for X's tools on PATH: xrandr reports the size in `screen` and fails once it's gone (X has exited),
  // `sleep` moves on to the next step, and everything the script draws or starts is logged to `calls`.
  const dir = mkdtempSync(join(tmpdir(), "desktop-watch-"));
  const bin = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  const wallpaper = join(dir, "wallpaper.png");
  // Each step: the screen size, the wallpaper's contents and mtime ("" = none), and "died" when the dock crashes.
  const steps = [
    "1114 695 -",
    "1114 695 -",
    "2000 783 -",
    "2000 783 png 5",
    "2000 783 png 5 died",
    "2000 783 png 5",
  ];
  writeFileSync(join(dir, "steps"), `${steps.join("\n")}\n`);
  // A real pause first, so the Plank started in the background is up before the next check, as in a real second.
  const next = `/bin/sleep 0.2; set -- $(sed -n 1p "${dir}/steps"); sed -i.bak 1d "${dir}/steps"
if [ -z "$1" ]; then rm -f "${dir}/screen"; else echo "$1 $2" > "${dir}/screen"; fi
if [ "$3" = png ]; then echo "$3" > "${wallpaper}"; echo "$4" > "${dir}/mtime"; fi
if [ "$5" = died ]; then rm -f "${dir}/running"; fi`;
  bin("next", next);
  bin(
    "xrandr",
    `[ -f "${dir}/screen" ] || exit 1; read w h < "${dir}/screen"; echo "Screen 0: minimum 32 x 32, current $w x $h, maximum 16384 x 16384"`,
  );
  bin("stat", `[ -s "$3" ] && cat "${dir}/mtime"`);
  bin("sleep", `"${dir}/next"`);
  bin("setsid", '"$@"');
  bin("hsetroot", `echo "hsetroot $*" >> "${dir}/calls"`);
  // A Plank that's running until it's killed or dies, which pgrep sees.
  bin("plank", `echo "plank $*" >> "${dir}/calls"; touch "${dir}/running"`);
  bin("pkill", `echo "pkill $*" >> "${dir}/calls"; rm -f "${dir}/running"`);
  bin("pgrep", `[ -f "${dir}/running" ]`);
  try {
    execFileSync(join(dir, "next"));
    execFileSync("sh", [new URL("../image/desktop-watch", import.meta.url).pathname], {
      env: { PATH: `${dir}:/usr/bin:/bin`, WALLPAPER: wallpaper },
      timeout: 10_000,
    });
    const gradient = "hsetroot -add #2b4c7e -add #1a2238 -add #0d1117 -gradient 160";
    const calls = readFileSync(join(dir, "calls"), "utf8")
      .trim()
      .split("\n")
      .map((c) => c.trim());
    // Plank starts in the background, so only the order of the rest is fixed.
    assert.equal(
      calls.filter((c) => c === "plank").length,
      3,
      "Plank restarts once per size, and when it died",
    );
    assert.deepEqual(
      calls.filter((c) => c !== "plank"),
      [
        ...[gradient, "pkill -x plank"], // started at 1114x695
        ...[gradient, "pkill -x plank"], // resized to 2000x783
        `hsetroot -cover ${wallpaper}`, // a wallpaper appeared: the dock stays
        "pkill -x plank", // the dock died: it comes back
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("Files' Set as Wallpaper copies one image to where desktop-watch looks", () => {
  const action = read("../image/set-wallpaper.desktop");
  for (const line of ["Type=Action", "MimeTypes=image/*;", "SelectionCount==1", "Exec=set-wallpaper %f"]) {
    has(action, line);
  }
  has(read("../image/install.sh"), "/usr/share/file-manager/actions/set-wallpaper.desktop");
  // PCManFM only adds actions to its menu through libfm's gtk-menu-actions module, which is in libfm-modules: only a
  // recommended package, so --no-install-recommends leaves it out.
  assert.match(read("../image/install.sh"), /apt-get install(?:[^\n]|\\\n)*\blibfm-modules\b/);
  // Both scripts use the same path.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
  const path = "WALLPAPER=${WALLPAPER:-/root/.config/beambox/wallpaper}";
  for (const file of ["desktop-watch", "set-wallpaper"]) has(read(`../image/${file}`), path);
  const script = new URL("../image/set-wallpaper", import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), "set-wallpaper-"));
  try {
    const wallpaper = join(dir, "config", "beambox", "wallpaper");
    writeFileSync(join(dir, "a photo.png"), "png");
    execFileSync("sh", [script, join(dir, "a photo.png")], {
      env: { PATH: "/usr/bin:/bin", WALLPAPER: wallpaper },
    });
    assert.equal(readFileSync(wallpaper, "utf8"), "png");
    assert.throws(() => execFileSync("sh", [script, join(dir, "missing.png")], { stdio: "pipe" }), /usage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("start-desktop serves the web desktop only when asked, behind a token, and before its early exit", () => {
  const start = read("../image/start-desktop");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
  has(start, "web_port=${WEB_PORT:-$(cat /etc/beambox/web-port 2>/dev/null)}");
  has(start, 'if [ -n "$web_port" ]');
  assert.match(
    start,
    /websockify [^\n]*--token-plugin ReadOnlyTokenFile \\\n\s+--token-source \/etc\/beambox\/web-targets/,
  );
  has(start, 'echo "$token: localhost:5900"');
  // A restarted sandbox has Xvnc already running only if it never stopped; the web part must not depend on it.
  assert.ok(start.indexOf("websockify") < start.indexOf("pgrep Xvnc >/dev/null && exit 0"));
  const install = read("../image/install.sh");
  has(install, "apt-get download novnc python3-websockify");
  assert.doesNotMatch(install, /apt-get install[^\n]*(novnc|websockify)/);
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
