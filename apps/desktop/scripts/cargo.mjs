// Run cargo on src-tauri, also when rustup's ~/.cargo/bin isn't on PATH (apps and hooks started before
// Rust was installed, or launched from a GUI). First bundles apps/sandbox-mcp into dist/mcp.js, which the Rust
// code embeds (`agent::MCP_JS`); esbuild takes well under a second.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export const env = {
  ...process.env,
  PATH: `${process.env.PATH}${delimiter}${join(homedir(), ".cargo", "bin")}`,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const bundled = spawnSync("npm", ["run", "-s", "build", "-w", "@repo/sandbox-mcp"], {
    stdio: "inherit",
    env,
  });
  if (bundled.status !== 0) process.exit(bundled.status ?? 1);
  const manifest = fileURLToPath(new URL("../src-tauri/Cargo.toml", import.meta.url));
  const { status } = spawnSync("cargo", [command, "--manifest-path", manifest, ...args], {
    stdio: "inherit",
    env,
  });
  process.exit(status ?? 1);
}
