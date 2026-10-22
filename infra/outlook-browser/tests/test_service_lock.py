"""Actual subprocess death, with a disclosed engine executable fixture.

This exercises Podman.run's real subprocess/pass_fds path, not a Podman daemon
or Chromium. Real engine/cgroup crash proofs remain required before release.
"""
import os
import select
import socket
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

import podman
from lifecycle import Inventory, Unavailable
from service_lock import ServiceLock


ROOT = Path(podman.__file__).resolve().parent


class BrokerDeath(unittest.TestCase):
    def test_orphaned_engine_holds_lock_until_late_creation_finishes(self):
        with tempfile.TemporaryDirectory(prefix='moss-crash-test-') as directory:
            root = Path(directory)
            inventory = Inventory(root / 'inventory')
            marker = root / 'profile-fixture'
            key = str(uuid.uuid4())
            # Executable fixture only stands in for the external Podman command.
            executable = root / 'podman'
            executable.write_text('#!' + sys.executable + '\n' + '''
import os, socket, sys
from pathlib import Path
connection = socket.socket(socket.AF_UNIX)
connection.connect(sys.argv[1])
leaked = 0
for descriptor in Path('/proc/self/fd').iterdir():
    try:
        leaked += os.readlink(descriptor).endswith('/service.lock')
    except FileNotFoundError:
        pass
connection.sendall((str(os.getpid()) + ' ' + str(os.getppid()) + ' ' + str(leaked)).encode() + b'\\n')
if connection.recv(1) == b'G':
    Path(sys.argv[2]).write_text('created')
connection.close()
''')
            executable.chmod(0o700)
            listener = socket.socket(socket.AF_UNIX)
            listener.settimeout(5)
            listener.bind(str(root / 'fixture.sock'))
            listener.listen(1)
            script = '''
import sys
from pathlib import Path
from lifecycle import Inventory
from podman import Podman
from service_lock import ServiceLock
inventory = Inventory(Path(sys.argv[1]) / 'inventory')
lock = ServiceLock(inventory.directory)
engine = Podman.__new__(Podman)
engine.service_lock = lock
with inventory.allocating(sys.argv[2], 1):
    engine.run(str(Path(sys.argv[1]) / 'fixture.sock'),
               str(Path(sys.argv[1]) / 'profile-fixture'))
'''
            environment = {**os.environ, 'PYTHONPATH': str(ROOT),
                           'PATH': str(root) + os.pathsep + os.environ['PATH']}
            parent = subprocess.Popen([sys.executable, '-B', '-c', script, str(root), key],
                                      env=environment, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL)
            connection = None
            pidfd = None
            supervisor_fd = None
            try:
                connection, _ = listener.accept()
                connection.settimeout(5)
                child_pid, supervisor_pid, leaked = map(int, connection.recv(64).split())
                pidfd = os.pidfd_open(child_pid)
                supervisor_fd = os.pidfd_open(supervisor_pid)
                self.assertEqual(leaked, 0, 'Broker lock reached the engine process')
                parent.kill()
                parent.wait(timeout=5)
                self.assertEqual(inventory.get(key), (1, 'allocating'))
                with self.assertRaises(BlockingIOError):
                    ServiceLock(inventory.directory)
                self.assertFalse(marker.exists())
                connection.sendall(b'G')
                self.assertEqual(select.select([pidfd], [], [], 5)[0], [pidfd])
                self.assertEqual(select.select([supervisor_fd], [], [], 5)[0], [supervisor_fd])
                lock = ServiceLock(inventory.directory)
                try:
                    self.assertEqual(marker.read_text(), 'created')
                    inventory.remove(key, 2, lambda _: marker.unlink())
                    self.assertEqual(inventory.get(key), (2, 'removed'))
                    self.assertFalse(marker.exists())
                    with self.assertRaises(Unavailable):
                        inventory.allocate(key, 3, lambda _: marker.touch())
                finally:
                    lock.close()
            finally:
                if connection:
                    connection.close()
                if pidfd is not None:
                    os.close(pidfd)
                if supervisor_fd is not None:
                    os.close(supervisor_fd)
                listener.close()
                if parent.poll() is None:
                    parent.kill()
                parent.wait(timeout=5)

    def test_close_does_not_unlock_an_inherited_descriptor(self):
        with tempfile.TemporaryDirectory(prefix='moss-lock-test-') as directory:
            inventory = Inventory(Path(directory) / 'inventory')
            lock = ServiceLock(inventory.directory)
            inherited = os.dup(lock.descriptor)
            try:
                lock.close()
                with self.assertRaises(BlockingIOError):
                    ServiceLock(inventory.directory)
            finally:
                os.close(inherited)
            replacement = ServiceLock(inventory.directory)
            replacement.close()

    def test_unsafe_lock_file_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='moss-lock-test-') as directory:
            inventory = Inventory(Path(directory) / 'inventory')
            path = inventory.directory / 'service.lock'
            path.touch(mode=0o644)
            with self.assertRaises(Unavailable):
                ServiceLock(inventory.directory)


if __name__ == '__main__':
    unittest.main()
