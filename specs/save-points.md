---
status: approved       # draft | approved | built | shipped
size: large
created: 2026-11-18T18:20Z
shipped:
diff:
new_deps: 0
bounces: 0
review_findings: 0
---

# Save points: list, copy from and rewind to a box's snapshots

## Goal
A box's snapshots become "save points" that people can see and use: start a copy from one to try another way, or
rewind the box to one. Today a snapshot's name is shown once in a toast and can't be used from the app.

## Behaviour
- **Core** (`core.rs`, shared with the CLI):
  - `save_points(name)` lists the snapshots `<name>-<unix seconds>` (exactly that, so `a` doesn't match
    `a-1-<secs>`), newest first, as `{ snapshot, takenAt }`.
  - `copy_from(snapshot)` boots a new box named `<name>-copy-<n>` (via `free_name`) from that disk.
  - `rewind(name, snapshot)` saves the box's login (`save_login_of`), deletes it, and boots a new box with the same
    name from the snapshot. Its save points stay.
  - `remove_save_point(snapshot)` deletes one. `delete(name)` also removes that box's save points.
  - Copies and rewinds keep the source's template, CPUs, memory, harness, folder, network and guest ports. Host
    ports are picked again with `pick_ports`. The agent starts fresh without a task (`restart_agent`), because
    snapshots hold the disk, not the memory.
- **Info.** `SandboxInfo` gains `mount: Option<String>` and `network: String`, read in `micro.rs` from the stored
  config the same way `ports` are (the fake backend keeps them from `Spec`). The UI shows the folder on the card and
  in the box view.
- **Tauri commands and `api.ts`:** `save_points`, `copy_from`, `rewind`, `remove_save_point`.
- **CLI:**
  - `beambox snapshots <name>` lists save points.
  - `beambox copy <snapshot>` starts a copy from one.
  - `beambox rewind <name> <snapshot>` rewinds a box, after asking y/N unless `--yes`.
- **UI** (`SavePoints.tsx`, mounted in the box view that `shelf-ui` builds, below the screen):
  - A strip of save points as tilted photo cards (number, time), oldest to newest, ending at "NOW". It reloads
    after **Save point** and polls nothing.
  - Selecting a card shows **Try another way from here** (`copyFrom`), **Rewind to here** and **Remove**. Rewind and
    Remove are press-and-hold, reusing shelf-ui's hold key.
  - Rewind plays the rewind sound and the screen's rewind animation. A copy appears on the shelf as a booting box
    whose card says "Copy of `<name>` · from save point `<n>`".
  - With no save points it reads: "No save points yet. Take one before a risky step, then rewind to it or start a
    copy from it."

## Acceptance criteria
- [ ] `save_points("a")` returns `a-200` then `a-100`, and not `a-1-300`, `ab-100` or the base snapshot (fake backend).
- [ ] `copy_from("a-100")` creates `a-copy-1` from snapshot `a-100` with `a`'s CPUs, memory, harness, template,
      mount, network and guest ports, on free host ports, and restarts its agent.
- [ ] `rewind("a", "a-100")` saves `a`'s login, deletes `a` and recreates `a` from `a-100` with the same settings.
      `a-100` and `a-200` still exist afterwards.
- [ ] `delete("a")` removes `a-100` and `a-200` but not `ab-100`.
- [ ] `rewind` and `copy_from` with an unknown snapshot fail with a message naming it.
- [ ] `SandboxInfo` reports `mount` and `network` for a created box.
- [ ] CLI: `snapshots`, `copy` and `rewind --yes` call the core and print the result. `rewind` without `--yes`
      reads "n" and does nothing.
- [ ] UI: the strip lists `savePoints` in order. A held **Rewind to here** calls `rewind(name, snapshot)`, and a short
      press doesn't. **Try another way from here** calls `copyFrom(snapshot)`. Save point reloads the strip.

## Reuse
`SandboxBackend::{list_snapshots, remove_snapshot, snapshot}`, `Spec.snapshot` (create already boots from one),
`Core::{free_name, pick_ports, restart_agent, save_login_of, boot, reserve}`, clap. shelf-ui's hold key, sounds
and tokens. No new dependencies.

## Decisions and defaults
- Copies are named `<name>-copy-<n>`. Rewind keeps the name, so the shelf shows the same box with a fresh boot.
- Save points are disk-only. The UI says that the agent starts over on the saved files.
- Throwing a box away also removes its save points (after the undo window, as the delete runs only then).
- Builds in parallel with `shelf-ui`. Before shipping it rebases on it and mounts `SavePoints` in the box view.

## Out of scope
- Memory snapshots, so the agent's conversation is not resumed. Screenshots on save point cards. Automatic save
  points. Save points of the base snapshot or of other users' snapshots.
