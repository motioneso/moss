#!/usr/bin/env python3
"""Run guard-removal controls serially in this task's isolated worktree.

Each real-server run goes through verify-gate's fresh database. Restore source bytes even
when a control fails. No bypass flags are compiled into the application.
"""
import os
from pathlib import Path
import re
import subprocess
import sys


def replace(source, before, after):
    if before not in source:
        raise RuntimeError(f"Control no longer matches: {before}")
    return source.replace(before, after, 1)


def guard(source, message):
    at = source.index('"' + message + '"')
    start = source.rindex('ensure!(', 0, at)
    if source[max(0, start - 8):start] == 'anyhow::':
        start -= 8
    end = source.index(');', at) + 2
    return source[:start] + source[end:]


app = 'rust-spike/shell/app/src/'
host = 'rust-spike/module-host/src/'
controls = [
    ('installed-review', 'update requires an installed module', {}, {
        app + 'module_management.rs': lambda s: guard(s, 'This module is not installed'),
    }),
    ('explicit-approval', 'urgent still needs approval', {}, {
        app + 'module_management.rs': lambda s: replace(s, 'if !decision.approve {', 'if false {'),
    }),
    ('urgent-capability', 'growth needs host approval even when urgent: capability', {'JS410_GROWTH': 'capability'}, {
        host + 'activation.rs': lambda s: guard(s, 'This update asks for more access or new migrations and needs administrator approval'),
    }),
    ('urgent-migration', 'growth needs host approval even when urgent: migration', {'JS410_GROWTH': 'migration'}, {
        host + 'activation.rs': lambda s: guard(s, 'This update asks for more access or new migrations and needs administrator approval'),
    }),
    ('stale-digest', 'changed digest must refuse stale review', {}, {
        app + 'module_install.rs': lambda s: replace(replace(s, 'artifact.digest != reviewed.digest', 'false'), 'artifact.version.to_string() != reviewed.version', 'false'),
        host + 'store.rs': lambda s: replace(guard(s, 'The package changed since review'), 'consent.digest == artifact.digest', 'true'),
    }),
    ('same-version-digest', 'same version changed digest must refuse stale review', {}, {
        app + 'module_install.rs': lambda s: replace(s, 'artifact.digest != reviewed.digest', 'false'),
        host + 'store.rs': lambda s: replace(guard(s, 'The package changed since review'), 'consent.digest == artifact.digest', 'true'),
        host + 'registry.rs': lambda s: guard(s, 'The registry changed a published version'),
    }),
    ('payload-actor', 'payload actor must be refused', {}, {
        'rust-spike/shell/contract/src/module_management.rs': lambda s: replace(s, '#[serde(deny_unknown_fields)]\npub struct UpdateModule', 'pub struct UpdateModule'),
    }),
    ('skip-offer', 'skip must name the current offer', {}, {
        app + 'module_install.rs': lambda s: guard(s, 'The offered update changed; review this module again'),
    }),
    ('pin-version', 'pin must name the installed version', {}, {
        host + 'store.rs': lambda s: guard(s, 'Install the selected version before pinning it'),
    }),
    ('pin', 'pin prevents update', {}, {
        host + 'store.rs': lambda s: replace(s, 'pin_override.or(pin).or(Some(&artifact.version))', 'pin_override.or(Some(&artifact.version))'),
        host + 'activation.rs': lambda s: guard(s, 'This module is pinned to another version'),
    }),
    ('skip-automatic', 'SKIP-DIGEST-MARKER', {}, {
        host + 'store.rs': lambda s: replace(s, '|| module.skipped_digest.as_deref() == Some(&artifact.digest)', ''),
    }),
    ('health', 'health failure refuses activation', {}, {
        host + 'activation.rs': lambda s: re.sub(r'                self\.host\.call\(\n(?:(?!                self\.host\.call).)*?"health",\n.*?\n                \)\?;', '', s, count=1, flags=re.S),
    }),
]
for name, marker, extra, edits in controls:
    if '--check' in sys.argv:
        for path, weaken in edits.items():
            assert weaken(Path(path).read_text()) != Path(path).read_text(), (name, path)
        print(f'Matches: {name}')
        continue
    if len(sys.argv) > 1 and name not in sys.argv[1:]:
        continue
    originals = {path: Path(path).read_text() for path in edits}
    env = {**os.environ, **extra}
    try:
        for path, weaken in edits.items():
            changed = weaken(originals[path])
            if changed == originals[path]:
                raise RuntimeError(f'Control did not edit {path}: {name}')
            Path(path).write_text(changed)
        print(f'CONTROL {name}: protection removed', flush=True)
        start = subprocess.run(['scripts/run-gate.sh', 'start', '--gate', 'test:rust-phase6-update-api'], env=env, text=True, capture_output=True)
        print(start.stdout, end='', flush=True)
        if start.returncode:
            raise RuntimeError(start.stderr + start.stdout)
        log = Path(re.search(r'^LOG=(.*)$', start.stdout, re.M)[1])
        wait = subprocess.run(['scripts/run-gate.sh', 'wait', '--follow'], env=env, text=True, capture_output=True)
        output = log.read_text()
        if wait.returncode != 1 or marker not in output or 'test result: FAILED' not in output:
            print(output[-6000:], flush=True)
            raise RuntimeError(f'{name} did not expose its expected refusal assertion: {marker}')
        print(f'PASS CONTROL {name}: expected assertion failed; {log}', flush=True)
    finally:
        for path, original in originals.items():
            Path(path).write_text(original)
print('Control sources restored. Run the normal gate to verify the restored application.', flush=True)
