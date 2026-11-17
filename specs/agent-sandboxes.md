---
status: approved      # draft | approved | built | shipped
size: large
created: 2026-11-17T19:10Z
shipped:
diff:
new_deps: 0
bounces: 0
review_findings: 0
---

# Agent sandboxes: each agent gets its own computer

## Goal
Agents don't live outside a sandbox. Each sandbox is one agent's computer: Beambox installs the harness inside it,
injects Beambox's MCP server into that harness, and starts it on a task. The CLI and the app only manage
sandboxes and let you watch, talk to and pause the agent.

## Behaviour
- **Create an agent sandbox:** `beambox create [name] --harness claude-code|codex|opencode --task "…" [--desktop]
  [--mount DIR]`. The app's New sandbox popover gets the same fields: Harness, Task and a Desktop switch. Without
  `--harness`, create makes a plain sandbox, as today.
- **Image:** agent sandboxes run `debian:trixie-slim`. Each (harness, desktop) pair is built on first use into a
  local snapshot, like today's Desktop template, then reused.
  - Every agent snapshot gets Node 24, the harness's standard install, tmux, git, curl, ca-certificates and
    `/opt/beambox/mcp.js`, with the harness's MCP config pointing at it.
  - Desktop snapshots add today's desktop (Xvnc, openbox, tint2, xterm) on Debian, plus Google Chrome on x86-64
    or Debian's Chromium on arm64, where Google doesn't ship Chrome.
- **Starting the agent:** after boot, the harness runs inside the tmux session `agent`, with the task as its first
  prompt, `/workspace` as its working directory, and its credential in the environment.
  - The app's Terminal tab attaches to that session for agent sandboxes, so you see the agent and can type to it.
  - `beambox attach <name>` does the same from a terminal.
- **Credentials:** stored once and injected at start.
  - **App:** Settings → Credentials.
  - **CLI:** `beambox credentials set anthropic|openai` (reads stdin), `beambox credentials list` (names only) and
    `beambox credentials remove`.
  - Keys live in the OS keychain. They're passed only as the harness process's environment
    (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`) and never written to the sandbox's disk.
- **MCP server:** a new TypeScript workspace, `apps/sandbox-mcp`, on the official MCP SDK, bundled into one file
  and copied into each agent snapshot. It speaks stdio to the harness. It ships with one tool, `sandbox_info`
  (sandbox name, harness, whether a desktop is available), as the place where custom tools get added later.
- **Take over** freezes the harness's process group (SIGSTOP), so you can use the terminal and desktop
  undisturbed. **Hand back** resumes it (SIGCONT). Available as the app button and as `beambox takeover`.
- **Removed:**
  - The host-side MCP server (`beambox --mcp`, `beambox mcp`, `mcp.rs`) and the **Connect an agent** popover.
    **Install the beambox command** moves to the app's header.
  - The CLI's `--agent` flag, `Core::agent_call`, `activity.jsonl` and the activity feed. You watch the agent
    through its terminal instead.

## Acceptance criteria
- [ ] `create --harness claude-code --task "fix the tests"` boots from the claude-code agent snapshot, labels the
      sandbox with the harness, and starts the harness in tmux session `agent` with that task and `/workspace`.
- [ ] The credential is in the harness process's environment only: no file write, exec argument or log line
      contains it (checked on the fake backend's recorded calls).
- [ ] Creating with a harness whose credential is missing fails before anything boots, naming the
      `beambox credentials set` command to run.
- [ ] Each (harness, desktop) snapshot is built once and reused. Two concurrent creates build it once.
- [ ] The generated MCP config for each harness (Claude Code user config, Codex `config.toml`, OpenCode
      `opencode.json`) registers `node /opt/beambox/mcp.js` as `beambox`.
- [ ] `apps/sandbox-mcp` answers `initialize` and `tools/list` over stdio, and `sandbox_info` returns the
      sandbox's details (node:test with the SDK's in-memory transport).
- [ ] Take over stops the harness's process group and Hand back continues it. CLI and app share one
      implementation.
- [ ] `beambox credentials list` prints names only. `set` reads from stdin and never echoes.
- [ ] The app's New sandbox popover passes harness, task and desktop to create. Its Terminal tab attaches to the
      agent session for agent sandboxes. "Connect an agent" is gone.
- [ ] `beambox mcp`, `--mcp` and `--agent` are rejected as unknown.
- [ ] Opt-in real-VM test: a claude-code sandbox boots, `claude --version` runs, the MCP config is present, and
      `mcp.js` answers `initialize`. A desktop variant also has Chrome or Chromium and VNC listening.

## Reuse
- The existing snapshot machinery (`Core::desktop_snapshot`, `override_snapshot`) is generalised to a
  (harness, desktop) key instead of written anew.
- The harness's official installer; tmux for the shared session; `@modelcontextprotocol/sdk` for the server.
- The `keyring` crate (macOS Keychain, Windows Credential Manager, Secret Service), instead of our own encrypted
  store.
- `esbuild` (devDependency) bundles `mcp.js`, so the sandbox needs no `npm install`.

## Decisions and defaults
- Plain sandboxes (no harness) stay on Alpine, which is the smallest. Only agent sandboxes use Debian.
- One agent per sandbox. Agent sandboxes default to 2 vCPUs and 2 GiB (4 GiB with a desktop), since harnesses
  and Chrome are heavy. Network defaults to `public`, which the harness needs for its API.
- Subscription logins work only where the harness accepts a token by env (Claude Code's
  `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`). Browser-based logins inside the sandbox aren't supported.
- The snapshot builds pin nothing in the first version: the harness's latest release at build time. Rebuild by
  bumping the member name, as today.
- Stopping and starting an agent sandbox restarts the harness in a new tmux session, without the task (the
  harness keeps its own history).

## Out of scope
- Custom MCP tools beyond `sandbox_info`, including screenshot, click and type tools for the desktop.
- Gemini CLI and other harnesses; several agents in one sandbox; agent-to-agent communication.
- Browser-based harness logins, and syncing credentials between machines.
- Pinning or auto-updating harness versions.
- Signed bundles, and Linux and Windows smoke tests.
