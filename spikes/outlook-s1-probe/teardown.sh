#!/bin/sh
# Removes the probe: timer, services, container, profile volume, state folder and ports.
set -u
systemctl --user disable --now moss-outlook-s1-scan.timer moss-outlook-s1-host.service 2>/dev/null
pkill -f '[o]utlook-s1-probe/host.py'
pkill -f '[v]iewer.py'
rm -f "$HOME"/.config/systemd/user/moss-outlook-s1-*
systemctl --user daemon-reload
podman rm --force --ignore moss-outlook-s1
podman volume rm --force moss-outlook-s1-profile
podman rmi --force localhost/moss-outlook-s1:probe
rm -rf "$HOME/.local/share/moss-outlook-s1"
devports release 5183
devports release 5184
