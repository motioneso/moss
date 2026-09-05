#!/usr/bin/env python3
"""Private disposable systemd/Docker proof of the actual host controller; no installation."""
import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid

spec = importlib.util.spec_from_file_location('control', Path(__file__).parents[1] / 'host/workshop-control.py')
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


def report(check, **fields):
    print(json.dumps({'check': check, 'status': 'pass', **fields}), flush=True)


def wait_for(check, seconds=12):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.2)
    raise AssertionError('bounded proof condition timed out')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--transport-only', action='store_true')
    args = parser.parse_args()
    if not __debug__ or os.getuid() != 1000:
        raise RuntimeError('assertions and deployment UID 1000 required')
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='workshop-r1d-proof-') as temporary:
        root = Path(temporary)
        for name in ['state', 'control']:
            (root / name).mkdir(mode=0o700)
        key = secrets.token_bytes(32)
        (root / 'control/key').write_bytes(key)
        config = {'state': str(root / 'state'), 'control': str(root / 'control'), 'image': args.image,
                  'prefix': 'workshop-' + secrets.token_hex(8), 'docker': shutil.which('docker'), 'userSystemd': True}
        config_path = root / 'config.json'
        config_path.write_bytes(control.encode(config))
        control.load_config(config_path)
        control.systemctl(config, 'show', '--property=Version')
        references = []
        server = None

        def launch():
            nonlocal server
            server = subprocess.Popen([sys.executable, '-B', str(Path(control.__file__)), '--config', str(config_path)],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            def ready():
                if server.poll() is not None:
                    raise AssertionError('controller startup failed')
                try:
                    with socket.socket(socket.AF_UNIX) as client:
                        client.connect(str(root / 'control/control.sock'))
                        return True
                except OSError:
                    return False
            wait_for(ready)

        def source(test=None):
            files = [{'path': 'src/worker/index.ts', 'content': "export default {handlers: {}};"},
                     {'path': 'src/web/index.ts', 'content': "import { h } from '@moss/module-web-sdk'; export default {contractVersion:2, Root:() => h('p', null, 'Control proof')};"}]
            if test:
                files.append({'path': 'tests/control.test.ts', 'content': test})
            return control.encode({'files': files})

        def reference(data, recipe='build'):
            ref = {field: uuid.uuid4().hex for field in ['run', 'actor', 'project', 'revision', 'attempt', 'lease']}
            ref.update(sourceHash=hashlib.sha256(data).hexdigest(), recipe=recipe)
            references.append(ref)
            return ref

        def request(ref, op='start', data=None, signing_key=key, **changes):
            value = {'op': op, 'expires': int(time.time()) + 30, 'reference': ref,
                     'source': base64.b64encode(data).decode() if data is not None else None}
            value.update(changes)
            payload = control.encode(value)
            wire = control.encode({'payload': base64.b64encode(payload).decode(),
                                   'mac': hmac.digest(signing_key, payload, 'sha256').hex()}) + b'\n'
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(30)
                client.connect(str(root / 'control/control.sock'))
                client.sendall(wire)
                result = bytearray()
                while True:
                    chunk = client.recv(65536)
                    if not chunk:
                        break
                    result.extend(chunk)
                    assert len(result) < 3000000
            return json.loads(result)

        def running(ref):
            name = control.resource_name(config, ref['run'])
            result = control.command(config['docker'], 'inspect', '--format', '{{.State.Running}}', name, check=False)
            return result.returncode == 0 and result.stdout.strip() == b'true'

        def absent(ref):
            name = control.resource_name(config, ref['run'])
            return control.unit_state(config, name) in {'inactive', 'failed'} and control.container_absent(config, name)

        try:
            launch()
            good = source()
            ref = reference(good, 'render')
            for changes in [{'signing_key': b'x' * 32}, {'expires': 0}, {'command': 'sh'}]:
                assert request(ref, data=good, **changes)['error'] == 'denied'
            assert request(ref, data=good)['state'] == 'accepted'
            assert request(ref, data=good)['error'] == 'already-started'
            for field in ['actor', 'lease', 'sourceHash']:
                changed = dict(ref, **{field: 'a' * len(ref[field])})
                for op in ['start', 'status', 'stop', 'result']:
                    assert request(changed, op, good if op == 'start' else None)['error'] == 'denied'
            wait_for(lambda: request(ref, 'status')['state'] in {'exited', 'failed'}, 25)
            result = request(ref, 'result')
            assert result['state'] == 'exited', result
            proposal = json.loads(base64.b64decode(result['proposal'], validate=True))
            assert proposal['version'] == 1 and any(item['path'].endswith('.png') for item in proposal['artifacts'])
            assert absent(ref)
            report('authenticated-render-binding-replay-and-result', artifacts=len(proposal['artifacts']))
            # The production-shaped trusted caller gets only the private control mount.
            client_code = r'''
const fs = require('fs'), net = require('net'), crypto = require('crypto'), assert = require('assert');
assert.equal(process.getuid(), 1000);
assert.equal(fs.existsSync('/var/run/docker.sock'), false);
assert.equal(fs.existsSync('/control/config.json'), false);
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const payload = Buffer.from(input);
  const mac = crypto.createHmac('sha256', fs.readFileSync('/control/key')).update(payload).digest('hex');
  const client = net.createConnection('/control/control.sock');
  client.setTimeout(10000, () => {client.destroy(); process.exit(2);});
  client.on('error', () => process.exit(3));
  client.on('connect', () => client.write(JSON.stringify({payload:payload.toString('base64'), mac}) + '\n'));
  client.on('data', chunk => process.stdout.write(chunk));
});
'''
            client_name = config['prefix'] + '-client'
            try:
                client_result = subprocess.run([config['docker'], 'run', '--rm', '-i', '--name', client_name,
                    '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
                    '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '128m',
                    '--memory-swap', '128m', '--cpus', '0.25', '--log-driver', 'none',
                    '--mount', 'type=bind,src=' + config['control'] + ',dst=/control,readonly',
                    '--entrypoint', '/usr/local/bin/node', config['image'], '-e', client_code],
                    input=control.encode({'op':'status', 'expires':int(time.time()) + 30,
                                          'reference':ref, 'source':None}),
                    capture_output=True, timeout=20, check=True)
                assert json.loads(client_result.stdout)['state'] == 'exited'
                report('unprivileged-container-caller-authenticated-private-socket')
            finally:
                control.command(config['docker'], 'rm', '-f', client_name, check=False)
                assert control.container_absent(config, client_name)
            if args.transport_only:
                return

            hanging = source("process.kill(1, 'SIGSTOP'); setInterval(() => {}, 1000);")
            stopped = reference(hanging)
            assert request(stopped, data=hanging)['state'] == 'accepted'
            wait_for(lambda: running(stopped))
            assert request(stopped, 'stop')['state'] == 'stopped'
            assert absent(stopped)
            assert request(stopped, 'stop')['state'] == 'stopped'
            report('exact-idempotent-stop-and-absence')

            # Write around the recipe's own test-output capture to exercise HOST stream bounds.
            flooding = source("import {writeFileSync} from 'node:fs'; writeFileSync('/proc/1/fd/1', 'x'.repeat(3000000));")
            flood = reference(flooding)
            assert request(flood, data=flooding)['state'] == 'accepted'
            wait_for(lambda: request(flood, 'status')['state'] == 'failed', 20)
            assert 'proposal' not in request(flood, 'result') and absent(flood)
            report('host-stream-limit-kills-and-reaps')

            deadline = reference(hanging)
            assert request(deadline, data=hanging)['state'] == 'accepted'
            wait_for(lambda: running(deadline))
            control.command(config['docker'], 'kill', '--signal=SIGSTOP',
                            control.resource_name(config, deadline['run']))
            # Freeze the run helper too: its own 55-second cutoff must not supply cleanup.
            control.systemctl(config, 'kill', '--kill-whom=main', '--signal=SIGSTOP',
                              control.resource_name(config, deadline['run']) + '.service')
            # Start the peer later so it remains inside its independent deadline at observation.
            time.sleep(15)
            peer = reference(hanging)
            assert request(peer, data=hanging)['state'] == 'accepted'
            wait_for(lambda: running(peer))
            control.command(config['docker'], 'kill', '--signal=SIGSTOP',
                            control.resource_name(config, peer['run']))
            third = reference(good)
            assert request(third, data=good)['error'] == 'busy'
            server.kill()
            assert server.wait(timeout=5) == -9
            report('controller-killed-with-two-live-units')
            wait_for(lambda: absent(deadline), 55)
            name = control.resource_name(config, deadline['run'])
            result = control.systemctl(config, 'show', name + '.service', '--property=Result', '--value').stdout.strip()
            assert result == b'timeout', result
            assert running(peer)
            launch()
            assert request(deadline, data=hanging)['error'] == 'already-started'
            assert request(deadline, 'status')['state'] == 'recovery-needed'
            assert request(deadline, 'stop')['state'] == 'stopped'
            assert request(peer, 'stop')['state'] == 'stopped'
            assert absent(peer)
            report('independent-deadline-cleanup-peer-survival-and-restart-fence')
        finally:
            if server is not None and server.poll() is None:
                server.kill()
                server.wait(timeout=5)
            errors = []
            for ref in references:
                name = control.resource_name(config, ref['run'])
                try:
                    control.systemctl(config, 'stop', name + '.service', check=False)
                    control.command(config['docker'], 'rm', '-f', name, check=False)
                    control.systemctl(config, 'reset-failed', name + '.service', check=False)
                    assert control.container_absent(config, name)
                    units = control.systemctl(config, 'list-units', '--all', '--no-legend', name + '.service')
                    assert not units.stdout.strip()
                except Exception:
                    errors.append(name)
            assert not errors, errors
            report('all-owned-resources-removed', references=len(references))


if __name__ == '__main__':
    main()
