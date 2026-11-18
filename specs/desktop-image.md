---
status: built      # draft | approved | built | shipped
size: large
created: 2026-11-18T00:10Z
shipped:
diff:
new_deps: 0
bounces: 0
review_findings: 5
---

# Desktop image: the Beambox desktop as a standard OCI image

## Goal
The macOS-like Beambox desktop (Xvnc, openbox theme, top bar, dock, Chromium) becomes a public, multi-arch OCI
image that anyone can run, and that Beambox pulls instead of building the desktop on first use. Today the first
Desktop sandbox spends ~1.5 min installing packages from Debian on the user's machine.

## Behaviour
- **One install script.** `apps/desktop/images/desktop/install.sh` installs the desktop on `debian:trixie-slim`
  from the files beside it (today's `desktop_install()` in `agent.rs`, moved into a checked-in script). The
  Dockerfile, Beambox's local snapshot build and agent desktops all run this same script, so there is one
  definition of the desktop.
- **Chromium on both architectures.** Google Chrome is dropped, because its terms don't allow redistributing it in
  an image. The browser setup (`--no-sandbox`, system title bar, policies) stays as it is.
- **The image:**
  - `apps/desktop/images/desktop/Dockerfile`: `FROM debian:trixie-slim`, copy the folder, run `install.sh`.
  - `CMD ["beambox-desktop"]` starts the desktop (`start-desktop`) and stays in the foreground on Xvnc, so
    `docker run -p 5900:5900 ghcr.io/OWNER/beambox-desktop` gives a VNC desktop on localhost:5900.
  - It has OCI labels (source, licence, version).
- **CI:** `.github/workflows/desktop-image.yml`.
  - It builds `linux/amd64` and `linux/arm64` on native GitHub runners (`ubuntu-24.04`, `ubuntu-24.04-arm`) with
    buildx.
  - It smoke-tests each architecture: run the container, wait for VNC, and grab a frame that must be mostly
    non-black. That reuses the frame grabber, checked in as `scripts/vnc-frame.mjs`.
  - It pushes by digest and merges a multi-arch manifest to `ghcr.io/OWNER/beambox-desktop:<version>` and
    `:latest`.
  - It runs only on tags `desktop-v<version>` (changed 2026-11-18: pull requests no longer build it).
  - It publishes with the built-in `GITHUB_TOKEN`, and the package is set to public.
- **Beambox pulls it.**
  - The Desktop template's image becomes `ghcr.io/OWNER/beambox-desktop:<version>`, defined in one constant:
    `DESKTOP_IMAGE` in `core.rs`. microsandbox pulls it anonymously, and later Desktop sandboxes reuse the cached
    layers.
  - If the pull fails (offline, registry down, not published yet), create falls back to today's local snapshot
    build from the same `install.sh`, and says so in the toast or CLI output.
  - Agent desktops keep building locally (out of scope).
- **`OWNER` placeholder** until you give me the GitHub repository: in `DESKTOP_IMAGE`, the workflow's image name and
  the README, all in one place each. Nothing is pushed or published until you say so.

## Acceptance criteria
- [ ] The local snapshot build and the Dockerfile both run `install.sh`. A test checks that the script Rust runs is
      `install.sh` plus its files, and that the Dockerfile `RUN`s `install.sh` from the copied folder.
- [ ] `install.sh` installs Chromium and never downloads Google Chrome (test on the script).
- [ ] The image runs standalone: `beambox-desktop` starts Xvnc, openbox, the top bar and the dock, and stays in the
      foreground (checked by the CI smoke test on both architectures, and once on this Mac in a microVM booted from
      the locally built rootfs).
- [ ] The workflow builds both architectures natively, smoke-tests each, pushes a multi-arch manifest only on
      `desktop-v*` tags, which are its only trigger (a test reads the workflow file for its triggers).
- [ ] Creating a Desktop sandbox uses `DESKTOP_IMAGE`. When creating from it fails, create builds the local
      snapshot instead and reports the fallback. Both paths are tested on the fake backend.
- [ ] A Desktop sandbox created from the image looks the same as one from the local build (screenshot check, run
      by hand once the image is published).
- [ ] The README documents running the image with Docker/Podman, the release steps (tag `desktop-v<version>`) and
      the fallback.

## Reuse
- docker buildx and the official actions (`docker/setup-buildx-action`, `docker/login-action`,
  `docker/build-push-action`, `docker/metadata-action`) for the multi-arch build. No custom build tooling.
- microsandbox's own registry pulls for the app side, already used for `alpine:3.22` and `debian:trixie-slim`.
- The existing snapshot build as the fallback, unchanged except that it runs `install.sh`.

## Decisions and defaults
- Image name `beambox-desktop` and version `4`, matching the current desktop snapshot member. Bump both together
  when `images/desktop/` changes. Pinning the app to the image digest comes after the first publish.
- The image runs as root, like Beambox sandboxes. Docker users get the same `--no-sandbox` browser, and their
  container is the isolation.
- VNC has no password, matching Beambox, which publishes only on 127.0.0.1. The README tells Docker users to
  publish the port on `127.0.0.1` only (`-p 127.0.0.1:5900:5900`).
- No GitHub repo exists yet. Everything uses `OWNER`, and I add the remote and push only when you give me the name
  and say so.
- Built (by /build):
  - This change itself edits `images/desktop/`, so by the rule above the first image is version **5**:
    `DESKTOP_IMAGE` = `ghcr.io/OWNER/beambox-desktop:5`, desktop member `beambox-desktop-5`, first tag `desktop-v5`.
    Agent desktop members go to `-6`. Plain agent members stay at `-5`, because their setup didn't change.
  - `theme.sh` and the `browser` wrapper are folded into `install.sh`. The menu and dock launch `chromium`
    directly: Debian's wrapper already reads `/etc/chromium.d/beambox` for `--no-sandbox`. `install.sh` does its
    own `apt-get update` and clean, and adds `procps`, because `start-desktop` and `beambox-desktop` use `pgrep`.
  - The workflow pushes through buildx's `outputs` (`push-by-digest=true,name-canonical=true,push=true`), the
    documented way to push by digest. Since it runs only on tags, no step needs a tag `if:`.
  - The fallback notice travels as an optional `notice` field on the created sandbox. The app shows it as a warning
    toast, and the CLI prints it to stderr. A plain desktop no longer prints "Preparing the desktop" up front,
    because whether the image is cached isn't known.
  - A name that's already taken is refused before any pull or build. Names and ports are reserved under a short
    lock and held as pending, so booting and pulling run unlocked and don't block other creates.
  - Only creating the sandbox itself falls back, after deleting whatever the failed attempt left. Once the local
    desktop snapshot exists, desktops boot from it without asking the registry. It's the same desktop at the same
    version, and this avoids a registry timeout on every desktop while offline.
  - `vnc-frame.mjs` retries (up to `--wait`) until a frame is at least `--min`% non-black, because the background
    is drawn a moment after VNC starts listening.

## Out of scope
- Images for agent desktops (Claude Code, Codex, OpenCode).
- Docker Hub, image signing (cosign), SBOM and provenance attestations.
- Creating the GitHub repository, pushing, tagging a release, or making the package public. Those are your steps
  (I'll list them).
- A browser-based (noVNC) viewer inside the image. Docker users bring a VNC viewer.

## After build: moved into a package (2026-11-18, at the user's request)
- The image now lives in its own workspace, `packages/desktop-image` (`@repo/desktop-image`): `image/` is the Docker
  build context (`install.sh`, `Dockerfile`, theme files) and `src/vnc-frame.ts` the frame grabber, exported as
  `grabFrame`. `apps/desktop` depends on it and embeds `image/` in Rust. Paths in this spec that say
  `apps/desktop/images/desktop/` or `scripts/vnc-frame.mjs` now mean those.
- Agent desktops are built on the desktop image (only the agent is added). If it can't be pulled, they install the
  same desktop on Debian as before. Agent desktop members go to `-7`.
