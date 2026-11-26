#!/usr/bin/env python3
"""Observe marker fixtures failing with each production guard removed, then restore it.

Run only in a task-owned checkout, with an isolated CARGO_TARGET_DIR and no concurrent cargo
builds. Each mutation must compile and fail its focused test; a compiler failure is not proof.
The source is restored in finally, including when the test command errors.
"""
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'rust-spike/network/src/firewall.rs'
COMMAND = ['cargo', '+1.95.0', 'test', '--locked', '--manifest-path',
           'rust-spike/network/Cargo.toml', '--lib']
CONTROLS = [
    ('windows_lookup', 'Ok(true)', 'windows_marker_rejects_near_matches_and_ambiguous_lists'),
    ('ufw_marker', 'true', 'marker_checks_accept_ours_and_refuse_foreign_rules'),
    ('mac_marker', 'true', 'marker_checks_accept_ours_and_refuse_foreign_rules'),
    ('service_file_is_ours', 'true', 'firewalld_live_definition_requires_exact_token_port_and_no_extra_grants'),
    ('service_info_is_ours', 'true', 'firewalld_live_definition_requires_exact_token_port_and_no_extra_grants'),
]


def check(test, expected):
    command = [*COMMAND, test, '--', '--test-threads=1']
    print('COMMAND:', subprocess.list2cmdline(command), flush=True)
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=600)
    print('EXIT:', result.returncode, flush=True)
    output = result.stdout + result.stderr
    if result.returncode != expected or (expected and 'test result: FAILED' not in output):
        print(output[-5000:], flush=True)
        raise AssertionError('expected a test assertion failure, not a build/tool failure')
    print(output[output.find('running '):][-2500:], flush=True)


def main():
    if not os.environ.get('CARGO_TARGET_DIR'):
        raise RuntimeError('set an isolated CARGO_TARGET_DIR')
    original = SOURCE.read_bytes()
    try:
        check('firewall', 0)
        for function, result, test in CONTROLS:
            source = original.decode()
            start = source.index('fn ' + function + '(')
            body = source.index('{', start)
            end = source.index('\n}', body)
            SOURCE.write_text(source[:body + 1] + '\n    ' + result + '\n' + source[end:])
            print('PROTECTION REMOVED:', function, flush=True)
            check(test, 101)
            SOURCE.write_bytes(original)
    finally:
        SOURCE.write_bytes(original)
    check('firewall', 0)
    print('MARKER NEGATIVE CONTROLS: PASS', flush=True)


if __name__ == '__main__':
    main()
