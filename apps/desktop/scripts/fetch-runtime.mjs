// Download the microsandbox runtime (msb + libkrunfw) matching the pinned crate into src-tauri/binaries/,
// where tauri.runtime.conf.json bundles msb as a sidecar and libkrunfw as a resource. Runs before
// `tauri dev` and `tauri build`; does nothing when the files are already there.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./cargo.mjs";

const tauriDir = fileURLToPath(new URL("../src-tauri/", import.meta.url));
const lock = readFileSync(join(tauriDir, "Cargo.lock"), "utf8");
const version = lock.match(/name = "microsandbox"\r?\nversion = "([^"]+)"/)?.[1];
if (!version) throw new Error("microsandbox not found in src-tauri/Cargo.lock");

// Tauri names sidecars by Rust target triple, e.g. msb-aarch64-apple-darwin. Builds are for the host.
const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8", env }).match(/^host: (.+)$/m)?.[1];
if (!triple) throw new Error("cannot determine the Rust target triple");
const arch = triple.split("-")[0];
const os = triple.includes("apple") ? "darwin" : triple.includes("windows") ? "windows" : "linux";
const exe = os === "windows" ? ".exe" : "";
const libkrunfw =
  os === "darwin"
    ? /^libkrunfw\.\d+\.dylib$/
    : os === "windows"
      ? /^libkrunfw\.dll$/
      : /^libkrunfw\.so\.\d+\.\d+\.\d+$/;

const binaries = join(tauriDir, "binaries");
const msbTarget = join(binaries, `msb-${triple}${exe}`);
const runtimeDir = join(binaries, "runtime");
const haveLib = existsSync(runtimeDir) && readdirSync(runtimeDir).some((f) => libkrunfw.test(f));
if (existsSync(msbTarget) && haveLib) process.exit(0);

const url = `https://github.com/superradcompany/microsandbox/releases/download/v${version}/microsandbox-${os}-${arch}.tar.gz`;
console.log(`Fetching microsandbox ${version} runtime for ${triple}…`);
const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
const work = mkdtempSync(join(tmpdir(), "beambox-runtime-"));
const archive = join(work, "runtime.tar.gz");
writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
execFileSync("tar", ["-xzf", archive, "-C", work]);

const files = readdirSync(work, { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
const find = (test) => {
  const file = files.find((f) => test(f.name));
  if (!file) throw new Error(`runtime archive from ${url} has no file matching ${test}`);
  return join(file.parentPath, file.name);
};
mkdirSync(runtimeDir, { recursive: true });
copyFileSync(
  find((n) => n === `msb${exe}`),
  msbTarget,
);
const lib = find((n) => libkrunfw.test(n));
copyFileSync(lib, join(runtimeDir, lib.split(/[\\/]/).pop()));
rmSync(work, { recursive: true, force: true });
console.log(`Runtime ready in ${binaries}`);
