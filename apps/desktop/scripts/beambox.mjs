// `npm run -s beambox -w @repo/desktop -- <args>`: build the current source, then run its CLI, so you never run a
// stale binary. Puts the bundled runtime next to the binary the way `tauri dev` does.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./cargo.mjs";

const scripts = fileURLToPath(new URL(".", import.meta.url));
const tauriDir = join(scripts, "..", "src-tauri");
const run = (command, args, options = {}) =>
  spawnSync(command, args, { stdio: "inherit", env, ...options }).status;

if (run("node", [join(scripts, "fetch-runtime.mjs")]) !== 0) process.exit(1);
if (run("node", [join(scripts, "cargo.mjs"), "build", "--quiet"]) !== 0) process.exit(1);

const exe = process.platform === "win32" ? ".exe" : "";
const debug = join(process.env.CARGO_TARGET_DIR ?? join(tauriDir, "target"), "debug");
const binaries = join(tauriDir, "binaries");
const copyIfChanged = (from, to) => {
  if (!existsSync(to) || statSync(to).size !== statSync(from).size) copyFileSync(from, to);
};
const msb = readdirSync(binaries).find((f) => f.startsWith("msb-"));
if (!msb) throw new Error(`no msb sidecar in ${binaries}`);
copyIfChanged(join(binaries, msb), join(debug, `msb${exe}`));
mkdirSync(join(debug, "runtime"), { recursive: true });
for (const lib of readdirSync(join(binaries, "runtime"))) {
  copyIfChanged(join(binaries, "runtime", lib), join(debug, "runtime", lib));
}

process.exit(run(join(debug, `beambox${exe}`), process.argv.slice(2)) ?? 1);
