"""Rootless Podman experiment, not an installable Moss service."""
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

IMAGE = 'localhost/moss-outlook-runtime-spike:local'


def command(*args, data=None, check=True):
    return subprocess.run(['podman', *args], input=data, text=True,
                          capture_output=True, timeout=30, check=check)


class Runtime:
    def __init__(self):
        self.resources = {}
        self.directory = tempfile.TemporaryDirectory(prefix='moss-runtime-probe-')
        # Preserve the host Podman default except chroot. Chromium's nested user-namespace
        # sandbox requires it after acquiring capabilities in its own new namespace.
        # The kernel still enforces CAP_SYS_CHROOT; no container capabilities are added.
        policy = json.loads(Path('/usr/share/containers/seccomp.json').read_text())
        policy['syscalls'] = [r for r in policy['syscalls'] if 'chroot' not in r['names']]
        policy['syscalls'].append({'names': ['chroot'], 'action': 'SCMP_ACT_ALLOW', 'args': []})
        self.seccomp = str(Path(self.directory.name) / 'seccomp.json')
        Path(self.seccomp).write_text(json.dumps(policy))

    def create(self, *, negative_control_no_sandbox=False):
        key = 'moss-outlook-spike-' + uuid.uuid4().hex
        volume = key + '-profile'
        command('volume', 'create', volume)
        self.resources[key] = volume
        try:
            command('run', '--detach', '--name', key, '--network', 'none', '--read-only',
                    '--cap-drop', 'all', '--security-opt', 'no-new-privileges',
                    '--security-opt', f'seccomp={self.seccomp}', '--pids-limit', '256',
                    '--memory', '512m', '--cpus', '1', '--volume', f'{volume}:/profile',
                    '--tmpfs', '/tmp:rw,noexec,nosuid', IMAGE,
                    *(['--negative-control-no-sandbox'] if negative_control_no_sandbox else []))
            self.ready(key)
            return key
        except BaseException:
            self.destroy(key)
            raise

    def call(self, key, method, params=None):
        if key not in self.resources:
            raise ValueError('Inactive runtime')
        response = command('exec', '-i', key, 'python3', '/opt/probe/cdp.py',
                           data=json.dumps({'method': method, 'params': params or {}}))
        return json.loads(response.stdout)

    def evaluate(self, key, expression):
        result = self.call(key, 'Runtime.evaluate', {'expression': expression,
                                                   'returnByValue': True})
        if 'exceptionDetails' in result:
            raise RuntimeError('Synthetic evaluation failed')
        return result['result'].get('value')

    def ready(self, key):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                if self.evaluate(key, 'document.title') == 'Synthetic sign-in':
                    return
            except (subprocess.CalledProcessError, RuntimeError):
                pass
            time.sleep(.25)
        raise RuntimeError('Synthetic browser did not become ready')

    def restart(self, key):
        # Graceful termination persists profile state; startup is probed by the caller.
        command('stop', '--time', '10', key)
        command('start', key)
        self.ready(key)

    def destroy(self, key):
        volume = self.resources[key]
        command('rm', '--force', '--ignore', key)
        command('volume', 'rm', volume)
        del self.resources[key]

    def close(self):
        for key in list(self.resources):
            self.destroy(key)
        self.directory.cleanup()
