#!/bin/sh
# Installs the Beambox desktop on debian:trixie-slim from the files beside this script, as root. The Dockerfile,
# Beambox's local snapshot build and agent desktops all run it: TigerVNC's Xvnc (X server and VNC server in one),
# openbox with the Beambox theme (macOS-style buttons on the left), a tint2 top bar, the Plank dock, xterm, Inter,
# dark GTK and Chromium, set up to run as root, with the system title bar and no sign-in or bookmarks bar.
#
# `install.sh packages` only installs the packages and `install.sh files` only puts the files beside it in place, so
# the Dockerfile can keep the packages in a layer that changing a file here doesn't rebuild. No argument does both.
set -e
src=$(cd "$(dirname "$0")" && pwd)
if [ "$1" != files ]; then
  # dpkg leaves out what the desktop never uses: translations, Papirus sizes other than 16, 48 and 64 px (the dock
  # draws 48 px icons, magnified to 72), all but four Inter weights, and Chromium's Vulkan debugging layer. That's
  # about 105 MB and 60,000 files fewer to unpack.
  mkdir -p /etc/dpkg/dpkg.cfg.d
  cat > /etc/dpkg/dpkg.cfg.d/beambox-desktop <<'FILTERS'
path-exclude=/usr/share/locale/*
path-include=/usr/share/locale/locale.alias
path-exclude=/usr/share/icons/Papirus-Light/*
path-exclude=/usr/share/icons/Papirus*/18x18*
path-exclude=/usr/share/icons/Papirus*/22x22*
path-exclude=/usr/share/icons/Papirus*/24x24*
path-exclude=/usr/share/icons/Papirus*/32x32*
path-exclude=/usr/share/fonts/opentype/inter/*
path-include=/usr/share/fonts/opentype/inter/Inter-Regular.otf
path-include=/usr/share/fonts/opentype/inter/Inter-Medium.otf
path-include=/usr/share/fonts/opentype/inter/Inter-SemiBold.otf
path-include=/usr/share/fonts/opentype/inter/Inter-Bold.otf
path-exclude=/usr/lib/chromium/libVkLayer_khronos_validation.so*
FILTERS
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends tigervnc-standalone-server tigervnc-tools openbox tint2 plank \
    xcompmgr rofi xterm x11-xserver-utils hsetroot fonts-inter fonts-dejavu-core papirus-icon-theme librsvg2-common \
    dbus-x11 dconf-cli dconf-gsettings-backend net-tools procps ca-certificates chromium
  apt-get clean
  rm -rf /var/lib/apt/lists/*
fi
[ "$1" = packages ] && exit 0

install -D -m 755 "$src/start-desktop" /usr/local/bin/start-desktop
install -D -m 755 "$src/beambox-desktop" /usr/local/bin/beambox-desktop
install -D -m 644 "$src/Xresources" /etc/beambox/Xresources
install -D -m 644 -t /usr/share/themes/Beambox/openbox-3 "$src"/openbox/*
install -D -m 644 "$src/tint2rc" /etc/xdg/tint2/tint2rc
install -D -m 644 "$src/applications/xterm.desktop" /usr/share/applications/xterm.desktop
install -D -m 644 "$src/chromium-flags" /etc/chromium.d/beambox
install -D -m 644 "$src/browser-preferences.json" /etc/chromium/master_preferences
install -D -m 644 "$src/browser-policies.json" /etc/chromium/policies/managed/beambox.json

# openbox: the Beambox theme, buttons on the left, Inter, the app launcher on Super+Space.
sed -i 's|<name>Clearlooks</name>|<name>Beambox</name>|; s|<titleLayout>NLIMC</titleLayout>|<titleLayout>CIML</titleLayout>|' \
  /etc/xdg/openbox/rc.xml
sed -i 's|<name>sans</name>|<name>Inter</name>|g; s|<size>8</size>|<size>10</size>|g' /etc/xdg/openbox/rc.xml
sed -i 's|<keyboard>|<keyboard>\n    <keybind key="W-space"><action name="Execute"><command>rofi -show drun</command></action></keybind>|' \
  /etc/xdg/openbox/rc.xml
sed -i 's|x-terminal-emulator|xterm|g; s|x-www-browser|chromium|g' /etc/xdg/openbox/menu.xml
# Ours (xterm.desktop, "Terminal") replaces Debian's two, which the app launcher would list as XTerm and UXTerm.
rm -f /usr/share/applications/debian-xterm.desktop /usr/share/applications/debian-uxterm.desktop

# The dock, set through dconf: launchers named after the windows' class, so a running app shares its launcher's icon.
mkdir -p /etc/dconf/profile /root/.config/plank/dock1/launchers
printf 'user-db:user\nsystem-db:local\n' > /etc/dconf/profile/user
install -D -m 644 "$src/plank.dconf" /etc/dconf/db/local.d/10-plank
printf '[PlankDockItemPreferences]\nLauncher=file:///usr/share/applications/chromium.desktop\n' \
  > /root/.config/plank/dock1/launchers/browser.dockitem
printf '[PlankDockItemPreferences]\nLauncher=file:///usr/share/applications/xterm.desktop\n' \
  > /root/.config/plank/dock1/launchers/terminal.dockitem
dconf update

# Dark GTK, so the browser matches.
mkdir -p /etc/gtk-3.0
printf '[Settings]\ngtk-theme-name=Adwaita-dark\ngtk-application-prefer-dark-theme=1\ngtk-icon-theme-name=Papirus-Dark\ngtk-font-name=Inter 10\ngtk-cursor-theme-name=Adwaita\n' \
  > /etc/gtk-3.0/settings.ini
