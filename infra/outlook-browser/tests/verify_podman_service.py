"""Real service/Chromium crash boundaries with a disclosed Podman barrier.

The test-only PATH wrapper runs the real engine unchanged, pausing before a run
or after a successful run/rm so SIGKILL is deterministic. It is not installed in
the service or image. This tests interrupted acknowledgment and recovery, not
every possible crash inside Podman's storage operations. No accounts are used.
"""
import argparse
import configparser
import json
import os
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from chromium_seccomp import chromium_policy
from lifecycle import Inventory
from podman import Podman
from verify_browser import PROBE, require_sandbox
from verify_service import request, wait_socket


ROOT = Path(__file__).resolve().parents[1]
BARRIER = '''
import json, os, socket, subprocess, sys
from pathlib import Path
root = Path(__file__).parent
engine = json.loads((root / 'engine.json').read_text())
gate = root / 'gate.json'
spec = json.loads(gate.read_text()) if gate.exists() else None
if spec and sys.argv[1] == spec['verb']:
    gate.unlink()
else:
    spec = None
def pause():
    with socket.socket(socket.AF_UNIX) as connection:
        connection.connect(str(root / 'barrier.sock'))
        connection.sendall(str(os.getpid()).encode() + b'\\n')
        if connection.recv(1) != b'G':
            raise SystemExit(70)
if spec and spec['phase'] == 'before':
    pause()
result = subprocess.run([*engine, *sys.argv[1:]], stdout=subprocess.PIPE)
if result.returncode == 0 and spec and spec['phase'] == 'after':
    pause()
sys.stdout.buffer.write(result.stdout)
raise SystemExit(result.returncode)
'''


def run(*args, data=None, check=True):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=check, timeout=60)


def manager(*args):
    return run('systemctl', '--user', *args).stdout.decode().strip()


def restarted(unit, old_pid, path):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        pid = manager('show', unit, '--property=MainPID', '--value')
        if pid not in ('0', old_pid):
            wait_socket(path)
            return
        time.sleep(.1)
    raise AssertionError('Service did not restart')


def verify(image, engine, negative_control):
    unit = 'moss-outlook-engine-proof-' + uuid.uuid4().hex
    ids = [str(uuid.uuid4()), str(uuid.uuid4())]
    settings = configparser.ConfigParser(interpolation=None)
    settings.optionxform = str
    settings.read(ROOT / 'moss-outlook-managed.service')
    properties = []
    for key, value in settings['Service'].items():
        if key != 'ExecStart':
            if key == 'KillMode' and negative_control:
                value = 'process'
            properties.append('--property=' + key + '=' + value)
    # Socket paths must fit Linux's 108-byte AF_UNIX limit.
    with tempfile.TemporaryDirectory(prefix='moss-crash-', dir='/tmp') as directory:
        root = Path(directory)
        (root / 'engine.json').write_text(json.dumps(engine))
        executable = root / 'podman'
        executable.write_text('#!' + sys.executable + '\n' + BARRIER)
        executable.chmod(0o700)
        policy = root / 'seccomp.json'
        policy.write_text(json.dumps(chromium_policy(json.loads(
            Path('/usr/share/containers/seccomp.json').read_text()))))
        (root / 'socket').mkdir(mode=0o750)
        path = root / 'socket/broker.sock'
        config = root / 'config.json'
        config.write_text(json.dumps({
            'state': str(root / 'state'), 'transport': str(root / 'transport'),
            'socket': str(path), 'image': image, 'seccomp': str(policy),
            'allowed_uid': os.getuid(), 'socket_gid': os.getgid(),
            'denied_networks': ['192.0.2.0/24'], 'infrastructure_hosts': ['localhost']}))
        config.chmod(0o600)
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(str(root / 'barrier.sock'))
        listener.listen(2)
        listener.settimeout(25)
        streams, descriptors = [], []

        def podman(*args, data=None, check=True):
            return run(*engine, *args, data=data, check=check)

        def exists(kind, runtime_id):
            name, volume = Podman.names(runtime_id)
            result = podman(kind, 'exists', name if kind == 'container' else volume, check=False)
            assert result.returncode in (0, 1), 'Engine presence check failed'
            return result.returncode == 0

        def marker(runtime_id, value=None):
            name, _ = Podman.names(runtime_id)
            if value is not None:
                podman('exec', name, 'python3', '-B', '-c',
                       'from pathlib import Path; Path("/profile/proof").write_text(' + repr(value) + ')')
            return podman('exec', name, 'cat', '/profile/proof').stdout

        def sandbox(runtime_id):
            name, _ = Podman.names(runtime_id)
            for installed, source in (('/opt/moss/runner.py', 'image/runner.py'),
                                      ('/opt/moss/proxy.py', 'proxy.py'),
                                      ('/etc/chromium/policies/managed/moss.json', 'image/policy.json')):
                assert podman('exec', name, 'cat', installed).stdout == (ROOT / source).read_bytes()

            def cdp(method, params):
                output = podman('exec', '-i', name, '/usr/bin/python3', '-B', '-c', PROBE,
                                data=json.dumps({'method': method, 'params': params}).encode()).stdout
                return json.loads(output)

            cdp('Page.navigate', {'url': 'chrome://sandbox'})
            result = cdp('Runtime.evaluate', {
                'expression': '''new Promise((resolve,reject)=>{
                  const end=Date.now()+10000;
                  const poll=()=>{if(location.href==='chrome://sandbox/' &&
                    document.body?.innerText.includes('Layer 1 Sandbox'))resolve(document.body.innerText);
                    else if(Date.now()>end)reject(Error('sandbox page timeout'));
                    else setTimeout(poll,100)};poll()})''',
                'returnByValue': True, 'awaitPromise': True})
            assert 'exceptionDetails' not in result, 'Sandbox diagnostics unavailable'
            require_sandbox(result['result']['value'])

        def arm(verb, phase, runtime_id, operation):
            (root / 'gate.json').write_text(json.dumps({'verb': verb, 'phase': phase}))
            client = request(path, runtime_id, operation, wait=False)
            streams.append(client)
            connection, _ = listener.accept()
            streams.append(connection)
            connection.settimeout(5)
            pid = int(connection.recv(64).strip())
            descriptor = os.pidfd_open(pid)
            descriptors.append(descriptor)
            assert not select.select([client], [], [], 0)[0], 'Request acknowledged before barrier'
            return connection, descriptor

        try:
            run('systemd-run', '--user', '--unit=' + unit, '--collect', *properties,
                '--setenv=PATH=' + str(root) + os.pathsep + os.environ['PATH'],
                sys.executable, '-B', str(ROOT / 'service.py'), '--config', str(config))
            wait_socket(path)
            assert request(path, ids[1], 'allocate', timeout=30) == b'{"ok":true}\n'
            assert marker(ids[1], 'second-owner') == b'second-owner'
            sandbox(ids[1])
            connection, descriptor = arm('run', 'before' if negative_control else 'after',
                                         ids[0], 'allocate')
            inventory = Inventory(root / 'state')
            assert inventory.get(ids[0]) == (1, 'allocating')
            old_pid = manager('show', unit, '--property=MainPID', '--value')
            if not negative_control:
                assert exists('container', ids[0]) and exists('volume', ids[0])
                assert marker(ids[0], 'first-owner') == b'first-owner'
            else:
                assert not exists('container', ids[0]), 'Control container existed before run'
            manager('kill', '--kill-whom=main', '--signal=KILL', unit)
            dead = bool(select.select([descriptor], [], [], 2 if negative_control else 8)[0])
            if negative_control:
                # The exact positive guard must fail, not merely a substitute assertion.
                try:
                    assert dead, 'Unacknowledged engine command survived broker crash'
                except AssertionError:
                    pass
                else:
                    raise AssertionError('Removing cgroup cleanup did not break the guard')
                manager('stop', unit)
                connection.sendall(b'G')
                assert select.select([descriptor], [], [], 20)[0], 'Orphan did not finish'
                assert exists('container', ids[0]) and exists('volume', ids[0])
                sandbox(ids[0])
                print('PASS: cgroup guard fails when removed; orphan runs real Podman and '
                      'creates candidate Chromium after broker death', flush=True)
                return
            assert dead, 'Unacknowledged engine command survived broker crash'
            restarted(unit, old_pid, path)
            assert inventory.get(ids[0]) == (1, 'ready')
            assert marker(ids[0]) == b'first-owner'
            assert marker(ids[1]) == b'second-owner'
            sandbox(ids[0])
            print('PASS: SIGKILL after real browser creation recovers allocating state, '
                  'profile marker and candidate sandbox; second owner persists', flush=True)
            _, descriptor = arm('rm', 'after', ids[0], 'remove')
            assert inventory.get(ids[0]) == (2, 'removing')
            assert not exists('container', ids[0]) and exists('volume', ids[0])
            old_pid = manager('show', unit, '--property=MainPID', '--value')
            manager('kill', '--kill-whom=main', '--signal=KILL', unit)
            assert select.select([descriptor], [], [], 8)[0], 'Removal command survived crash'
            restarted(unit, old_pid, path)
            assert inventory.get(ids[0]) == (2, 'removed')
            assert not exists('container', ids[0]) and not exists('volume', ids[0])
            assert request(path, ids[0], 'allocate', timeout=30) == b'{"ok":false}\n'
            assert marker(ids[1]) == b'second-owner'
            print('PASS: SIGKILL after real container removal recovers pending profile deletion '
                  'before listening; tombstone rejects allocation; second owner persists', flush=True)
            assert request(path, ids[1], 'remove', timeout=30) == b'{"ok":true}\n'
            assert not exists('container', ids[1]) and not exists('volume', ids[1])
        finally:
            run('systemctl', '--user', 'stop', unit, check=False)
            # Even a failing process-only control must not leave a blocked wrapper.
            for descriptor in descriptors:
                if not select.select([descriptor], [], [], 0)[0]:
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                    assert select.select([descriptor], [], [], 10)[0], 'Proof command did not exit'
                os.close(descriptor)
            for stream in streams:
                stream.close()
            listener.close()
            for runtime_id in ids:
                name, volume = Podman.names(runtime_id)
                if exists('container', runtime_id):
                    podman('rm', '--force', name)
                if exists('volume', runtime_id):
                    podman('volume', 'rm', volume)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True, help='Installed candidate sha256 image ID')
    parser.add_argument('--engine-root', type=Path)
    parser.add_argument('--engine-runroot', type=Path)
    parser.add_argument('--negative-control', action='store_true')
    args = parser.parse_args()
    if (args.engine_root is None) != (args.engine_runroot is None):
        parser.error('Select both engine-root and engine-runroot for a separate store')
    engine = [shutil.which('podman') or '/usr/bin/podman']
    for flag, value in (('--root', args.engine_root), ('--runroot', args.engine_runroot)):
        if value:
            engine += [flag, str(value.resolve())]
    verify(args.image, engine, args.negative_control)
