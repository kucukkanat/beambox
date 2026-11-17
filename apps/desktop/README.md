# @repo/desktop

Beambox desktop: a Tauri 2 app where AI agents get their own microVM sandboxes (microsandbox 0.7.15), and you
can watch them and step in through a GUI. One download, nothing else to install.

- **GUI**: a grid of sandbox cards (start, stop, fork, snapshot, delete with 5 s undo). Each sandbox has Terminal,
  Files, Logs, Ports and, for the `desktop` template, a noVNC Desktop tab, plus a live feed of agent commands
  with **Take over**, which pauses the agent's MCP calls on that sandbox.
- **MCP**: `beambox --mcp` is a stdio MCP server with `sandbox_create`, `sandbox_list`, `sandbox_exec`,
  `file_read`, `file_write`, `sandbox_stop` and `sandbox_delete`. **Connect an agent** copies a ready config.
  Sandboxes an agent creates are labelled `beambox.agent=<client name>`. Agents choose a name, template and
  ports; host folder mounts and network policy are GUI-only.
- **Desktop tab**: noVNC connects to a per-sandbox proxy on 127.0.0.1 that only accepts the app's own webview
  origin, so other pages on the machine can't reach the VNC server.

## Layout

| Path | What |
| --- | --- |
| `src/` | React + Vite UI (shadcn/ui on Tailwind v4, Motion, xterm.js, noVNC, sonner). `api.ts` is the only Tauri boundary. |
| `src-tauri/src/backend.rs` | `SandboxBackend` trait (+ in-memory fake for tests) |
| `src-tauri/src/core.rs` | Defaults, templates, naming, host-port picking, take-over, activity events. Shared by GUI and MCP. |
| `src-tauri/src/micro.rs` | The trait on the microsandbox SDK |
| `src-tauri/src/mcp.rs` | The `--mcp` server (rmcp) |
| `src-tauri/src/proxy.rs` | TCP→WebSocket proxy for noVNC (replaces websockify) |
| `src-tauri/src/paths.rs`, `hypervisor.rs`, `ports.rs` | Bundled runtime paths, hypervisor check, port picking |
| `images/base/Dockerfile` | Base template image (≤ 10 MB unpacked) |
| `images/desktop/start-desktop` | Starts Xvfb, openbox and x11vnc in a Desktop sandbox; installed by `desktop_setup()` in `core.rs` |
| `scripts/` | `fetch-runtime.mjs`, `check-image-size.mjs`, `cargo.mjs` (runs cargo even if `~/.cargo/bin` isn't on PATH) |

## How it fits together

- **Bundled runtime.** `npm run dev` / `npm run build` first run `scripts/fetch-runtime.mjs`, which downloads the
  `msb` + `libkrunfw` release matching the microsandbox version in `Cargo.lock` into `src-tauri/binaries/`
  (gitignored). `tauri.runtime.conf.json` bundles `msb` as a sidecar and `libkrunfw` as a resource. At startup the
  app sets `MSB_PATH`, `MSB_LIBKRUNFW_PATH` and `MSB_HOME` (`~/.beambox` on macOS/Linux, because microsandbox socket paths must stay under 104 bytes; `<app data>/microsandbox` on Windows), so it never touches
  `~/.microsandbox` or installs anything system-wide. `cargo test` doesn't need the runtime.
- **Shared state between the GUI and `--mcp` processes** lives in the app data dir
  (`~/Library/Application Support/app.beambox.desktop`, `~/.local/share/app.beambox.desktop`,
  `%APPDATA%\app.beambox.desktop`): microsandbox's own database, `takeover/<sandbox>` marker files and
  `activity.jsonl`, which MCP processes append to and the GUI tails.
- **Templates** are labelled `beambox.template`. Image refs live in `TEMPLATES` in `core.rs`.
- **Ports** bind to 127.0.0.1 only. A busy host port moves to the next free one, and the UI shows the real one.

## Scripts

```bash
npm run dev -w @repo/desktop          # fetch runtime, then tauri dev (Vite on :1420)
npm run build -w @repo/desktop        # fetch runtime, then tauri build (.dmg / .AppImage + .deb / .msi)
npm test -w @repo/desktop             # Vitest + cargo test
npm run typecheck -w @repo/desktop    # tsc + cargo check
npm run check:images -w @repo/desktop # build both images and enforce size limits (needs docker or podman)
```

Prerequisites for building: Node 24+, Rust (rustup, stable) and
[Tauri's system dependencies](https://tauri.app/start/prerequisites/) (Xcode Command Line Tools on macOS;
WebKitGTK etc. on Linux; WebView2 + MSVC on Windows). No environment variables are needed.

## Templates

- **Base** is `alpine:3.22`. `images/base` is checked with `npm run check:images` (docker or podman); release CI can
  push it to GHCR and pin `TEMPLATES` (`core.rs`) to its `@sha256:` digest.
- **Desktop** needs no registry and no Docker. The first Desktop sandbox builds it locally (`Core::desktop_snapshot`):
  boot `alpine:3.22` as the hidden sandbox `beambox-build-desktop`, run `desktop_setup()` (apk add xvfb, x11vnc,
  openbox, xterm, fonts, plus `start-desktop`), stop it, save the disk snapshot `beambox-build-desktop:beambox-desktop-1`,
  and delete the build sandbox. That takes ~10 s once. Every Desktop sandbox after that boots from the snapshot in
  ~1 s, and the app runs `start-desktop` after each boot. Bump `DESKTOP_MEMBER` when `desktop_setup()` changes.
  Installed size is ~327 MiB (Mesa comes in with Xvfb), over the spec's 120 MB target.
- `cargo test real_desktop -- --ignored` checks this against real microVMs. It needs `MSB_PATH`,
  `MSB_LIBKRUNFW_PATH` and `MSB_HOME` pointing at `src-tauri/binaries/` and `~/.beambox`.

## Smoke test (manual, per OS)

Run on a fresh machine (macOS Apple Silicon, Ubuntu with KVM, Windows 11) for every release:

1. Install the bundle (`.dmg` → drag to Applications; `.deb`/`.AppImage`; `.msi`) and open Beambox.
2. If a hypervisor card shows, follow it (Windows: **Enable Windows Hypervisor Platform**, reboot). Otherwise
   none shows.
3. Click 1: **New sandbox**. The card goes from booting (pulsing amber) to running (green).
4. Click 2: **Open**. The Terminal tab is already active and shows a `sandbox-1:/#` prompt.
5. Pass if the prompt appears within 3 clicks. Also check: `echo hi` works, **Connect an agent → Claude Code**
   gives a working `claude mcp add` command, and `sandbox_exec` from the agent shows in the activity feed.

macOS: the app is signed with `Entitlements.plist` (`com.apple.security.hypervisor`). Check early whether a
notarized build also needs `com.apple.security.cs.disable-library-validation` to load the bundled `libkrunfw`.

## Licences

The app is MIT ([LICENSE](LICENSE)). Bundled third-party components, including libkrunfw (LGPL-2.1 / GPL-2.0),
are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and on the in-app **Licences** popover.
