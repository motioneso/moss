"""Actual user-systemd crash/restart with a disclosed external-engine fixture.

Runs the real service entrypoint, inventory, broker protocol and egress listeners.
The executable named Podman here stands in for a slow engine operation. It does
not establish actual Podman/Chromium behavior. No accounts or TCP ports are used.
"""
import argparse
import configparser
import json
import os
import select
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ENGINE = '''
import os, socket, sys
from pathlib import Path
root = Path(__file__).parent
args = sys.argv[1:]
kind, verb = args[:2]
if kind == 'info':
    print('true'); exit()
marker = root / (kind + '-fixture')
if verb == 'exists':
    exit(0 if marker.exists() else 1)
if verb == 'inspect':
    print('sha256:' + 'a' * 64 if '{{.Image}}' in args else
          (root / 'runtime-id').read_text()); exit()
if kind == 'volume' and verb == 'create':
    marker.touch(); exit()
if kind in ('volume', 'container') and verb == 'rm':
    marker.unlink(missing_ok=True); exit()
if kind == 'rm':
    (root / 'container-fixture').unlink(missing_ok=True); exit()
if kind == 'run':
    connection = socket.socket(socket.AF_UNIX)
    connection.connect(str(root / 'engine.sock'))
    connection.sendall(str(os.getpid()).encode() + b'\\n')
    if connection.recv(1) == b'G':
        (root / 'container-fixture').touch()
    connection.close()
'''


def command(*args):
    return subprocess.run(args, check=True, stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)


def request(path, runtime_id, operation, *, wait=True, timeout=5):
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(timeout)
    connection.connect(str(path))
    connection.sendall(json.dumps({'operation': operation, 'runtimeId': runtime_id,
                                  'generation': 1 if operation == 'allocate' else 2}).encode() + b'\n')
    if not wait:
        return connection
    with connection:
        return connection.recv(1024)


def wait_socket(path):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if path.exists():
            # The pre-crash socket may exist until the restarted broker listens.
            probe = socket.socket(socket.AF_UNIX)
            try:
                probe.connect(str(path))
                return
            except (ConnectionRefusedError, FileNotFoundError):
                pass
            finally:
                probe.close()
        time.sleep(0.05)
    raise AssertionError('Broker did not become ready')


def verify(negative_control):
    unit = 'moss-outlook-proof-' + uuid.uuid4().hex
    unit_config = configparser.ConfigParser(interpolation=None)
    unit_config.optionxform = str
    unit_config.read(ROOT / 'moss-outlook-managed.service')
    properties = []
    for key, value in unit_config['Service'].items():
        if key == 'ExecStart':
            continue
        if key == 'KillMode' and negative_control:
            value = 'process'
        properties.append('--property=' + key + '=' + value)
    with tempfile.TemporaryDirectory(prefix='moss-service-proof-') as directory:
        root = Path(directory)
        executable = root / 'podman'
        executable.write_text('#!' + sys.executable + '\n' + ENGINE)
        executable.chmod(0o700)
        (root / 'seccomp.json').write_text('{}')
        (root / 'socket').mkdir(mode=0o750)
        runtime_id = str(uuid.uuid4())
        (root / 'runtime-id').write_text(runtime_id)
        broker_path = root / 'socket' / 'broker.sock'
        configuration = root / 'config.json'
        configuration.write_text(json.dumps({
            'state': str(root / 'state'), 'transport': str(root / 'transport'),
            'socket': str(broker_path), 'image': 'sha256:' + 'a' * 64,
            'seccomp': str(root / 'seccomp.json'), 'allowed_uid': os.getuid(),
            'socket_gid': os.getgid(), 'denied_networks': ['192.0.2.0/24'],
            'infrastructure_hosts': ['localhost']}))
        configuration.chmod(0o600)
        listener = socket.socket(socket.AF_UNIX)
        listener.settimeout(12)
        listener.bind(str(root / 'engine.sock'))
        listener.listen(2)
        streams, descriptors = [], []
        try:
            command('systemd-run', '--user', '--unit=' + unit, '--collect',
                    '--property=StartLimitIntervalSec=0', *properties,
                    '--setenv=PATH=' + str(root) + os.pathsep + os.environ['PATH'],
                    sys.executable, '-B', str(ROOT / 'service.py'), '--config', str(configuration))
            wait_socket(broker_path)
            streams.append(request(broker_path, runtime_id, 'allocate', wait=False))
            first, _ = listener.accept()
            streams.append(first)
            first.settimeout(5)
            old_pid = int(first.recv(64).strip())
            descriptor = os.pidfd_open(old_pid)
            descriptors.append(descriptor)
            command('systemctl', '--user', 'kill', '--kill-whom=main', '--signal=KILL', unit)
            if negative_control:
                assert not select.select([descriptor], [], [], 2)[0], 'Fixture engine unexpectedly died'
                # Stop automatic restarts before allowing the orphan to finish.
                command('systemctl', '--user', 'stop', unit)
                first.sendall(b'G')
                assert select.select([descriptor], [], [], 5)[0], 'Fixture engine did not exit'
                assert (root / 'container-fixture').exists(), 'Late side effect missing'
                print('PASS: removing cgroup kill leaves a live engine and late creation after broker death')
                return
            assert select.select([descriptor], [], [], 5)[0], 'Old engine survived service cgroup cleanup'
            assert not (root / 'container-fixture').exists(), 'Old engine created after broker death'
            second, _ = listener.accept()
            streams.append(second)
            second.settimeout(5)
            assert int(second.recv(64).strip()) != old_pid
            second.sendall(b'G')
            wait_socket(broker_path)
            assert request(broker_path, runtime_id, 'remove') == b'{"ok":true}\n'
            assert not (root / 'container-fixture').exists()
            assert not (root / 'volume-fixture').exists()
            assert request(broker_path, runtime_id, 'allocate') == b'{"ok":false}\n'
            print('PASS: real service cgroup kills in-flight engine, startup recovers, '
                  'removal acknowledges after fixture resources disappear, tombstone rejects allocation')
        finally:
            subprocess.run(['systemctl', '--user', 'stop', unit], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            for stream in streams:
                stream.close()
            for descriptor in descriptors:
                os.close(descriptor)
            listener.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--negative-control', action='store_true')
    verify(parser.parse_args().negative_control)
