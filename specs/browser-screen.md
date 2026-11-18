---
status: approved     # draft | approved | built | shipped
size: large
created: 2026-11-18T23:52Z
shipped:
diff:
new_deps: 0
bounces: 0
review_findings: 0
---

# Browser-only screen, with the full desktop one switch away

## Goal
A box with a screen boots with just headless Chromium, streamed to the Screen tab over the DevTools protocol, with
no X server, window manager or VNC. That's lighter (no Xvnc, openbox or VNC encoding: about 100 MiB and the X start
on top of the bare desktop), and agents get the same browser on a DevTools port they can drive. The full desktop
stays one switch away, per box.

## Behaviour
- **Guest (`packages/desktop-image`):** `/etc/beambox/screen` holds `browser` or `desktop` (absent = `browser`).
  - `start-screen` runs after every boot (in place of `start-desktop` in `micro.rs`). `browser` runs
    `start-browser`: `chromium --headless=new --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0
    --user-data-dir=/root/.config/chromium --restore-last-session` plus `CHROMIUM_FLAGS`, and returns once
    `:9222/json/version` answers. `desktop` runs `start-desktop`, then the same Chromium headed on `DISPLAY=:0`.
  - `beambox-screen browser|desktop` switches: stop Chromium with SIGTERM and wait (so its session is saved), write
    the file, then start the other mode. Going to `browser` also stops Xvnc, openbox, xterm, desktop-watch and the
    `beambox-dock` processes.
  - The Docker image's `CMD` stays the full desktop (`SCREEN=desktop`).
- **App, Rust:** desktop boxes also publish guest port 9222 on 127.0.0.1. `screencast.rs` connects to it
  (`tokio-tungstenite`), runs `Page.startScreencast` (JPEG) on the chosen tab, acks frames and forwards them on a
  Tauri `Channel`. Commands: `browser_open(name, width, height)`, `browser_input(id, event)`
  (`Input.dispatchMouseEvent`, `dispatchKeyEvent`, `insertText`), `browser_resize` (`Emulation.setDeviceMetricsOverride`,
  1:1 with the tab), `browser_navigate`/`back`/`forward`/`reload`, `browser_tabs`/`new_tab`/`switch_tab`, and
  `screen_mode(name)` / `set_screen_mode(name, mode)` (`cat` / `beambox-screen` through exec).
- **App, UI:** the Screen tab shows `Browser.tsx` (an `<img>` of the frames under a toolbar: back, forward, reload,
  address field, tabs, new tab) for `browser` boxes and today's `Desktop.tsx` for `desktop` ones. A **Full desktop**
  switch next to **Full window** flips the mode, with "Switching…" on the screen meanwhile.
- **CLI:** `beambox screen <name> [browser|desktop]` prints or sets the mode.

## Acceptance criteria
- [ ] A new box with a screen boots in browser mode: no `/etc/beambox/screen`, boot runs `start-screen` (fake backend).
- [ ] `start-screen` with no file starts headless Chromium with `--remote-debugging-port=9222` and starts no Xvnc;
      with `desktop` it runs `start-desktop` and a headed Chromium with the same `--user-data-dir` (shell test, stubs).
- [ ] `beambox-screen desktop` then `browser`: SIGTERM to Chromium before the other starts, file written, X processes
      stopped on the way back (shell test).
- [ ] Both modes pass `--restore-last-session` and the same profile, so tabs and logins carry over (shell test).
- [ ] `screencast.rs` against a local fake DevTools server on an ephemeral port: starts the screencast, forwards
      each frame, acks it, and maps a click and a typed key to the right `Input.*` messages (`cargo test`).
- [ ] The Screen tab of a browser box shows the frames and toolbar; Enter in the address field calls
      `browserNavigate`; **Full desktop** calls `setScreenMode(name, "desktop")` and then shows the VNC screen (Vitest).
- [ ] `beambox screen a desktop` sets the mode; `beambox screen a` prints it (CLI test).
- [ ] CI smoke test: the image with `SCREEN=browser` answers `/json/version` on 9222 and runs no Xvnc.
- [ ] READMEs of both workspaces describe the modes, the port and the switch.

## Reuse
`tokio-tungstenite`, `serde_json`, Tauri `Channel` (as the terminal does), Chromium's own headless mode and DevTools
protocol, the existing port publishing and fake backend. No new dependencies.

## Decisions and defaults
- Frames are JPEG at quality 70, at the tab's size; acked one at a time, so a slow link drops frames, not lag.
- Only `page` targets are tabs; a `window.open` popup becomes a tab.
- DevTools listens on 0.0.0.0 inside the box so the host can reach it through the published port; the host side is
  127.0.0.1 only, like VNC. Web pages on the host can't connect: Chromium rejects WebSocket origins it wasn't told
  about, and the app's client sends none.
- Copy and paste: `insertText` from the host clipboard on ⌘V; copying out of the page is out of scope.
- Existing desktop boxes keep working: a box made before this has no 9222 port, so it stays `desktop` and the
  switch is hidden.
- Agents use `127.0.0.1:9222` inside the box in both modes; the MCP server's box info says it's there.

## Out of scope
- File downloads and uploads through the browser view, and the browser's own dialogs (print, permission prompts
  beyond what headless accepts).
- Audio, and copying from the page to the host clipboard.
- A browser view for boxes without a screen, and any change to the full desktop itself.
