#!/usr/bin/env node
// Stop: if code changed, typecheck + test the affected workspaces. Exit 2 sends Claude back to fix failures.
// Every bounce is logged per branch so /ship can record how much rework a feature needed.
import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { branch, cargoTargetDir, metricsFile, readInput, sh, turboCacheDir } from "./lib.mjs";

const input = await readInput();
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;

// Only bother when something other than docs/specs changed.
const changed = sh("git status --porcelain", root)
  .split("\n")
  .map((line) => line.slice(3).trim())
  .filter((path) => path && !path.endsWith(".md") && !path.startsWith("specs/"));
if (changed.length === 0) process.exit(0);

// Compare against main once it exists; before the first commit, check everything.
const scope = sh("git rev-parse --verify --quiet main", root) ? "--affected" : "";

try {
  execSync(`npx turbo run typecheck test ${scope} --output-logs=errors-only`, {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
    env: {
      ...process.env,
      TURBO_CACHE_DIR: turboCacheDir(root),
      ...(cargoTargetDir(root) && { CARGO_TARGET_DIR: cargoTargetDir(root) }),
    },
  });
} catch (error) {
  const log = metricsFile(root);
  if (log) {
    appendFileSync(
      log,
      `${JSON.stringify({ at: new Date().toISOString(), branch: branch(root), event: "stop-bounce" })}\n`,
    );
  }
  const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.split("\n").slice(-150).join("\n");
  process.stderr.write(
    `Typecheck/tests failed for changed workspaces. Fix the cause, then finish.\n${output}`,
  );
  process.exit(2);
}
