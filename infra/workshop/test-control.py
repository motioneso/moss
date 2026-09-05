#!/usr/bin/env python3
"""No Docker, database, provider, or service installation needed."""
import base64
import copy
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('control', Path(__file__).parents[1] / 'host/workshop-control.py')
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)
KEY = b'x' * 32
SOURCE = b'{"files":[{"path":"src/worker/index.ts","content":"export default {}"}]}'
REFERENCE = {field: 'a' * 32 for field in ['run', 'actor', 'project', 'revision', 'attempt', 'lease']}
REFERENCE.update(sourceHash=hashlib.sha256(SOURCE).hexdigest(), recipe='build')


def request(op='start', reference=None, source=SOURCE):
    return {'op': op, 'expires': int(time.time()) + 30, 'reference': reference or REFERENCE,
            'source': base64.b64encode(source).decode() if op == 'start' else None}


def signed(value, key=KEY):
    payload = control.encode(value)
    return control.encode({'payload': base64.b64encode(payload).decode(),
                           'mac': hmac.digest(key, payload, 'sha256').hex()}) + b'\n'


class Contract(unittest.TestCase):
    def test_installer_renders_private_files_with_mocked_host_commands(self):
        with tempfile.TemporaryDirectory(prefix='workshop-installer-check-') as temporary:
            root = Path(temporary)
            (root / 'bin').mkdir()
            for name, body in [('loginctl', 'echo yes'), ('docker', 'exit 0'),
                               ('systemctl', 'case "$*" in *is-active*) exit 1;; esac')]:
                executable = root / 'bin' / name
                executable.write_text('#!/bin/sh\n' + body + '\n')
                executable.chmod(0o700)
            env = dict(os.environ, PATH=str(root / 'bin') + ':' + os.environ['PATH'],
                       XDG_CONFIG_HOME=str(root / 'units'),
                       MOSS_WORKSHOP_CONTROL_DIR=str(root / 'control'),
                       MOSS_WORKSHOP_STATE_DIR=str(root / 'state'),
                       MOSS_WORKSHOP_IMAGE='sha256:' + 'a' * 64)
            subprocess.run(['bash', str(Path(control.__file__).with_name('install-workshop-unit.sh'))],
                           env=env, check=True, capture_output=True, timeout=10)
            config = control.load_config(root / 'state/config.json')
            self.assertEqual(config['state'], str(root / 'state'))
            self.assertEqual(len((root / 'control/key').read_bytes()), 32)
            unit = (root / 'units/systemd/user/moss-workshop-control.service').read_text()
            self.assertIn(str(Path(sys.executable).resolve()), unit)
            self.assertIn('Restart=on-failure', unit)

    def test_atomic_writes_ignore_crash_leftovers(self):
        with tempfile.TemporaryDirectory(prefix='workshop-control-crash-') as temporary:
            path = Path(temporary)
            (path / 'stop.tmp').write_bytes(b'partial')
            (path / '.write-orphan').write_bytes(b'partial')
            control.write_file(path / 'stop', b'')
            self.assertEqual((path / 'stop').read_bytes(), b'')
            control.write_file(path / 'terminal', b'stopped')
            self.assertEqual((path / 'terminal').read_bytes(), b'stopped')

    def test_authentication_binding_and_fixed_vocabulary(self):
        value = request()
        self.assertEqual(control.decode_request(signed(value), KEY), value)
        invalid = [dict(value, op='exec'), dict(value, expires=0), dict(value, expires=int(time.time()) + 120),
                   dict(value, command='sh'), dict(value, source=base64.b64encode(b'changed').decode())]
        for field, change in [('run', '../outside'), ('sourceHash', 'x' * 64), ('recipe', 'shell')]:
            item = copy.deepcopy(value)
            item['reference'][field] = change
            invalid.append(item)
        for item in invalid:
            with self.assertRaises(ValueError):
                control.decode_request(signed(item), KEY)
        with self.assertRaises(ValueError):
            control.decode_request(signed(value, b'y' * 32), KEY)
        large = b' ' * control.INPUT_LIMIT
        ref = dict(REFERENCE, sourceHash=hashlib.sha256(large).hexdigest())
        wire = signed(request(reference=ref, source=large))
        self.assertLessEqual(len(wire), control.WIRE_LIMIT)
        control.decode_request(wire, KEY)

    def test_reads_reject_symlinks_and_fifos(self):
        import os
        with tempfile.TemporaryDirectory(prefix='workshop-control-check-') as temporary:
            path = Path(temporary)
            (path / 'file').write_bytes(b'abc')
            (path / 'link').symlink_to(path / 'file')
            os.mkfifo(path / 'fifo')
            for name in ['link', 'fifo']:
                with self.assertRaises((ValueError, OSError)):
                    control.read_file(path / name, 10)
            with self.assertRaises(ValueError):
                control.read_file(path / 'file', 2)

    def test_claims_bind_owner_lease_and_survive_failed_launch(self):
        with tempfile.TemporaryDirectory(prefix='workshop-control-claims-') as temporary:
            config = {'state': temporary, 'prefix': 'workshop-' + 'b' * 16, 'userSystemd': True, 'docker': '/usr/bin/docker'}
            with patch.object(control, 'command', side_effect=RuntimeError('launch failed')):
                with self.assertRaises(RuntimeError):
                    control.dispatch(config, Path(temporary) / 'config', request())
            self.assertEqual(control.dispatch(config, None, request()), {'ok': False, 'error': 'already-started'})
            for field in ['actor', 'lease', 'sourceHash', 'project', 'revision', 'attempt']:
                ref = dict(REFERENCE, **{field: 'b' * len(REFERENCE[field])})
                for op in ['start', 'status', 'stop', 'result']:
                    with self.assertRaises(ValueError):
                        control.dispatch(config, None, request(op, ref))
            run_dir = Path(temporary) / REFERENCE['run']
            with patch.object(control, 'unit_state', return_value='inactive'), patch.object(control, 'container_absent', return_value=False):
                self.assertEqual(control.status(config, run_dir, 'name'), 'recovery-needed')

    def test_stream_caps_and_deadline(self):
        cases = [('import sys; sys.stdout.buffer.write(b"x" * 2200000)', ValueError, {}),
                 ('import sys; sys.stderr.buffer.write(b"x" * 70000)', ValueError, {}),
                 ('import time; time.sleep(10)', TimeoutError, {'WALL_SECONDS': 5.1})]
        for code, error, constants in cases:
            process = subprocess.Popen([sys.executable, '-c', code], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                with patch.multiple(control, **constants) if constants else patch.object(control, 'WALL_SECONDS', 60):
                    with self.assertRaises(error):
                        control.bounded_pipe(process, b'input')
            finally:
                process.kill()
                process.wait(timeout=5)
                for stream in [process.stdin, process.stdout, process.stderr]:
                    stream.close()


if __name__ == '__main__':
    unittest.main()
