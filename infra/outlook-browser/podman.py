"""Fixed rootless engine operations. Never accepts a command, URL or mount from a client.

Called behind Inventory's per-runtime lock. Image/seccomp/transport root are
installation configuration; the managed broker must revoke egress before remove.
"""
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

from lifecycle import Unavailable, validate_reference


LABEL = 'io.moss.outlook.runtime'


class Podman:
    def __init__(self, *, image, seccomp, transport_root, service_lock=None):
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
            raise ValueError('Browser image must be an installed immutable image ID')
        self.image = image
        self.service_lock = service_lock
        self.seccomp = Path(seccomp).resolve(strict=True)
        self.transport_root = Path(transport_root).resolve(strict=True)
        if self.run('info', '--format', '{{.Host.Security.Rootless}}') != 'true':
            raise Unavailable('Rootless Podman required')

    def run(self, *arguments, absent=False):
        descriptors = (() if self.service_lock is None else
                       (self.service_lock.descriptor,))
        command = ['podman', *arguments]
        timeout = 30
        if self.service_lock is not None:
            command = [sys.executable, '-B', str(Path(__file__).with_name('engine_command.py')),
                       str(os.getpid()), str(self.service_lock.descriptor), *arguments]
            # The supervisor owns timeout handling. Killing it here could free
            # the lock while the engine it supervises is still running.
            timeout = None
        result = subprocess.run(command, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=timeout, check=False, pass_fds=descriptors)
        if absent and result.returncode == 1:
            return None
        if result.returncode or len(result.stdout) > 8192:
            raise Unavailable('Browser engine operation failed')
        return result.stdout.decode('utf-8').strip()

    @staticmethod
    def names(runtime_id):
        validate_reference(runtime_id, 1)
        name = 'moss-outlook-' + runtime_id
        return name, name + '-profile'

    def owned(self, kind, name, runtime_id):
        exists = self.run(kind, 'exists', name, absent=True)
        if exists is None:
            return False
        label = self.run(kind, 'inspect', '--format',
                         '{{index .Labels "' + LABEL + '"}}' if kind == 'volume' else
                         '{{index .Config.Labels "' + LABEL + '"}}', name)
        if label != runtime_id:
            raise Unavailable('Browser resource ownership mismatch')
        return True

    def create(self, runtime_id):
        name, volume = self.names(runtime_id)
        directory = self.transport_root / runtime_id
        info = directory.lstat()
        socket_info = (directory / 'connect.sock').lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or
                stat.S_IMODE(info.st_mode) != 0o700 or
                not stat.S_ISSOCK(socket_info.st_mode) or socket_info.st_uid != os.getuid() or
                stat.S_IMODE(socket_info.st_mode) != 0o600):
            raise Unavailable('Private egress socket required')
        if not self.owned('volume', volume, runtime_id):
            self.run('volume', 'create', '--label', LABEL + '=' + runtime_id, volume)
        if self.owned('container', name, runtime_id):
            actual_image = self.run('container', 'inspect', '--format', '{{.Image}}', name)
            if actual_image.removeprefix('sha256:') != self.image.removeprefix('sha256:'):
                raise Unavailable('Browser image mismatch')
            self.run('start', name)
            return
        self.run('run', '--detach', '--pull', 'never', '--name', name,
                 '--label', LABEL + '=' + runtime_id,
                 '--network', 'none', '--userns', 'keep-id:uid=1000,gid=1000',
                 '--user', '1000:1000', '--read-only', '--cap-drop', 'all',
                 '--security-opt', 'no-new-privileges',
                 '--security-opt', 'seccomp=' + str(self.seccomp),
                 '--pids-limit', '256', '--memory', '1g', '--cpus', '1',
                 '--log-driver', 'none', '--volume', volume + ':/profile',
                 '--volume', str(directory) + ':/egress:ro',
                 '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', self.image)

    def remove(self, runtime_id):
        name, volume = self.names(runtime_id)
        if self.owned('container', name, runtime_id):
            self.run('stop', '--time', '10', name)
            self.run('rm', name)
        if self.owned('volume', volume, runtime_id):
            self.run('volume', 'rm', volume)
