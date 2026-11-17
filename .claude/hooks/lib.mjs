// Shared helpers for the hook scripts.
import { execSync } from "node:child_process";
import { join } from "node:path";

export const readInput = async () => JSON.parse((await new Response(process.stdin).text()) || "{}");

export const sh = (cmd, cwd) => {
  try {
    return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

/** The main checkout (first `git worktree list` entry); equals `root` outside worktrees. */
export const mainCheckout = (root) =>
  sh("git worktree list --porcelain", root).match(/^worktree (.+)$/m)?.[1] ?? root;

/** All worktrees share the main checkout's Turbo cache, so a check passed anywhere is a cache hit everywhere. */
export const turboCacheDir = (root) => join(mainCheckout(root), ".turbo", "cache");

/** Per-repo metrics log that outlives worktrees (lives in the shared .git directory). */
export const metricsFile = (root) => {
  const gitDir = sh("git rev-parse --path-format=absolute --git-common-dir", root);
  return gitDir ? join(gitDir, "agent-metrics.jsonl") : "";
};

export const branch = (root) => sh("git branch --show-current", root);
