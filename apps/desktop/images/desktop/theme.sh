# Run once while building the desktop snapshot: a dark window theme, larger title fonts, xterm as the
# terminal, and a panel with a terminal launcher and the open windows. No clock: the sandbox runs on UTC, so it
# would disagree with the computer's own.
sed -i 's|<name>Clearlooks</name>|<name>Onyx</name>|; s|<size>8</size>|<size>10</size>|g' /etc/xdg/openbox/rc.xml
sed -i 's|x-terminal-emulator|xterm|g' /etc/xdg/openbox/menu.xml
sed -i '/^launcher_item_app = /d; s|^# Launcher$|# Launcher\nlauncher_item_app = xterm.desktop|; s|^taskbar_name = 1|taskbar_name = 0|; s|^panel_items = LTSC|panel_items = LTS|' \
  /etc/xdg/tint2/tint2rc
