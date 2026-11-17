---
status: approved       # draft | approved | built | shipped
size: large
created: 2026-11-17T14:41Z
shipped:
diff:
new_deps: 0
bounces: 0
review_findings: 0
---

# Beambox desktop: GUI workspaces for AI agents on microsandbox

## Goal
One download gives you a desktop app where AI agents get their own microVM sandboxes, and you can watch them
and step in through a GUI. There is nothing else to install, no setup, and every sandbox is as small as it can be.

## Behaviour
- **App** (`apps/desktop`, Tauri 2): macOS on Apple Silicon (.dmg), Linux x64/arm64 with KVM (AppImage + .deb) and
  Windows 11 x64/arm64 (.msi). The app bundles microsandbox as a Rust crate plus the `msb` sidecar and `libkrunfw`,
  with `MSB_PATH`/`MSB_LIBKRUNFW_PATH` set and `MSB_HOME` pointed at the app data dir, so nothing is installed system-wide.
- **First launch** has no onboarding. In the background the app checks the hypervisor and pre-pulls the base image.
  If the hypervisor is missing, the only prompt is a single card:
  - Windows: "Enable Windows Hypervisor Platform" (runs the elevated command, then asks for a reboot).
  - Linux: a `/dev/kvm` hint.
- **Home**: a grid of sandbox cards showing status dot, name, template, CPU/RAM sparkline and which agent created it.
  "New sandbox" is a single click with defaults (Base template, 1 vCPU, 256 MiB, auto name). A popover holds the
  optional settings: template, folder mount and network policy. Cards support start, stop, fork, snapshot and delete.
  Delete is undoable for 5 s.
- **Sandbox view**:
  - Tabs: Terminal (xterm.js over SDK exec/attach), Files (SDK filesystem: browse, drag-drop upload, download),
    Logs (live stream), Ports (each published port opens in an in-app tab).
  - Desktop tab: shown only for the Desktop template. noVNC in the webview, through a Rust TCP→WebSocket proxy.
  - Activity feed: every command an agent runs, live, with a "Take over" button that pauses the agent's MCP calls.
- **Agent connection**: the app binary run with `--mcp` is a stdio MCP server, built on the same Rust core. Its tools
  are `sandbox_create`, `sandbox_list`, `sandbox_exec`, `file_read`, `file_write`, `sandbox_stop` and
  `sandbox_delete`. "Connect an agent" copies a ready-to-paste config for Claude Code, Cursor and generic MCP.
  Sandboxes it creates are labelled `beambox.agent=<client name>` and show up in the GUI live.
- **Templates** are OCI images built from `apps/desktop/images/*/Dockerfile`:
  - `base`: Alpine plus busybox, ≤ 10 MB unpacked. The guest needs no GUI agent; the terminal and files go through the SDK.
  - `desktop`: Alpine, Xvfb, x11vnc and openbox, ≤ 120 MB unpacked, 512 MiB default RAM.
- **UI**: shadcn/ui on Tailwind v4, plus Motion for microinteractions:
  - card enter/exit and layout animations
  - status-dot pulse while booting
  - optimistic start/stop with a spring
  - toast for undo
  - all of it respects `prefers-reduced-motion`, with light and dark themes

## Acceptance criteria
- [ ] Rust core behind a `SandboxBackend` trait: create/list/start/stop/fork/delete work against a fake backend (`cargo test`).
- [ ] Startup resolves the bundled `msb` + `libkrunfw` paths and `MSB_HOME` per OS; it never reads `~/.microsandbox`.
- [ ] Hypervisor check reports ok, missing or unsupported (Intel Mac) for each OS from injected probes. Each state maps to one UI card.
- [ ] One-click create uses the defaults above and reaches `running` without any extra input.
- [ ] A host port collision on publish retries the next free port. The UI shows the actual port.
- [ ] TCP→WebSocket proxy relays bytes both ways and closes when either side closes (test with in-memory streams).
- [ ] MCP `--mcp` mode lists the 7 tools. `sandbox_create` labels the sandbox with the client name. `sandbox_exec`
      returns stdout, stderr and the exit code. Calls are rejected with a clear error while "Take over" is active.
- [ ] Activity feed receives exec events from MCP calls in order (event-bus test).
- [ ] Frontend (Vitest + Testing Library): the create button calls the backend once with defaults. Delete shows an
      undo toast and does not delete if undo is clicked within 5 s. With reduced motion there are no animations
      longer than 0 ms. The Desktop tab is shown only for the `desktop` template.
- [ ] Image size checks in CI script: `base` ≤ 10 MB, `desktop` ≤ 120 MB unpacked.
- [ ] Smoke test (manual, per OS, documented in README): fresh machine → install → first sandbox terminal prompt in ≤ 3 clicks.

## Reuse
- Tauri 2 (window, sidecar, bundling, signing).
- `microsandbox` Rust crate (lifecycle, exec, fs, metrics, logs, snapshots, fork, ports, labels).
- `rmcp` (official Rust MCP SDK).
- React + Vite, shadcn/ui, Tailwind v4, `motion`, `@xterm/xterm`, `@novnc/novnc`, `sonner` (shadcn's toast).
- Vitest + Testing Library for the UI, `cargo test` for Rust. Turbo `test`/`typecheck` scripts call both.
- Add these to "Default libraries" in AGENTS.md.

## Decisions and defaults
- Supported platforms follow microsandbox: Apple Silicon only (no Intel Mac), Windows 11 only (not Windows 10).
- A Rust crate in the repo (`apps/desktop/src-tauri`) is accepted as an exception to the TS-only template.
- Pin microsandbox at 0.7.x. It is beta, so upgrades are deliberate.
- The guest gets no in-guest agent. The terminal and files use the SDK, which keeps `base` near plain Alpine.
- noVNC is bundled in the app, not the image. The image doesn't carry websockify; the Rust proxy replaces it.
- Ports bind only to 127.0.0.1. The default network policy is `public` (internet yes, host LAN no).
- Licensing:
  - libkrunfw is LGPL/GPL-2.0: ship its source link and licence in an in-app "Licences" page and in the repo.
  - App licence: MIT.
- macOS: sign with the hypervisor entitlement. Test early whether `disable-library-validation` is needed.
- Template images are published to GHCR under the repo owner, and the app pulls them by digest.

## Out of scope
- Intel Macs, Windows 10, and Linux without KVM.
- Release CI, notarization credentials, auto-update and crash reporting (a follow-up spec).
- A cloud/hosted microsandbox backend. Multi-user or remote access.
- Running agents inside the app. Agents connect over MCP; we don't ship an LLM client.
- Xpra and per-window GUI streaming, audio, GPU acceleration and clipboard sync beyond noVNC's own.
- Custom template authoring UI (Dockerfiles in the repo only).
