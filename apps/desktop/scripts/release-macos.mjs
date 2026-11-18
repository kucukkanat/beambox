// Build the macOS app for release: sign the bundled runtime library (Tauri copies resources unsigned), let Tauri build,
// sign and notarize the .app and .dmg, then check the result. Signs with a Developer ID identity already in a keychain.
// Runs the same locally (`npm run release:macos`, settings in .env) and in .github/workflows/desktop-app.yml.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./cargo.mjs";

const required = ["APPLE_SIGNING_IDENTITY", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing ${missing.join(", ")}. Set them in apps/desktop/.env (see .env.example).`);
  process.exit(1);
}

const desktopDir = fileURLToPath(new URL("../", import.meta.url));
const tauriDir = join(desktopDir, "src-tauri");
const run = (command, args) => execFileSync(command, args, { stdio: "inherit", env, cwd: desktopDir });
const read = (command, args) => execFileSync(command, args, { encoding: "utf8", env, cwd: desktopDir });

run("node", ["scripts/fetch-runtime.mjs"]);
const runtime = join(tauriDir, "binaries", "runtime");
for (const lib of readdirSync(runtime).filter((f) => f.endsWith(".dylib"))) {
  run("codesign", [
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    "--sign",
    process.env.APPLE_SIGNING_IDENTITY,
    join(runtime, lib),
  ]);
}

run("npm", ["run", "build", "--", "--bundles", "app,dmg"]);

const bundle = join(process.env.CARGO_TARGET_DIR || join(tauriDir, "target"), "release", "bundle");
const app = join(bundle, "macos", "Beambox.app");
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
// msb runs the microVMs, so it must keep the hypervisor entitlement after Tauri re-signs it.
const entitlements = read("codesign", ["-d", "--entitlements", "-", join(app, "Contents", "MacOS", "msb")]);
if (!entitlements.includes("com.apple.security.hypervisor")) {
  throw new Error("msb lost the com.apple.security.hypervisor entitlement");
}
run("xcrun", ["stapler", "validate", app]);
run("spctl", ["--assess", "--type", "execute", "--verbose", app]);
const dmg = readdirSync(join(bundle, "dmg")).find((f) => f.endsWith(".dmg"));
if (!dmg) throw new Error(`no .dmg in ${join(bundle, "dmg")}`);
console.log(`Signed and notarized: ${join(bundle, "dmg", dmg)}`);
