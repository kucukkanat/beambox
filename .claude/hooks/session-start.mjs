#!/usr/bin/env node
// SessionStart: install deps in fresh worktrees, share the Turbo cache, and print where work stands.
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { branch, readInput, sh, turboCacheDir } from "./lib.mjs";

const input = await readInput();
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
const out = [];

if (!existsSync(join(root, "node_modules"))) {
  execSync("npm install --prefer-offline --no-audit --no-fund", { cwd: root, stdio: "ignore" });
  out.push("Installed dependencies for this checkout.");
}

if (process.env.CLAUDE_ENV_FILE) {
  appendFileSync(process.env.CLAUDE_ENV_FILE, `export TURBO_CACHE_DIR="${turboCacheDir(root)}"\n`);
}

// Orientation: spec statuses and open branches.
const specsDir = join(root, "specs");
const byStatus = {};
for (const file of existsSync(specsDir) ? readdirSync(specsDir) : []) {
  if (!file.endsWith(".md") || file.startsWith("_") || file === "README.md") continue;
  const status = readFileSync(join(specsDir, file), "utf8").match(/^status:\s*(\w+)/m)?.[1] ?? "unknown";
  byStatus[status] = [...(byStatus[status] ?? []), file.replace(/\.md$/, "")];
}
const branches = sh("git branch --format=%(refname:short)", root)
  .split("\n")
  .filter((b) => b && b !== "main");

out.push(`Current branch: ${branch(root) || "(none)"}`);
for (const [status, label] of [
  ["approved", "Approved, ready for /build"],
  ["built", "Built, ready for /ship"],
  ["draft", "Drafts awaiting approval"],
]) {
  if (byStatus[status]) out.push(`${label}: ${byStatus[status].join(", ")}`);
}
if (branches.length) out.push(`Open branches: ${branches.join(", ")}`);

process.stdout.write(`${out.join("\n")}\n`);
