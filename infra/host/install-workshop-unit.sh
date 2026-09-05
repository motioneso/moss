#!/usr/bin/env bash
set -euo pipefail

# Optional host installation. Run as the existing deployment/Docker account, never sudo.
# Requires its user systemd manager to survive logout (Linger=yes). Does not enable builds.
CONTROL_DIR="${MOSS_WORKSHOP_CONTROL_DIR:?absolute private control directory required}"
STATE_DIR="${MOSS_WORKSHOP_STATE_DIR:?absolute private host-only journal directory required}"
IMAGE="${MOSS_WORKSHOP_IMAGE:?immutable locally available sha256 image ID required}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
export CONTROL_DIR STATE_DIR IMAGE SCRIPT_DIR UNIT_DIR
[[ "$(id -u)" == 1000 ]] || { echo 'The current transport profile requires deployment UID 1000.' >&2; exit 1; }
[[ "$(loginctl show-user "$(id -u)" -p Linger --value)" == yes ]] || { echo 'An existing lingering user manager is required.' >&2; exit 1; }
command -v python3 >/dev/null
command -v docker >/dev/null
systemctl --user show --property=Version >/dev/null
docker image inspect "$IMAGE" >/dev/null
if systemctl --user is-active --quiet moss-workshop-control.service; then
  echo 'Stop the Workshop controller and finish its owned runs before updating installation.' >&2
  exit 1
fi
python3 - <<'PY'
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import sys

os.umask(0o077)
control = Path(os.environ['CONTROL_DIR'])
state = Path(os.environ['STATE_DIR'])
image = os.environ['IMAGE']
if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
    raise ValueError('immutable image required')
python = Path(sys.executable).resolve()
docker = Path(shutil.which('docker')).resolve()
for path in [control, state, python, docker]:
    if not re.fullmatch(r'/[a-zA-Z0-9_./-]+', str(path)) or path.resolve() != path:
        raise ValueError('canonical absolute deployment paths required')
if state == control or state in control.parents or control in state.parents:
    raise ValueError('control and host-only state must be separate directories')
for path in [control, state]:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('private owned directory required')
# Never overwrite a journal: old claims and image identity are replay fences.
if any(state.iterdir()):
    raise ValueError('state must be empty for installation; preserve old journals on updates')
key = control / 'key'
with key.open('xb') as stream:
    stream.write(secrets.token_bytes(32))
config = {'state':str(state), 'control':str(control), 'image':image,
          'prefix':'workshop-' + secrets.token_hex(8), 'docker':str(docker), 'userSystemd':True}
(state / 'config.json').write_text(json.dumps(config))
shutil.copyfile(Path(os.environ['SCRIPT_DIR']) / 'workshop-control.py', state / 'controller.py')
unit_dir = Path(os.environ['UNIT_DIR'])
unit_dir.mkdir(parents=True, exist_ok=True)
unit = unit_dir / 'moss-workshop-control.service'
with unit.open('x') as stream:
    stream.write(f'''[Unit]
Description=Workshop fixed-operation host control

[Service]
Type=simple
ExecStart={python} {state}/controller.py --config {state}/config.json
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=yes
StandardOutput=null
StandardError=null

[Install]
WantedBy=default.target
''')
PY
systemctl --user daemon-reload
systemctl --user enable --now moss-workshop-control.service
echo 'Workshop control installed. Application execution remains disabled.'
