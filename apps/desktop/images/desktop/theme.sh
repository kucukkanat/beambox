# Run once while building a desktop snapshot, after the files in images/desktop/ are in place: the Beambox
# openbox theme with macOS-style buttons on the left, Inter, the app launcher on Super+Space, the browser and
# terminal in the dock, the browser set up to run as root, and dark GTK (so the browser matches).
chmod +x /usr/local/bin/start-desktop /usr/local/bin/browser
sed -i 's|<name>Clearlooks</name>|<name>Beambox</name>|; s|<titleLayout>NLIMC</titleLayout>|<titleLayout>CIML</titleLayout>|' \
  /etc/xdg/openbox/rc.xml
sed -i 's|<name>sans</name>|<name>Inter</name>|g; s|<size>8</size>|<size>10</size>|g' /etc/xdg/openbox/rc.xml
sed -i 's|<keyboard>|<keyboard>\n    <keybind key="W-space"><action name="Execute"><command>rofi -show drun</command></action></keybind>|' \
  /etc/xdg/openbox/rc.xml
sed -i 's|x-terminal-emulator|xterm|g; s|x-www-browser|/usr/local/bin/browser|g' /etc/xdg/openbox/menu.xml
# Ours (xterm.desktop, "Terminal") replaces Debian's two, which the app launcher would list as XTerm and UXTerm.
rm -f /usr/share/applications/debian-xterm.desktop /usr/share/applications/debian-uxterm.desktop
# The browser: Chromium (arm64) or Google Chrome (x86-64), with the system title bar, no sign-in or bookmarks bar.
if [ -d /opt/google/chrome ]; then
  launcher=google-chrome
  sed -i 's|^Exec=/usr/bin/google-chrome-stable|Exec=/usr/bin/google-chrome-stable --no-sandbox --test-type|' \
    /usr/share/applications/google-chrome.desktop
  cp /etc/beambox/browser-preferences.json /opt/google/chrome/initial_preferences
  mkdir -p /etc/opt/chrome/policies/managed
  cp /etc/beambox/browser-policies.json /etc/opt/chrome/policies/managed/beambox.json
else
  launcher=chromium
  cp /etc/beambox/browser-preferences.json /etc/chromium/master_preferences
  mkdir -p /etc/chromium/policies/managed
  cp /etc/beambox/browser-policies.json /etc/chromium/policies/managed/beambox.json
fi
# The dock: launchers named after the windows' class, so a running app shares its launcher's icon.
mkdir -p /root/.config/plank/dock1/launchers
printf '[PlankDockItemPreferences]\nLauncher=file:///usr/share/applications/%s.desktop\n' "$launcher" \
  > /root/.config/plank/dock1/launchers/browser.dockitem
printf '[PlankDockItemPreferences]\nLauncher=file:///usr/share/applications/xterm.desktop\n' \
  > /root/.config/plank/dock1/launchers/terminal.dockitem
dconf update
mkdir -p /etc/gtk-3.0
printf '[Settings]\ngtk-theme-name=Adwaita-dark\ngtk-application-prefer-dark-theme=1\ngtk-icon-theme-name=Papirus-Dark\ngtk-font-name=Inter 10\ngtk-cursor-theme-name=Adwaita\n' \
  > /etc/gtk-3.0/settings.ini
