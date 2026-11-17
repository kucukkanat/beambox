// CI check: build each template image and fail if its unpacked size is over the limit.
// Usage: node scripts/check-image-size.mjs   (needs docker or podman on PATH; set CONTAINER=podman to switch)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const LIMITS_MB = { base: 10, desktop: 120 };

/** Names of images whose size (bytes) is over their limit, with the measured size. */
export function overLimit(sizes) {
  return Object.entries(sizes)
    .filter(([name, bytes]) => bytes > LIMITS_MB[name] * 1e6)
    .map(([name, bytes]) => `${name}: ${(bytes / 1e6).toFixed(1)} MB > ${LIMITS_MB[name]} MB`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tool = process.env.CONTAINER ?? "docker";
  const images = fileURLToPath(new URL("../images/", import.meta.url));
  const sizes = {};
  for (const name of Object.keys(LIMITS_MB)) {
    const tag = `beambox-${name}:check`;
    execFileSync(tool, ["build", "-q", "-t", tag, `${images}${name}`], { stdio: "inherit" });
    sizes[name] = Number(
      execFileSync(tool, ["image", "inspect", "-f", "{{.Size}}", tag], { encoding: "utf8" }),
    );
    console.log(`${name}: ${(sizes[name] / 1e6).toFixed(1)} MB (limit ${LIMITS_MB[name]} MB)`);
  }
  const failures = overLimit(sizes);
  if (failures.length) {
    console.error(`Images over their size limit:\n${failures.join("\n")}`);
    process.exit(1);
  }
}
