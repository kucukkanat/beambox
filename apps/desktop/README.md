# @repo/desktop

Beambox desktop: a Tauri 2 app that gives each AI agent its own computer, a microVM sandbox (microsandbox
0.7.15), and lets you watch it, talk to it and take over. One download, nothing else to install.

- **Agent sandboxes**: pick a harness (Claude Code, Codex CLI or OpenCode), a task and optionally a desktop.
  Beambox boots a Debian sandbox with the harness installed and Beambox's MCP server
  ([`apps/sandbox-mcp`](../sandbox-mcp)) registered in it, and starts the harness on the task in the tmux session
  `agent`. The Terminal tab and `beambox attach` join that session, so you see the agent and can type to it.
  Agents never run on your computer; the app and CLI only manage sandboxes.
- **GUI**: a shelf of "boxes" for non-developers, in a hardware look (`src/index.css`, from
  `specs/assets/shelf-prototype.html`): physical keys (`Button`'s `key` variant), LEDs, a shutter on sleeping boxes
  and synthesised key sounds (`src/sound.ts`, Web Audio; the mute key keeps `beambox.muted` in localStorage).
  - Each box's state (`src/box.ts`) comes from `status`, the harness's status and whether it still waits for a
    sign-in. It's also the shelf's sort order: Agent stopped, Crashed, Sign in (made by this window without a key,
    until you open its terminal or dismiss it), Getting ready, Working, You're driving, Ready for you, Asleep. The
    first three also show in the **Waiting for you** tray, with **Start agent again** (`Core::restart_agent_session`:
    a fresh `agent` tmux session without the task), **Wake** or **Open terminal**.
  - A card's screen shows the last lines of the terminal output as plain text (`src/ansi.ts`), polled every 2 s.
    Its keys are Sleep/Wake (stop/start), Save point (snapshot), Try another way (fork) and Throw away, a
    press-and-hold key (`HoldKey` in `src/keys.tsx`, 1.2 s) followed by a 5 s undo toast.
  - **New box** (or `N`) opens a sheet: who works in it (Claude Code, Codex CLI, OpenCode or just a computer, with
    "Signed in" or "Sign in once"), the job, a folder to lend (click for `tauri-plugin-dialog`, or drop one:
    `onFolderDrop`), a screen (a desktop), a size fader (Light 1 CPU/1 GB, Standard 2/2, Roomy 2/4, Heavy 4/8; a
    screen needs Roomy) and the network. More options holds the name, web ports and an optional key. While a create
    runs, its card narrates the boot on a timer; only the end of the create is real.
  - Opening a box shows one large screen with Screen (noVNC, desktop boxes), Terminal, Files and Web previews.
    Agent boxes get the **AGENT / YOU lever**: YOU freezes the harness (SIGSTOP) so you can use the terminal and
    desktop undisturbed; handing back (SIGCONT) can type a note into the agent's session, so it knows what you
    changed. `Esc` goes back to the shelf.
  - Files opens at `/workspace` (the root if there's none), hides microsandbox's `/.msb` and opens symlinks to
    folders as folders. Web previews list the published ports, with the desktop's VNC port as the Screen rather than
    as a web page.
- **Signing in** happens inside the sandbox, with a subscription or a key. Without a stored key, the harness signs
  in in its own terminal before starting on the task: Claude Code runs `claude auth login`, Codex runs
  `codex login --device-auth`, and OpenCode starts on its free models (`/connect` adds a provider). The box shows
  up in the Waiting for you tray, whose **Open terminal** shows it. Sign-in pages open in the computer's browser: the sandbox's `$BROWSER`
  (`images/agent/beambox-open`) sends an OSC 1337 `BeamboxOpen=<url>` through tmux (`allow-passthrough all`),
  and the Terminal tab opens https links only (`src/links.ts`).
- **Logins are reused per harness.** Beambox keeps each harness's newest login file (`login_path` in `agent.rs`)
  in `<app data>/logins/<harness>`, owner-only. It collects it from that harness's running sandboxes when one is
  created, stopped or deleted, and copies it into every new sandbox of that harness, so you sign in once per
  harness. Logins live on sandbox disks (and in forks and snapshots of them).
- **Stored keys** (optional; ⋯ → Settings, the New box sheet's More options, or `beambox credentials`): an Anthropic key
  or `claude setup-token` token and an OpenAI key, kept in the OS keychain (`keyring` crate) and passed only as
  the harness process's environment at start. A stored key wins over a saved login.
- **CLI**: the same `beambox` binary run with a command. Everything the window does, from a terminal (see
  [Command line](#command-line)).
- **Screen** (desktop boxes): noVNC connects to a per-sandbox proxy on 127.0.0.1 that only accepts the app's own webview
  origin, so other pages on the machine can't reach the VNC server. The Resolution menu in its top-right corner
  picks **Fit window** (the screen follows the tab, drawn 1:1) or a fixed size from Xvnc's list (`xrandr -s` through
  the `desktop_resize` command), scaled down to fit so everything looks smaller. The choice is kept, and applied
  again on every connect.

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
| `scripts/` | `fetch-runtime.mjs`, `cargo.mjs` (bundles `apps/sandbox-mcp`, then runs cargo even if `~/.cargo/bin` isn't on PATH) |

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
  server's `sandbox_info` returns), then `tmux -u new-session -d -s agent -c /workspace -e LANG=C.UTF-8 '<harness> <task>; exec bash -l'`
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
npm run -s beambox -w @repo/desktop -- list  # rebuild, then run the CLI: never a stale binary
```

Don't run `src-tauri/target/debug/beambox` directly: it may be older than the source, and with no command
(or a flag an old build doesn't know, like `--version`) it opens a window. In worktrees, Claude Code's session
start points `CARGO_TARGET_DIR` at the main checkout's `src-tauri/target`, so dependencies compile once.

Prerequisites for building: Node 24+, Rust (rustup, stable) and
[Tauri's system dependencies](https://tauri.app/start/prerequisites/) (Xcode Command Line Tools on macOS;
WebKitGTK etc. on Linux; WebView2 + MSVC on Windows). No environment variables are needed.

## Command line

**Install the beambox command** (in the header's ⋯ menu) puts `beambox` on the PATH: a two-line launcher in
`/usr/local/bin` on macOS (one admin prompt), `~/.local/bin` on Linux (the `.deb` already installs
`/usr/bin/beambox`), and the user PATH on Windows. It's a launcher rather than a symlink because Tauri won't start
from a symlinked executable on macOS.

```bash
beambox list                                   # table; add --json to any command for scripts
beambox create web -t desktop -p 3000 --mount .  # same options as the New box sheet
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
beambox desktop web                            # open the window on web's Screen
beambox doctor                                 # hypervisor and bundled runtime check
```

`--web` (with a desktop) also publishes guest port 6080 on 127.0.0.1 and prints a noVNC link with a random token.
The setting lasts across restarts and forks. The link is only printed by that `create` (and is in its `--json` as
`webUrl`), so keep it. See the desktop image's README for how the token keeps other web pages out.

Windows: release builds are GUI-subsystem apps, so the CLI attaches to the terminal it was run from. `cmd.exe`
doesn't wait for GUI-subsystem programs, so output can land after the next prompt there. Not tested on Windows yet.

## Templates

- **One base snapshot** needs no registry and no Docker, and every sandbox boots from it in about a second:
  `beambox-build-base:beambox-base-1` (`BASE_SNAPSHOT` in `core.rs`). `Core::base_snapshot` builds it once: boot
  `debian:trixie-slim` as a hidden `beambox-build-base` sandbox, run `agent::base_setup()`, stop it, save the disk
  snapshot, and delete the build sandbox (~4 min). The app starts that build in the background at launch, so it's
  usually done before the first create; a create during the build waits for it (the toast says so), and the CLI
  says "Preparing Beambox's base sandbox" when it has to wait. A lock file, `snapshot-build.lock` in the app data
  dir, makes the app and CLI processes build it once.
- **The snapshot holds packages only:** the desktop's (`install.sh packages`), Node 24 (NodeSource), tmux, git, curl
  and every harness from npm (`@anthropic-ai/claude-code`, `@openai/codex`, `opencode-ai`; latest at build time).
  What configures them comes from the app at each create, so a new Beambox version changes them in new sandboxes
  without a rebuild: `agent::sandbox_setup()` (the `Spec::setup` script, run before the desktop starts) puts the
  desktop's files in place (`install.sh files`) and the agent's `beambox-open`, and `create` writes
  `/opt/beambox/mcp.js` and the harness's MCP config (`/root/.claude.json`, `/root/.codex/config.toml`,
  `/root/.config/opencode/opencode.json`). Bump the member only when `base_setup` or `install.sh`'s package list
  changes. `Core::prune_snapshots` deletes every other `beambox-build-…` snapshot (older versions built one per
  kind, about 4 GiB each) when the app starts and after a build. Sandboxes made from them keep working: their
  disks are their own. The SDK lists a snapshot's member and group separately; Beambox joins them into the
  `<group>:<member>` name.
- **Defaults:** plain sandboxes 1 vCPU and 1 GiB (enough for the harnesses every sandbox carries); plain desktops 2 vCPUs and 4 GiB, since Chromium crawls on
  one; agent sandboxes 2 vCPUs and 2 GiB (4 GiB with a desktop). The app runs `start-desktop` after each boot of a
  desktop. A plain sandbox's terminal is bash.
- **What's in a desktop:** see [`packages/desktop-image`](../../packages/desktop-image). Xvnc, openbox with
  the Beambox theme, a tint2 top bar, the Plank dock, xterm and Chromium.
- `node scripts/cargo.mjs test real_ -- --ignored --test-threads=1` checks this against real microVMs: a desktop, a
  Claude Code sandbox (`claude --version`, MCP config, `mcp.js` answers `initialize`, tmux session in
  `/workspace`, no key on disk, take over and hand back) and its desktop variant (Chromium, VNC). It
  needs `MSB_PATH`, `MSB_LIBKRUNFW_PATH` and `MSB_HOME` pointing at `src-tauri/binaries/` and a short `MSB_HOME`
  such as `~/.beambox`.

## Desktop image

Desktops come from [`@repo/desktop-image`](../../packages/desktop-image): its `image/` folder holds `install.sh`
and the theme files. The Rust code embeds that folder (`DESKTOP_FILES` in `agent.rs`): the base snapshot runs
`install.sh packages`, and each new desktop runs `install.sh files`, so the app and the package's standalone image
share one definition. The app doesn't pull that image.

## Smoke test (manual, per OS)

Run on a fresh machine (macOS Apple Silicon, Ubuntu with KVM, Windows 11) for every release:

1. Install the bundle (`.dmg` → drag to Applications; `.deb`/`.AppImage`; `.msi`) and open Beambox.
2. If a hypervisor card shows, follow it (Windows: **Enable Windows Hypervisor Platform**, reboot). Otherwise
   none shows.
3. **New box** → **Just a computer** → **Build the box**. The card narrates its boot, then says Ready for you.
4. Click its screen. The Terminal is already showing a `sandbox-1:/#` prompt.
5. Pass if the prompt appears within 4 clicks. Also check: `echo hi` works; with no key stored, a **Claude Code**
   box with the job "list the files here" shows **Sign in** in the Waiting for you tray; **Open terminal** shows
   Claude's sign-in, the sign-in page opens in your browser, and after signing in Claude works on the job. A second
   Claude Code box starts signed in. The **AGENT / YOU** lever pauses and resumes it.
6. **⋯ → Install the beambox command**, then in a new terminal: `beambox list`, `beambox exec sandbox-1 -- uname -a`,
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
