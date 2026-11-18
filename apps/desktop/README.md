# @repo/desktop

Beambox desktop: a Tauri 2 app that gives each AI agent its own computer, a microVM sandbox (microsandbox
0.7.15), and lets you watch it, talk to it and take over. One download, nothing else to install.

- **Agent sandboxes**: pick a harness (Claude Code, Codex CLI or OpenCode), a task and optionally a desktop.
  Beambox boots a Debian sandbox with the harness installed and Beambox's MCP server
  ([`apps/sandbox-mcp`](../sandbox-mcp)) registered in it, and starts the harness on the task in the tmux session
  `agent`. The Terminal tab and `beambox attach` join that session, so you see the agent and can type to it.
  Agents never run on your computer; the app and CLI only manage sandboxes.
- **GUI**: a grid of sandbox cards (start, stop, fork, snapshot, delete with 5 s undo). Each sandbox has Terminal,
  Files, Logs, Ports and, with a desktop, a noVNC Desktop tab. Agent sandboxes also get **Take over**, which
  freezes the harness (SIGSTOP) so you can use the terminal and desktop undisturbed, and **Hand back** (SIGCONT).
- **Signing in** happens inside the sandbox, with a subscription or a key. Without a stored key, the harness signs
  in in its own terminal before starting on the task: Claude Code runs `claude auth login`, Codex runs
  `codex login --device-auth`, and OpenCode starts on its free models (`/connect` adds a provider). The app opens
  the agent's Terminal tab for it. Sign-in pages open in the computer's browser: the sandbox's `$BROWSER`
  (`images/agent/beambox-open`) sends an OSC 1337 `BeamboxOpen=<url>` through tmux (`allow-passthrough all`),
  and the Terminal tab opens https links only (`src/links.ts`).
- **Logins are reused per harness.** Beambox keeps each harness's newest login file (`login_path` in `agent.rs`)
  in `<app data>/logins/<harness>`, owner-only. It collects it from that harness's running sandboxes when one is
  created, stopped or deleted, and copies it into every new sandbox of that harness, so you sign in once per
  harness. Logins live on sandbox disks (and in forks and snapshots of them).
- **Stored keys** (optional; Settings → Credentials, the New sandbox form, or `beambox credentials`): an Anthropic key
  or `claude setup-token` token and an OpenAI key, kept in the OS keychain (`keyring` crate) and passed only as
  the harness process's environment at start. A stored key wins over a saved login.
- **CLI**: the same `beambox` binary run with a command. Everything the window does, from a terminal (see
  [Command line](#command-line)).
- **Desktop tab**: noVNC connects to a per-sandbox proxy on 127.0.0.1 that only accepts the app's own webview
  origin, so other pages on the machine can't reach the VNC server.

## Layout

| Path | What |
| --- | --- |
| `src/` | React + Vite UI (shadcn/ui on Tailwind v4, Motion, xterm.js, noVNC, sonner). `api.ts` is the only Tauri boundary. |
| `src-tauri/src/backend.rs` | `SandboxBackend` trait (+ in-memory fake for tests) |
| `src-tauri/src/core.rs` | Defaults, templates, naming, host-port picking, snapshot builds, agent start, take-over. Shared by GUI and CLI. |
| `src-tauri/src/agent.rs` | Harnesses: install scripts, MCP configs, tmux start command, the embedded `mcp.js` |
| `src-tauri/src/credentials.rs` | `Secrets` trait on the OS keychain (+ in-memory fake for tests) |
| `src-tauri/src/micro.rs` | The trait on the microsandbox SDK |
| `src-tauri/src/cli.rs` | The command line (clap), argument → mode dispatch, `beambox shell` (crossterm), PATH install |
| `src-tauri/src/proxy.rs` | TCP→WebSocket proxy for noVNC (replaces websockify) |
| `src-tauri/src/paths.rs`, `hypervisor.rs`, `ports.rs` | Bundled runtime paths, hypervisor check, port picking |
| `images/base/Dockerfile` | Base template image (≤ 10 MB unpacked) |
| `../../packages/desktop-image/` | The desktop container the app builds desktop and agent desktop sandboxes on (see [Desktop image](#desktop-image)) |
| `scripts/` | `fetch-runtime.mjs`, `check-image-size.mjs`, `cargo.mjs` (bundles `apps/sandbox-mcp`, then runs cargo even if `~/.cargo/bin` isn't on PATH) |

## How it fits together

- **Bundled runtime.** `npm run dev` / `npm run build` first run `scripts/fetch-runtime.mjs`, which downloads the
  `msb` + `libkrunfw` release matching the microsandbox version in `Cargo.lock` into `src-tauri/binaries/`
  (gitignored). `tauri.runtime.conf.json` bundles `msb` as a sidecar and `libkrunfw` as a resource. At startup the
  app sets `MSB_PATH`, `MSB_LIBKRUNFW_PATH` and `MSB_HOME` (`~/.beambox` on macOS/Linux, because microsandbox socket paths must stay under 104 bytes; `<app data>/microsandbox` on Windows), so it never touches
  `~/.microsandbox` or installs anything system-wide. `cargo test` doesn't need the runtime.
- **One binary, two modes** (`cli::mode`): no arguments opens the window, anything else is a CLI command. `--open <name>` opens the window on a sandbox's desktop; a second launch hands its
  arguments to the running window (`tauri-plugin-single-instance`) and exits.
- **Shared state between the GUI and CLI processes** is microsandbox's own database (sandbox labels
  `beambox.template` and `beambox.harness`) and the OS keychain (service `app.beambox.desktop`). Take-over state
  is the harness's own process state in the sandbox, so every process sees the same thing.
- **Templates**: image refs live in `TEMPLATES` in `core.rs`. Agent sandboxes keep `base` or `desktop` as their
  template and add the harness.
- **Agent start** (`Core::create`, `Core::start`, `Core::fork`): write `/etc/beambox/sandbox.json` (what the MCP
  server's `sandbox_info` returns), then `tmux new-session -d -s agent -c /workspace '<harness> <task>; exec bash -l'`
  through `exec_env`, the one backend call that takes environment variables. The tmux server inherits the
  credential from that exec and passes it to the harness; then it is removed from tmux's global environment and
  unset before the fallback shell, so new tmux windows don't get it. A restart or fork starts the harness again without the
  task (it keeps its own history).
- **Take over** sends SIGSTOP to the harness's processes: the tmux pane's process group minus the pane's own
  shell, because tmux sends SIGCONT to a pane process it sees stop, and opens a shell in a new tmux window, so
  what you type doesn't queue up for the agent. **Hand back** sends SIGCONT and switches back to window 0. The app button
  and `beambox takeover` both call `Core::set_takeover`.
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

**Install the beambox command** (in the app's header) puts `beambox` on the PATH: a two-line launcher in
`/usr/local/bin` on macOS (one admin prompt), `~/.local/bin` on Linux (the `.deb` already installs
`/usr/bin/beambox`), and the user PATH on Windows. It's a launcher rather than a symlink because Tauri won't start
from a symlinked executable on macOS.

```bash
beambox list                                   # table; add --json to any command for scripts
beambox create web -t desktop -p 3000 --mount .  # same options as the window's ▾ menu
beambox create fixer --harness claude-code --task "fix the tests" --mount . [--desktop]
beambox create shared -t desktop --web         # CLI only: also prints a link to the desktop in a browser
beambox attach fixer                           # the agent's terminal (tmux); detach with Ctrl-b d
beambox exec web -- npm test                   # exits with the command's exit code
beambox shell web                              # interactive terminal
beambox put web /workspace/notes.txt notes.txt # or pipe into stdin; `cat` and `ls` read back
beambox logs web -f
beambox stats web
beambox start|stop|fork|snapshot|delete web
beambox takeover fixer on                      # freeze the agent; `off` hands back
beambox credentials set anthropic              # reads the key from stdin, hidden at a terminal
beambox credentials list                       # names only; `remove <name>` forgets one
beambox desktop web                            # open the window on web's Desktop tab
beambox doctor                                 # hypervisor and bundled runtime check
```

`--web` (with a desktop) also publishes guest port 6080 on 127.0.0.1 and prints a noVNC link with a random token.
The setting lasts across restarts and forks. The link is only printed by that `create` (and is in its `--json` as
`webUrl`), so keep it. See the desktop image's README for how the token keeps other web pages out.

Windows: release builds are GUI-subsystem apps, so the CLI attaches to the terminal it was run from. `cmd.exe`
doesn't wait for GUI-subsystem programs, so output can land after the next prompt there. Not tested on Windows yet.

## Templates

- **Base** is `alpine:3.22`. `images/base` is checked with `npm run check:images` (docker or podman); release CI can
  push it to GHCR and pin `TEMPLATES` (`core.rs`) to its `@sha256:` digest.
- **Local snapshots** need no registry and no Docker. The first sandbox of each kind builds its snapshot locally
  (`Core::snapshot_for`): boot the base image as a hidden `beambox-build-…` sandbox, run the setup script, stop
  it, save the disk snapshot, and delete the build sandbox. Every sandbox after that boots from the snapshot in
  seconds. `snapshot_key` in `core.rs` names them; bump a member's suffix when its setup changes. A lock file,
  `snapshot-build.lock` in the app data dir, makes the app and CLI processes build each snapshot once.

  | Kind | Base image | Setup | Snapshot | First build |
  | --- | --- | --- | --- | --- |
  | Desktop (plain) | `DESKTOP_IMAGE`, pulled; `debian:trixie-slim` if that fails | `desktop_setup()` (fallback only) | `beambox-build-desktop:beambox-desktop-6` (fallback only) | a pull; ~1.5 min built |
  | Agent | `debian:trixie-slim` | `agent_setup(h, false)` + `mcp.js` + MCP config | `beambox-build-<h>:beambox-<h>-5` | ~40 s |
  | Agent + desktop | `DESKTOP_IMAGE`; `debian:trixie-slim` if it can't be pulled | `agent_setup(h, false)` (`agent_setup(h, true)` on Debian) + the same files | `beambox-build-<h>-desktop:beambox-<h>-desktop-8` | ~1 min on the image, ~2 min on Debian |

  Agent snapshots get Node 24 (NodeSource), the harness from npm (`@anthropic-ai/claude-code`, `@openai/codex`,
  `opencode-ai`; latest at build time), tmux, git, curl, `/opt/beambox/mcp.js` and the harness's MCP config
  (`/root/.claude.json`, `/root/.codex/config.toml`, `/root/.config/opencode/opencode.json`). With a desktop they
  start from the desktop image instead (see [Desktop image](#desktop-image)). Agent
  sandboxes default to 2 vCPUs and 2 GiB (4 GiB with a desktop). The app runs `start-desktop` after each boot.
- **What's in a desktop:** see [`packages/desktop-image`](../../packages/desktop-image). Xvnc, openbox with
  the Beambox theme, a tint2 top bar, the Plank dock, xterm and Chromium.
- `node scripts/cargo.mjs test real_ -- --ignored --test-threads=1` checks this against real microVMs: the Alpine desktop, a
  Claude Code sandbox (`claude --version`, MCP config, `mcp.js` answers `initialize`, tmux session in
  `/workspace`, no key on disk, take over and hand back) and its desktop variant (Chromium, VNC). It
  needs `MSB_PATH`, `MSB_LIBKRUNFW_PATH` and `MSB_HOME` pointing at `src-tauri/binaries/` and a short `MSB_HOME`
  such as `~/.beambox`.

## Desktop image

Desktops come from [`@repo/desktop-image`](../../packages/desktop-image): the container image (its `image/` folder
holds `install.sh`, the `Dockerfile` and the theme files), published as `ghcr.io/OWNER/beambox-desktop`. The Rust
code embeds that folder (`DESKTOP_FILES` in `agent.rs`), so the app and the image share one definition.

- **Desktop sandboxes** are created from `DESKTOP_IMAGE` (`core.rs`). microsandbox pulls it anonymously once, and
  later desktops reuse the cached layers. If creating from it fails (offline, registry down, not published yet),
  Beambox deletes what the attempt left, builds the `beambox-build-desktop:beambox-desktop-6` snapshot by running
  the package's `install.sh` on `debian:trixie-slim` (~1.5 min, once), and says so in a toast or on the CLI's
  stderr. Once that snapshot exists, desktops boot from it without asking the registry until the version is
  bumped. Pulling runs outside the lock that picks names and ports, so other creates aren't held up.
- **Agent desktops** are built on the desktop image: their snapshot boots `DESKTOP_IMAGE` and adds only the agent
  (`agent_setup(h, false)`). If the image can't be pulled, the build installs the same desktop on Debian instead
  (`agent_setup(h, true)`, which runs `install.sh`). Agents without a desktop stay on `debian:trixie-slim`.
- **Releasing a new image** (see the package README): bump the tag in `DESKTOP_IMAGE` and the desktop snapshot
  member in `snapshot_key` together (a test keeps them equal), and the agent desktop members too.

## Smoke test (manual, per OS)

Run on a fresh machine (macOS Apple Silicon, Ubuntu with KVM, Windows 11) for every release:

1. Install the bundle (`.dmg` → drag to Applications; `.deb`/`.AppImage`; `.msi`) and open Beambox.
2. If a hypervisor card shows, follow it (Windows: **Enable Windows Hypervisor Platform**, reboot). Otherwise
   none shows.
3. Click 1: **New sandbox**. The card goes from booting (pulsing amber) to running (green).
4. Click 2: **Open**. The Terminal tab is already active and shows a `sandbox-1:/#` prompt.
5. Pass if the prompt appears within 3 clicks. Also check: `echo hi` works; with no key stored,
   **▾ → Harness: Claude Code, Task: "list the files here"** opens its Terminal tab on Claude's sign-in, the
   sign-in page opens in your browser, and after signing in Claude works on the task. A second Claude Code
   sandbox starts signed in. **Take over** / **Hand back** pause and resume it.
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
- **Real-VM tests** are `#[ignore]`d. Run them with `node scripts/cargo.mjs test -- --ignored` (it builds
  `mcp.js` first, which the Rust code embeds), with the three env vars set.

## Licences

The app is MIT ([LICENSE](LICENSE)). Bundled third-party components, including libkrunfw (LGPL-2.1 / GPL-2.0),
are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and on the in-app **Licences** popover.
