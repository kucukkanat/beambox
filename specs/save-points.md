---
status: built          # draft | approved | built | shipped
size: large
created: 2026-11-18T18:20Z
shipped:
diff:
new_deps: 0
bounces: 0
review_findings: 7
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
- Built in parallel with `shelf-ui`, then rebased on it: `SavePoints` sits below the screen in `BoxView`, Rewind and
  Remove are shelf-ui's `HoldKey` (1.2 s, with an icon prop added), the box view's **Save point** key bumps a
  counter that reloads the strip, and rewind plays `sound.rewind()` while the screen runs a tape-scrub animation
  (`.rewinding` in `index.css`) until the box is back, then the view remounts on the new VM.
- **Try another way from here** goes back to the shelf, where the copy shows as a booting pending card whose line
  reads "Copy of `<name>` · from save point `<n>`" until `copy_from` returns.
- The card and the box view show the lent folder's name (full path on hover).
- A save point is a snapshot whose member is `<box>-<digits>` and whose group isn't a `beambox-build-` one; the
  box is everything before the last `-`. The app and CLI name it by its member (`a-100`); the core looks up its
  `<group>:<member>` reference.
- `rewind` refuses a save point of another box ("no save point named ab-100 for a").
- Copies and rewinds run no `setup` (the saved disk has it) and, like a new box, copy in the harness's latest
  login when no key is stored, then start the agent without a task.
- `delete` deletes the box first, then the save points of every box that no longer exists, ignoring failures:
  microsandbox refuses a snapshot another box still boots from, so it stays and goes with a later delete. Without
  that, a new box with the old name would inherit it.
- A copy's name is picked under the same lock as other creates, so concurrent copies get `-copy-1` and `-copy-2`.
  A failed boot after a rewind's delete says the box was deleted; its save points stay.
- After a rewind the app remounts the box view (same name, new VM) so the terminal and desktop reconnect.
- `network` is stored as the `beambox.network` label (the stored policy can't be mapped back to a name); boxes
  made before that report `public`. `mount` is read from the config's `/workspace` bind mount.
- `beambox rewind` without `--yes` asks on stderr; anything but `y` prints "Left `<name>` as it is" and exits 0.

## Out of scope
- Memory snapshots, so the agent's conversation is not resumed. Screenshots on save point cards. Automatic save
  points. Save points of the base snapshot or of other users' snapshots.
