#!/usr/bin/env node
// Per shipped spec (specs/done/*.md): lead time, diff size, new deps, rework (Stop-hook bounces, review findings),
// grouped so you can see whether model routing or process changes make features faster and cleaner.
import { readdir, readFile } from "node:fs/promises";

const dir = new URL("../specs/done/", import.meta.url);
const field = (text, key) => text.match(new RegExp(`^${key}:\\s*(.*?)\\s*(#.*)?$`, "m"))?.[1] ?? "";
const num = (value) => Number(value) || 0;
const rows = [];

for (const name of (await readdir(dir)).filter((f) => f.endsWith(".md"))) {
  const text = await readFile(new URL(name, dir), "utf8");
  const diff = field(text, "diff");
  rows.push({
    spec: name.replace(/\.md$/, ""),
    size: field(text, "size"),
    leadTimeH: Number(
      ((Date.parse(field(text, "shipped")) - Date.parse(field(text, "created"))) / 36e5).toFixed(1),
    ),
    lines: num(diff.match(/(\d+) insertion/)?.[1]) + num(diff.match(/(\d+) deletion/)?.[1]),
    newDeps: num(field(text, "new_deps")),
    bounces: num(field(text, "bounces")),
    findings: num(field(text, "review_findings")),
  });
}

if (rows.length === 0) {
  console.log("No shipped specs yet.");
} else {
  console.table(rows);
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(
    `Median lead time ${median(rows.map((r) => r.leadTimeH))} h, median rework ${median(rows.map((r) => r.bounces + r.findings))} over ${rows.length} specs`,
  );
}
