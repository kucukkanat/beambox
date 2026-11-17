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
- **CLI**: the same `beambox` binary run with a command. Everything the window does, from a terminal (see
  [Command line](#command-line)).
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
| `src-tauri/src/cli.rs` | The command line (clap), argument → mode dispatch, `beambox shell` (crossterm), PATH install |
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
- **One binary, three modes** (`cli::mode`): no arguments opens the window, `--mcp` (or `mcp`) serves MCP, anything
  else is a CLI command. `--open <name>` opens the window on a sandbox's desktop; a second launch hands its
  arguments to the running window (`tauri-plugin-single-instance`) and exits.
- **Shared state between the GUI, CLI and `--mcp` processes** lives in the app data dir
  (`~/Library/Application Support/app.beambox.desktop`, `~/.local/share/app.beambox.desktop`,
  `%APPDATA%\app.beambox.desktop`): microsandbox's own database, `takeover/<sandbox>` marker files and
  `activity.jsonl`, which MCP and `--agent` CLI processes append to and the GUI tails.
- **Templates** are labelled `beambox.template`. Image refs live in `TEMPLATES` in `core.rs`.
- **Ports** bind to 127.0.0.1 only. A busy host port moves to the next free one, and the UI shows the real one.

## Scripts

```bash
npm run dev -w @repo/desktop          # fetch runtime, then tauri dev (Vite on :1420)
npm run build -w @repo/desktop        # fetch runtime, then tauri build (.dmg / .AppImage + .deb / .msi)
npm test -w @repo/desktop             # Vitest + cargo test
npm run typecheck -w @repo/desktop    # tsc + cargo check
npm run check:images -w @repo/desktop # build both images and enforce size limits (needs docker or podman)
npm run -s beambox -w @repo/desktop -- list  # rebuild, then run the CLI: never a stale binary
```

Don't run `src-tauri/target/debug/beambox` directly: it may be older than the source, and with no command
(or a flag an old build doesn't know, like `--version`) it opens a window. In worktrees, Claude Code's session
start points `CARGO_TARGET_DIR` at the main checkout's `src-tauri/target`, so dependencies compile once.

Prerequisites for building: Node 24+, Rust (rustup, stable) and
[Tauri's system dependencies](https://tauri.app/start/prerequisites/) (Xcode Command Line Tools on macOS;
WebKitGTK etc. on Linux; WebView2 + MSVC on Windows). No environment variables are needed.

## Command line

**Connect an agent → Install the beambox command** puts `beambox` on the PATH: a two-line launcher in
`/usr/local/bin` on macOS (one admin prompt), `~/.local/bin` on Linux (the `.deb` already installs
`/usr/bin/beambox`), and the user PATH on Windows. It's a launcher rather than a symlink because Tauri won't start
from a symlinked executable on macOS.

```bash
beambox list                                   # table; add --json to any command for scripts
beambox create web -t desktop -p 3000 --mount .  # same options as the window's ▾ menu
beambox exec web -- npm test                   # exits with the command's exit code
beambox shell web                              # interactive terminal
beambox put web /workspace/notes.txt notes.txt # or pipe into stdin; `cat` and `ls` read back
beambox logs web -f
beambox stats web
beambox start|stop|fork|snapshot|delete web
beambox takeover web on                        # pause agent calls on web; `off` hands back
beambox desktop web                            # open the window on web's Desktop tab
beambox doctor                                 # hypervisor and bundled runtime check
beambox mcp                                    # stdio MCP server, same as --mcp
```

Plain calls are you. With `--agent <name>` a call counts as that agent: it shows in the activity feed and is
refused while you have taken the sandbox over, like an MCP call. Agents can't change take-over.

Windows: release builds are GUI-subsystem apps, so the CLI attaches to the terminal it was run from. `cmd.exe`
doesn't wait for GUI-subsystem programs, so output can land after the next prompt there. Not tested on Windows yet.

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
6. **Install the beambox command**, then in a new terminal: `beambox list`, `beambox exec sandbox-1 -- uname -a`,
   `beambox shell sandbox-1` (type `exit` to leave) and `beambox desktop <a desktop sandbox>`.

macOS: the app is signed with `Entitlements.plist` (`com.apple.security.hypervisor`). Check early whether a
notarized build also needs `com.apple.security.cs.disable-library-validation` to load the bundled `libkrunfw`.

## microsandbox notes

Things the crate doesn't make obvious. Each cost a failed run to find; check here before debugging.

- **Socket paths:** microsandbox adds ~50 bytes to `MSB_HOME` for Unix sockets, and macOS caps them at 104. A
  `MSB_HOME` under `~/Library/Application Support/…` fails with "socket path is too long", hence `~/.beambox`.
- **Always set all three env vars** (`MSB_HOME`, `MSB_PATH`, `MSB_LIBKRUNFW_PATH`) when calling the bundled
  `msb` by hand. Without `MSB_HOME` it creates `~/.microsandbox`, which Beambox must never touch.
- **Snapshot names are `<group>:<member>`.** `handle.snapshot("x")` on sandbox `s` creates `s:x`, and lookups
  need the full name. Remove one with `msb snapshot rm s:x`.
- **Booting from a snapshot with labels:** `Sandbox::restore` can't set labels. Use
  `Sandbox::builder(name).override_snapshot(r)` and the builder's own `create_detached()`. Going through
  `build()` + `Sandbox::create_detached(config)` fails with "image source is required".
- **Real-VM tests** are `#[ignore]`d. Run them with `cargo test -- --ignored`, with the three env vars set.

## Licences

The app is MIT ([LICENSE](LICENSE)). Bundled third-party components, including libkrunfw (LGPL-2.1 / GPL-2.0),
are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and on the in-app **Licences** popover.
