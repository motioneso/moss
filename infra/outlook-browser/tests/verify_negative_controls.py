"""Mutate copies of the actual modules; never weaken the working-tree sources."""
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTROLS = (
    ('address policy', 'egress.py',
     'if not allowed or any(address in network for network in denied_networks):',
     'if False:', 'test_egress.AddressPolicy.test_special_addresses'),
    ('DNS pin', 'egress.py', 'address = addresses[0]', 'address = host',
     'test_egress.UnixTransport.test_dns_pin_and_bidirectional_tunnel'),
    ('revocation tombstone', 'lifecycle.py',
     "row[1] in ('removing', 'removed')", 'False',
     'test_lifecycle.Lifecycle.test_removed_runtime_cannot_be_recreated_after_restart'),
    ('cancellation drain', 'runtime.py', 'result = await asyncio.shield(task)',
     'result = await task',
     'test_runtime.RuntimeComposition.test_cancelled_allocate_cannot_finish_after_cleanup_ack'),
)


def verify():
    for name, filename, before, after, test in CONTROLS:
        with tempfile.TemporaryDirectory(prefix='moss-runtime-negative-') as directory:
            for module in ('egress.py', 'lifecycle.py', 'runtime.py'):
                source = (ROOT / module).read_text()
                if module == filename:
                    if source.count(before) != 1:
                        raise RuntimeError('Negative control source changed: ' + name)
                    source = source.replace(before, after)
                (Path(directory) / module).write_text(source)
            environment = {**os.environ, 'PYTHONPATH': directory + os.pathsep + str(ROOT / 'tests')}
            result = subprocess.run([sys.executable, '-B', '-m', 'unittest', test],
                                    env=environment, capture_output=True, text=True, timeout=10)
            if result.returncode != 1 or 'FAILED (failures=' not in result.stderr:
                raise RuntimeError('Expected assertion failure missing: ' + name)
            print('PASS: removed ' + name + ' guard causes an assertion failure')


if __name__ == '__main__':
    verify()
