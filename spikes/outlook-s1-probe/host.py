"""S1 probe host: egress policy socket plus the browser container, kept running.

Reuses the candidate's egress policy unchanged and the candidate's Podman flags, with
one extra writable mount for the DevTools socket. Logs only state changes.
"""
import asyncio
import json
import os
from pathlib import Path
import subprocess

from common import CTL, IMAGE, NAME, STATE, TRANSPORT, VOLUME, record
from chromium_seccomp import chromium_policy
from egress import Egress


def podman(*args, check=True):
    return subprocess.run(['podman', *args], stdin=subprocess.DEVNULL, capture_output=True,
                          text=True, check=check, timeout=60)


def ensure_container(seccomp):
    exists = podman('container', 'exists', NAME, check=False).returncode == 0
    if exists:
        running = podman('inspect', '--format', '{{.State.Running}}', NAME).stdout.strip()
        if running != 'true':
            podman('start', NAME)
            record('container restarted (session-only cookies are lost)')
        return
    podman('volume', 'create', VOLUME)
    podman('run', '--detach', '--pull', 'never', '--name', NAME,
           '--network', 'none', '--userns', 'keep-id:uid=1000,gid=1000',
           '--user', '1000:1000', '--read-only', '--cap-drop', 'all',
           '--security-opt', 'no-new-privileges',
           '--security-opt', 'seccomp=' + str(seccomp),
           '--pids-limit', '256', '--memory', '1g', '--cpus', '1',
           '--log-driver', 'none', '--volume', VOLUME + ':/profile',
           '--volume', str(TRANSPORT) + ':/egress:ro',
           '--volume', str(CTL) + ':/ctl:rw',
           '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', IMAGE)
    record('container created')


async def main():
    os.umask(0o077)
    for folder in (STATE, TRANSPORT, CTL):
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    default = json.loads(Path('/usr/share/containers/seccomp.json').read_text())
    seccomp = STATE / 'seccomp.json'
    seccomp.write_text(json.dumps(chromium_policy(default)))
    path = TRANSPORT / 'connect.sock'
    if path.exists():
        path.unlink()
    egress = Egress(())
    await egress.listen(str(path))
    os.chmod(path, 0o600)
    record('host up')
    try:
        while True:
            try:
                await asyncio.to_thread(ensure_container, seccomp)
            except Exception:
                record('container check failed')
            await asyncio.sleep(30)
    finally:
        await egress.revoke()


if __name__ == '__main__':
    asyncio.run(main())
