#!/bin/sh
# Installs the probe host service and the hourly scan timer as user units, for 7 days.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
state="$HOME/.local/share/moss-outlook-s1"
unit="$HOME/.config/systemd/user"
mkdir -p "$unit" "$state"
date -d '+7 days' +%s > "$state/expires"
cat > "$unit/moss-outlook-s1-host.service" <<UNIT
[Unit]
Description=Outlook S1 probe host (temporary, 7 days)

[Service]
Environment=PYTHONPATH=$here
ExecStart=/usr/bin/python3 -B $here/host.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
cat > "$unit/moss-outlook-s1-scan.service" <<UNIT
[Unit]
Description=Outlook S1 probe scan

[Service]
Type=oneshot
Environment=PYTHONPATH=$here
ExecStart=/usr/bin/python3 -B $here/scan.py ${S1_RELAY_PORT:?set S1_RELAY_PORT} scan-menu,mail
TimeoutStartSec=300
UNIT
cat > "$unit/moss-outlook-s1-scan.timer" <<UNIT
[Unit]
Description=Outlook S1 probe, hourly for 7 days

[Timer]
OnCalendar=hourly
Persistent=false

[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now moss-outlook-s1-host.service moss-outlook-s1-scan.timer
