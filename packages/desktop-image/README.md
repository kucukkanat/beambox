# @repo/desktop-image

The Beambox desktop as a container image: a macOS-like Linux desktop over VNC (openbox, a top bar, a dock and
Chromium, plus a file manager) on `debian:trixie-slim`, for `linux/amd64` and `linux/arm64`. It is published as
`ghcr.io/OWNER/beambox-desktop` (`OWNER` stays a placeholder until the GitHub repository exists).

Beambox ([`apps/desktop`](../../apps/desktop)) doesn't pull the image; it runs the same `install.sh` in two steps.
Its one base snapshot runs `install.sh packages` once, and each new desktop runs `install.sh files`, so changing
a file here reaches new sandboxes without a rebuild. A change to the package list needs a new base snapshot: bump
the member in `BASE_SNAPSHOT` (`apps/desktop/src-tauri/src/core.rs`).

## Run it

```bash
docker run --rm -p 127.0.0.1:5900:5900 ghcr.io/OWNER/beambox-desktop:9
```

Podman takes the same arguments. Then open `vnc://127.0.0.1:5900` in a VNC viewer (macOS Screen Sharing, TigerVNC,
Remmina).
- **No VNC password**, like in Beambox, so publish the port on `127.0.0.1` only.
- **Runs as root** with Chromium's `--no-sandbox`: the container (or microVM) is the isolation.
- **Foreground process.** `CMD ["beambox-desktop"]` runs `start-desktop`, then stays in the foreground until Xvnc exits.

### In a browser (opt-in)

```bash
docker run --rm -e WEB_PORT=6080 -p 127.0.0.1:6080:6080 ghcr.io/OWNER/beambox-desktop:9
```

The log prints a link such as `http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=remote&path=websockify%3Ftoken%3D…`.
If you published the port on another host port, change it in the link. `resize=remote` makes the desktop follow the
browser window.
- **The token is the lock.** websockify doesn't check which site a connection comes from, so without it any web
  page you have open could reach the desktop on localhost. It only connects requests that carry the random token
  in `/etc/beambox/web-token`; the link has it.
- **Plain VNC is unchanged:** 5900 still has no password and still needs to stay on `127.0.0.1`.
- Without `WEB_PORT` nothing extra runs. Beambox's `beambox create --web` turns it on by writing
  `/etc/beambox/web-port` and `/etc/beambox/web-token`, so it lasts across restarts.

To build it locally: `docker build -t beambox-desktop packages/desktop-image/image`.

## What's in `image/`

The Docker build context. The `Dockerfile` runs `install.sh` twice, so the packages get a layer of their own:
1. It copies `install.sh` alone and runs `install.sh packages`.
2. It copies the folder and runs `install.sh files`.

A change to any other file in `image/` then rebuilds, and makes Beambox pull, only the small second layer. Changing
`install.sh` rebuilds both. `ARG VERSION` comes after both RUNs, since a changed build arg reruns every RUN after it.
One consequence: a release that changes only files keeps the Debian packages it had last time.

- **`install.sh`:** the packages, the files below put in place, the openbox and dock setup, dark GTK. With no
  argument it does both steps; Beambox runs it that way when it builds a desktop locally.
  - Before installing, it adds dpkg filters (`/etc/dpkg/dpkg.cfg.d/beambox-desktop`) that leave out about 105 MB
    the desktop never uses: translations, Papirus sizes other than 16, 48 and 64 px (the dock's icons are 48 px,
    magnified to 72), Papirus-Light, all Inter weights except Regular, Medium, SemiBold and Bold, and Chromium's
    Vulkan validation layer.
  - The filters stay in place, so packages an agent installs later also skip their translations.
- **`start-desktop`:** starts the desktop in the background and returns once VNC listens on 5900. Beambox runs it
  after every boot.
- **Xvnc:** TigerVNC's `Xvnc` is the X server and the VNC server in one. It resizes to the viewer instead of being
  stretched, and sends changes as they're drawn.
- **openbox** with the `Beambox` theme (`openbox/`): dark title bars, centred Inter titles, and traffic-light
  buttons on the left (`CIML`), drawn as coloured circle bitmaps. No screen margins: openbox applies them to the
  dock too, which lifted it off the bottom edge. The dock's own strut keeps new and maximised windows clear of it.
- **A `tint2` top bar** (`tint2rc`): "● Beambox" opens `rofi` (also Super+Space), plus the active window's name. No
  clock, because the sandbox runs on UTC.
- **The Plank dock** (`plank.dconf`): the browser, Files and Terminal, pinned only, magnified on hover.
  - It's set through dconf, so it needs `dbus-launch`, `dconf-gsettings-backend` and `hide-mode='none'` as a
    string enum.
  - Papirus icons need `librsvg2-common`.
- **`xcompmgr -c -C`** for shadows and the see-through bar and dock. picom loses track of windows under Xvnc.
- **Look and feel:** a gradient background (`hsetroot`), dark GTK, and xterm in DejaVu Sans Mono (`Xresources`).
  `start-desktop` sets `LANG=C.UTF-8` (built into glibc), so xterm and tmux show the UTF-8 that agents print
  instead of reading it as Latin-1.
  WenQuanYi Micro Hei (`fonts-wqy-microhei`, about 5 MB) covers Chinese, Japanese and Korean text in the browser,
  where the full Noto CJK set would add about 100 MB.
- **`desktop-watch`:** runs in the background and keeps the background and the dock fitted to the screen. The screen
  changes size whenever the viewer resizes it (noVNC's `resize=remote`, a resized VNC window), and neither follows on
  its own: X tiles the old background across the new space, and Plank stays centred on the old width. Every second
  it checks the size with `xrandr`, then redraws the background and restarts Plank when the size has changed, or
  when Plank isn't running. It waits for the old Plank to exit first: a new one started while the old one is still on
  the session bus can't register and exits, so two quick resizes used to leave no dock.
  - **Wallpaper:** right-click an image in Files and choose **Set as Wallpaper**, or run `set-wallpaper <image>`.
    Either copies it to `/root/.config/beambox/wallpaper`, and within a second it replaces the gradient, cropped to
    fill the screen (`hsetroot -cover`). It stays across restarts and resizes. Delete that file to get the gradient
    back. The menu item is a FileManager-Actions entry (`set-wallpaper.desktop`, installed in
    `/usr/share/file-manager/actions`) that PCManFM shows for a single selected image. PCManFM only shows such
    entries through libfm's `gtk-menu-actions` module, which is in `libfm-modules`, a recommended package that
    `--no-install-recommends` would skip, so `install.sh` names it.
  - `start-desktop` starts one D-Bus session for the desktop (`dbus-launch --sh-syntax`), so a restarted Plank still
    reaches its settings in dconf.
  Debian's `debian-xterm.desktop` and `debian-uxterm.desktop` are removed for our `applications/xterm.desktop`.
- **Files: PCManFM** (`applications/files.desktop`), a small GTK file manager that opens on `/root`. Its own
  `pcmanfm.desktop` and the desktop-icons preferences are removed: it never draws the desktop, openbox does.
- **The browser: Debian's Chromium** on both architectures. Google Chrome's terms don't allow redistributing it in
  an image.
  - `--no-sandbox` (`chromium-flags`), because Chromium won't start as root with its own sandbox.
  - The system title bar (`browser-preferences.json`).
  - No sign-in, sync or bookmarks bar (`browser-policies.json`). The `BrowserSignin: 0` policy is used instead of
    `--no-first-run`, which would skip the title bar setting.
- **The web desktop:** noVNC's page (`/usr/share/novnc`) and websockify's Python, unpacked from Debian's `novnc`
  and `python3-websockify` packages without installing them. Installing them would bring Node.js, numpy, Redis and
  HTTP clients, about 130 MB, and the token-file plugin needs none of these. websockify runs on the image's Python 3
  and only warns that it's slower without numpy, which only affects input from the browser.
- **`vncconfig`** relays text copied on the desktop to the viewer's clipboard.
- **`beambox-desktop`:** the image's foreground `CMD`.

## API

| Export | Description |
| --- | --- |
| `grabFrame(host, port)` | Connects to a VNC server without a password, reads one raw frame and returns `{ width, height, lit, total }` (`lit` = pixels that aren't black) |

`src/vnc-frame.ts` is also a command that checks a desktop is drawn. It retries for up to `--wait` seconds until a
frame is at least `--min`% non-black, and exits 1 otherwise:

```bash
node packages/desktop-image/src/vnc-frame.ts <port> [--host 127.0.0.1] [--wait 60] [--min 20]
```

It works against any desktop: Docker's, or a Beambox sandbox's host port.

## CI and releases

`.github/workflows/desktop-image.yml` runs only when you push a `desktop-v<version>` tag:
1. Builds each architecture with buildx on its own native runner (`ubuntu-24.04`, `ubuntu-24.04-arm`).
2. Smoke-tests it: runs the container, waits for `vnc-frame.ts` to see at least 20% non-black, then requires
   Xvnc, openbox, tint2 and Plank to be running.
3. Pushes each architecture by digest and merges them into `:<version>` and `:latest`, with the built-in
   `GITHUB_TOKEN`.

Release a new image whenever `image/` changes:
1. Bump the tag in this README's examples.
2. Merge, then `git tag desktop-v<version> && git push origin desktop-v<version>`.
3. The first time only, set the package's visibility to public on GitHub (Packages → `beambox-desktop` → Package
   settings), so microsandbox and Docker can pull it without signing in.

Before the first release, replace `OWNER` (lowercase, as GHCR requires) in the workflow's `IMAGE`,
the Dockerfile's source label and the READMEs.

## Scripts

```bash
npm test -w @repo/desktop-image          # Dockerfile and workflow checks, the VNC frame grabber
npm run typecheck -w @repo/desktop-image
npm run build -w @repo/desktop-image     # emits dist/ (production only)
```
