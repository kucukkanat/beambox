#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit): format + lint-fix the edited file with Biome.
// Remaining lint errors go back to Claude (exit 2) so it fixes them while the file is fresh.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";

const input = JSON.parse(await new Response(process.stdin).text());
const file = input.tool_input?.file_path;
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
const biome = join(root, "node_modules/.bin/biome");
const supported = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".css"]);

if (!file || !supported.has(extname(file)) || !existsSync(file) || !existsSync(biome)) process.exit(0);

try {
  execFileSync(biome, ["check", "--write", "--no-errors-on-unmatched", file], { cwd: root, stdio: "pipe" });
} catch (error) {
  process.stderr.write(
    `Biome found problems it couldn't fix in ${file}:\n${error.stdout ?? ""}${error.stderr ?? ""}`,
  );
  process.exit(2);
}
