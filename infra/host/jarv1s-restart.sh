#!/usr/bin/env bash
set -euo pipefail

# #1748 — performs the restart the app asked for. Runs on the HOST, not in a container.
#
# The app cannot restart anything itself; giving the app container the Docker socket would
# make any code execution inside it root on the host. Instead the app creates a zero-byte
# sentinel in the control directory and this script, triggered by jarv1s-restart.path,
# does the restart. The sentinel's CONTENTS are never read — there is no parsed value here,
# so there is nothing for a compromised app to inject. Its whole vocabulary is "yes".
#
# Installed by install-restart-unit.sh. See
# docs/superpowers/specs/2026-08-19-admin-restart-app-button.md.

CONTROL_DIR="${JARVIS_HOST_CONTROL_DIR:?set JARVIS_HOST_CONTROL_DIR to the infra/control path}"
CONTAINER="${JARVIS_RESTART_CONTAINER:-moss}"
SENTINEL="${CONTROL_DIR}/restart-requested"
ALIVE="${CONTROL_DIR}/watcher-alive"

# Prove the watcher ran, so the API can render the button enabled rather than guessing.
touch "$ALIVE"

if [[ ! -e "$SENTINEL" ]]; then
  echo "jarv1s-restart: no request pending, nothing to do"
  exit 0
fi

# Delete the sentinel BEFORE restarting, never after. If the restart fails and the file is
# still there, the path unit re-triggers on the next change and the box restart-loops. This
# ordering means a failed restart fails once, loudly, and stops.
rm -f "$SENTINEL"

echo "jarv1s-restart: restarting container ${CONTAINER}"
if docker restart "$CONTAINER"; then
  echo "jarv1s-restart: ${CONTAINER} restarted"
else
  echo "jarv1s-restart: FAILED to restart ${CONTAINER}" >&2
  exit 1
fi
