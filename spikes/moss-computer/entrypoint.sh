#!/bin/bash
set -euo pipefail
umask 077

mkdir -p "$HOME/Files" "$HOME/.mozilla/firefox/moss" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
# Only a transient viewer socket is removed; home/profile data stays intact.
rm -f /socket/viewer.sock

children=()
finish() {
  trap - EXIT TERM INT
  if ((${#children[@]})); then
    kill "${children[@]}" 2>/dev/null || true
    wait "${children[@]}" 2>/dev/null || true
  fi
}
trap finish EXIT
trap 'exit 0' TERM INT

Xtigervnc :0 -geometry 1280x800 -depth 24 -SecurityTypes None \
  -localhost yes -rfbport 5900 -nolisten tcp &
children+=("$!")

ready=false
for ((attempt=0; attempt<100; attempt++)); do
  if xdpyinfo >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then
  echo 'Computer display failed to become ready' >&2
  exit 1
fi

dbus-run-session -- xfce4-session &
children+=("$!")
# No web root here: the trusted gateway serves packaged noVNC assets.
websockify --unix-listen=/socket/viewer.sock --unix-listen-mode=0600 \
  --heartbeat=30 127.0.0.1:5900 &
children+=("$!")

# Losing a core service terminates the candidate rather than leaving a dead viewer.
wait -n "${children[@]}"
exit 1
