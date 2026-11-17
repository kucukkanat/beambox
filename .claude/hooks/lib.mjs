// Shared helpers for the hook scripts.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const readInput = async () => JSON.parse((await new Response(process.stdin).text()) || "{}");

export const sh = (cmd, cwd, env = {}) => {
  try {
    return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8", env: { ...process.env, ...env } }).trim();
  } catch {
    return "";
  }
};

/** The main checkout (first `git worktree list` entry); equals `root` outside worktrees. */
export const mainCheckout = (root) =>
  sh("git worktree list --porcelain", root).match(/^worktree (.+)$/m)?.[1] ?? root;

/** All worktrees share the main checkout's Turbo cache, so a check passed anywhere is a cache hit everywhere. */
export const turboCacheDir = (root) => join(mainCheckout(root), ".turbo", "cache");

/** The desktop app's Rust crate, if this repo has one. */
const RUST_CRATE = join("apps", "desktop", "src-tauri");

/**
 * Worktrees build Rust into the main checkout's target dir, so Tauri and microsandbox compile once instead of
 * once per worktree (minutes each). Empty when there is no Rust crate.
 */
export const cargoTargetDir = (root) => {
  const main = mainCheckout(root);
  return existsSync(join(main, RUST_CRATE, "Cargo.toml")) ? join(main, RUST_CRATE, "target") : "";
};

/** Missing tools, as lines to show at session start. rustup puts cargo in ~/.cargo/bin, often not on PATH. */
export const missingPrerequisites = (root) => {
  const missing = [];
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 24) missing.push(`Node ${process.versions.node} is too old: this repo needs Node 24+.`);
  const path = `${process.env.PATH}${delimiter}${join(homedir(), ".cargo", "bin")}`;
  const hasCargo = sh("cargo --version", root, { PATH: path }) !== "";
  if (existsSync(join(root, RUST_CRATE)) && !hasCargo) {
    missing.push(
      "Rust isn't installed, so apps/desktop can't typecheck, test or build. Ask the user before installing " +
        "it (rustup, minimal profile, plus clippy and rustfmt).",
    );
  }
  return missing;
};

/** Per-repo metrics log that outlives worktrees (lives in the shared .git directory). */
export const metricsFile = (root) => {
  const gitDir = sh("git rev-parse --path-format=absolute --git-common-dir", root);
  return gitDir ? join(gitDir, "agent-metrics.jsonl") : "";
};

export const branch = (root) => sh("git branch --show-current", root);
