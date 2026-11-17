# @repo/sandbox-mcp

Beambox's MCP server for the agent inside a sandbox. It runs in the guest, not on your computer: Beambox bundles
it into one file, copies it to `/opt/beambox/mcp.js` in every agent snapshot, and registers it as `beambox` in the
harness's MCP config (`node /opt/beambox/mcp.js`, over stdio). The desktop app embeds the bundle at compile time
(`agent::MCP_JS` in `apps/desktop/src-tauri/src/agent.rs`).

## Tools

| Tool | Returns |
| --- | --- |
| `sandbox_info` | `{ name, harness, desktop }`: this sandbox's name, the harness running in it, and whether it has a desktop |

To add a tool, register it in `createServer` in [src/server.ts](src/server.ts) and add a test next to it.
Rebuild the agent snapshots so sandboxes get it: bump the member names in `snapshot_key` (`core.rs`).

## How it runs

- `src/main.ts` reads `/etc/beambox/sandbox.json`, which Beambox writes at every start, and serves on stdio.
  `BEAMBOX_SANDBOX_INFO` points it at another file (for trying the bundle on your own machine).
- The bundle is CommonJS (`/opt/beambox` has no `package.json`), minified, with the MCP SDK inside, so the
  sandbox needs no `npm install`. The SDK and esbuild are devDependencies for that reason.

## Scripts

```bash
npm test -w @repo/sandbox-mcp        # node:test against the SDK's in-memory transport
npm run typecheck -w @repo/sandbox-mcp
npm run build -w @repo/sandbox-mcp   # esbuild → dist/mcp.js (the desktop's cargo commands run this first)
```

Try the bundle by hand:

```bash
echo '{"name":"x","harness":"codex","desktop":false}' > /tmp/info.json
cp dist/mcp.js /tmp/mcp.js   # outside this package, whose "type": "module" would make it ESM
BEAMBOX_SANDBOX_INFO=/tmp/info.json node /tmp/mcp.js
```
