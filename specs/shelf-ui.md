---
status: built          # draft | approved | built | shipped
size: large
created: 2026-11-18T18:20Z
shipped:
diff:
new_deps: 0
bounces: 0
review_findings: 10
---

# Shelf UI: Beambox as a shelf of tactile boxes

## Goal
Non-developers can create, watch, steer and throw away agent sandboxes without knowing what a vCPU or a guest port
is. The UI moves from stock shadcn cards to the approved "Shelf of Boxes" prototype: a hardware look, physical
keys, plain words and sound. It runs on today's `Api` (no Rust changes). Reference:
`specs/assets/shelf-prototype.html`, a copy of the prototype. Its simulated data and the states we can't detect
yet are not part of this spec.

## Behaviour
- **Look.** New tokens in `index.css` for both themes (light aluminium, dark graphite): chassis, key, screen and bezel
  colours, one accent (orange `#ff5b14`) and LED colours, all taken from the prototype. Fonts are system stacks
  only: `ui-monospace` for uppercase labels, `system-ui` for everything else. Add a `key` variant to `button.tsx`
  (raised, with 3 px of travel on `:active` / `aria-pressed`) and use it everywhere. Motion uses the springs in
  `motion.ts`, and `prefers-reduced-motion` turns it off.
- **Words.** A sandbox is a "box" and a harness is "who works in it". Stop is "Sleep", Start is "Wake", fork is
  "Try another way", snapshot is "Save point" and delete is "Throw away". Take over and Hand back become the lever.
- **Header.** The `beambox` wordmark, then an LCD panel with counts (Boxes, Working, For you), a mute key, a ⋯ key
  and an orange **New box** key (shortcut `N`). The ⋯ key opens Settings (credentials), Licences and "Install the
  beambox command", which are today's popovers moved into it.
- **Box state** (LED and word), worked out from `status`, `agentStatus` and whether the box needs a sign-in. The
  order below is also the shelf's sort order. Motion's `layout` animates boxes moving between places.
  - Needs you:
    - "Agent stopped": running, and the agent has exited. LED amber.
    - "Crashed": status `crashed`. LED red.
    - "Sign in": made by this window with credentials missing, until you open its Terminal or dismiss it.
  - "Getting ready": booting. LED white, blinking.
  - "Working": running, agent running. LED green, breathing.
  - "You're driving": the agent is frozen. LED orange.
  - "Ready for you": running, with no agent.
  - "Asleep": stopped. LED off, and the screen's shutter is closed.
- **Waiting for you tray**, above the shelf, shown only while there are items. One card per box that needs you,
  each with a key:
  - Agent stopped: **Start agent again** (`restartAgent`).
  - Crashed: **Wake** (`start`).
  - Sign in: **Open terminal**, plus a ✕ to dismiss it.
- **Box card.** A screen that shows the last 9 lines of `logs`, run through `plainText` and polled every 2 s while
  the box is running. Below it: the LED and word, how long it has been running, a helper chip, the name, the task
  (two lines) and the tool row (Sleep/Wake, Save point, Try another way, Throw away). Clicking the screen opens the
  box.
- **Narrated boot.** A booting card's screen shows named stages, chosen from the options: Unpacking the box, Waking
  the computer, Moving in `<folder>`, Switching on the screen, Getting `<harness>` ready, Reading the job. It also
  shows a 24-segment bar that fills faster near the end and the stage's log line. The stages advance on a 1.2 s
  timer, but the last one holds until the create settles. When `baseReady()` is false, the first stage reads
  "Preparing Beambox (first time only, a few minutes)".
- **New box sheet** replaces the ▾ popover. It has three numbered steps:
  1. **Who works in it?** Four keycaps: Claude Code, Codex CLI, OpenCode and Just a computer. Each shows "Signed
     in" or "Sign in once" from `missingCredentials`.
  2. **What's the job?** A textarea and four example chips. Hidden for Just a computer.
  3. **What does it get?**
     - A folder: click for `pickFolder`, or drop one using Tauri's `onDragDropEvent` paths, added to `api.ts` as
       `onFolderDrop`.
     - A screen switch, which sets `desktop`.
     - A 4-stop size fader: Light 1 CPU / 1 GB, Standard 2 / 2 GB, Roomy 2 / 4 GB, Heavy 4 / 8 GB. The default is
       Light for Just a computer, Standard with an agent, and Roomy when the screen is on. Turning the screen on
       raises the size to Roomy, and the fader can't go below Roomy while it's on.
     - Network: Internet / Offline / Internet + my network, mapping to `public` / `none` / `all`, each with a
       one-line explanation.

  "More options" holds the name, the web ports and the optional key field from today's form. A one-line summary
  sits next to **Build the box** (`⌘↵`), which is always enabled: the job is optional, and without one the agent starts and waits in its terminal.
- **Box view** (replaces `SandboxView`):
  - Header: a back key (`Esc`), the LED, the name and a summary line.
  - The **AGENT / YOU lever**, for agent boxes. Flipping to YOU calls `setTakeover(true)`. Flipping back opens a
    "Hand back" dialog with an optional note. A non-empty note is typed into the agent's session (`terminalOpen`,
    then `terminalInput(note + "\r")`, then `terminalClose`) before `setTakeover(false)`.
  - A mode switch: Screen (desktop boxes), Terminal, Files, Web previews (today's Ports and port iframes). It sits
    above one large bezelled screen. While you drive, the bezel turns orange.
  - Below the screen: the lifecycle tools, and **Start agent again** when the agent has stopped.
- **Throw away** is a press-and-hold key: 1.2 s, keyboard Space/Enter held, a ring that fills and springs back if
  released early, and a rising tone. When it completes, today's 5 s undo toast follows.
- **Sound.** `sound.ts` synthesises press, clunk, ready, needs-you, sleep, wake, shutter, trash and hold with Web
  Audio. It does nothing without an `AudioContext` (jsdom), stays silent until the first user gesture, and plays
  nothing while muted. Mute is kept in `localStorage` under `beambox.muted`. It plays "ready" when a create settles
  and "needs-you" when a box enters the tray.

## Acceptance criteria
- [ ] Boxes render sorted in the state order above, each with the right state word. Fake `Api`, one box per state.
- [ ] A box whose agent has exited appears in the tray, and **Start agent again** calls `restartAgent` with its name.
- [ ] A crashed box's tray key calls `start`. A sign-in item leaves when that box's Terminal opens, or on ✕.
- [ ] The tray isn't rendered when nothing needs you.
- [ ] The New box sheet sends `create` with `harness`, `task`, `mount`, `desktop`, `cpus`, `memoryMib`, `network`,
      `name` and `ports` mapped as specified. Choosing Heavy with the screen on gives `cpus: 4, memoryMib: 8192, desktop: true`.
- [ ] Turning the screen on with Light selected moves the fader to Roomy. **Build the box** is enabled with or
      without a job.
- [ ] `N` opens the sheet (not while typing), `Esc` closes it, and `⌘↵` builds.
- [ ] A booting card shows the stage names for its options, and "Preparing Beambox…" when `baseReady` is false.
- [ ] Flipping the lever calls `setTakeover(name, true)`. Handing back with a note sends the note plus `\r` to
      `terminalInput`, then calls `setTakeover(name, false)`. Without a note it only calls `setTakeover`.
- [ ] Throw away fires `delete` only after a full hold (fake timers): releasing at 600 ms fires nothing. The undo toast
      still cancels the delete.
- [ ] Sleep calls `stop` and Wake calls `start`. An asleep box shows its shutter (`aria-label="Asleep"`).
- [ ] The mute key toggles and persists `beambox.muted`. Rendering without `AudioContext` throws nothing.
- [ ] Existing behaviour is kept: the `beambox desktop` open event, the hypervisor card, credentials, Files
      upload/download and the Desktop resolution menu (their tests updated to the new words, not removed).

## Reuse
React, Tailwind v4, shadcn (`button`, `popover`, `tabs`), `motion` (`layout`, springs), `sonner` for the undo toast,
`@tauri-apps/api` `onDragDropEvent`, Web Audio and `localStorage`. The existing `Terminal`, `Desktop`, `Files`, `Logs`,
`Ports` and `plainText` are restyled, not rewritten. No new dependencies.

## Decisions and defaults
- Plain-language words above and the size presets above. No custom web fonts (the app must work offline).
- The box view has no activity side panel this round: the screen takes the full width.
- Mini-screens use `logs` for desktop boxes too, with no live VNC thumbnail, to keep the cost to one poll per card.
- Boot stages are timed and narrated, not reported by the backend. Only the end of the create is real.
- Sounds are on by default at a low gain. Mute affects sound only.
- The Save point timeline is in `save-points.md`. This spec keeps today's Save point (toast with the name).
- Handing back with a note calls `setTakeover(false)` first, then types the note as one line, after tmux's first
  redraw. During take-over tmux shows the
  shell window (`tmux new-window`), so a note typed before hand-back would run as a shell command. After hand-back
  window 0 (the agent) is active again and the agent reads it.
- `onFolderDrop` is wired to `onDragDropEvent`, but `tauri.conf.json` keeps `dragDropEnabled: false`: turning it on
  stops HTML5 file drops in the webview, which Files upload needs. Until Files uploads by path, folders are lent by
  clicking (`pickFolder`), and the sheet only says "Click to choose a folder"; dropping one starts working once
  the flag is flipped.
- A sign-in box goes to the tray instead of opening its terminal straight away (the tray's key opens it).
- The job is shown only for boxes made by this window; the backend doesn't keep it. Others say who works in them.
- "How long it has been running" counts from when this window first saw the box run.
- The box view drops the Logs tab: the card's screen shows the log. Its Web previews mode holds today's Ports list,
  and opening a port shows it inside the screen.
- The hold key is `HoldKey` in `src/keys.tsx` (reusable, with `Tool`, `Led` and `Icon`). The box view leaves room
  for panels below its screen (`BoxView.tsx`, marked with a comment).
- The job is optional (changed after testing): an agent box without one starts its harness with no first prompt.

## Out of scope
- Detecting an agent that waits for input or has finished ("Ready to review"), Allow/Deny buttons, and the
  plain-language activity feed. These need harness hooks.
- Save point listing, rewinding and copying from a save point (`specs/save-points.md`).
- Rust or CLI changes, a live VNC preview on cards, and onboarding/tour.
