#!/usr/bin/env bash
set -euo pipefail

# #1748 — one-time host install for the admin "Restart app" button's other half.
#
# Run this once per deployment, as a user who can write systemd units and talk to Docker:
#
#   sudo JARVIS_INFRA_DIR=~/Jarv1s/infra ./infra/host/install-restart-unit.sh
#
# It writes a systemd path unit watching infra/control/ and a oneshot service that runs
# jarv1s-restart.sh. Until it has run, the button in Settings renders disabled with the
# reason — the feature degrades to an honest no-op, never to a silent lie.

INFRA_DIR="${JARVIS_INFRA_DIR:?set JARVIS_INFRA_DIR to the absolute path of the infra/ directory}"
CONTROL_DIR="${INFRA_DIR}/control"
SCRIPT_PATH="${INFRA_DIR}/host/jarv1s-restart.sh"
CONTAINER="${JARVIS_RESTART_CONTAINER:-moss}"
UNIT_DIR="${JARVIS_SYSTEMD_DIR:-/etc/systemd/system}"

[[ -d "$CONTROL_DIR" ]] || { echo "control directory not found: $CONTROL_DIR" >&2; exit 1; }
[[ -x "$SCRIPT_PATH" ]] || chmod +x "$SCRIPT_PATH"

cat > "${UNIT_DIR}/jarv1s-restart.service" <<EOF
[Unit]
Description=Restart the Jarv1s app container on request (#1748)

[Service]
Type=oneshot
Environment=JARVIS_HOST_CONTROL_DIR=${CONTROL_DIR}
Environment=JARVIS_RESTART_CONTAINER=${CONTAINER}
ExecStart=${SCRIPT_PATH}
EOF

cat > "${UNIT_DIR}/jarv1s-restart.path" <<EOF
[Unit]
Description=Watch for a Jarv1s restart request (#1748)

[Path]
PathExists=${CONTROL_DIR}/restart-requested
Unit=jarv1s-restart.service

[Install]
WantedBy=multi-user.target
EOF

# The app container writes the sentinel as its own (non-root) user, so the bind-mounted
# control directory must be writable by it. Group-and-other write on one directory holding
# zero-byte flag files is the whole exposure.
chmod 0777 "$CONTROL_DIR"

systemctl daemon-reload
systemctl enable --now jarv1s-restart.path

# Touch the liveness marker so the API can enable the button immediately, rather than only
# after the first restart has already happened.
touch "${CONTROL_DIR}/watcher-alive"

echo "installed: jarv1s-restart.path watching ${CONTROL_DIR} for container ${CONTAINER}"
