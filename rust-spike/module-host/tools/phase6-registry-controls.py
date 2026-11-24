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
    ('admin', 'registry configuration is admin-only', {}, {
        app + 'module_registries.rs': lambda s: replace(s, 'if let Err(response) = module_admin::require_admin(&admin, &access).await {\n        return response;\n    }', ''),
    }),
    ('preview-actor', 'list preview belongs to actor', {}, {
        app + 'module_lists.rs': lambda s: guard(s, 'Preview belongs to another account'),
    }),
    ('pending-root', 'pending source cannot install', {}, {
        app + 'module_registries.rs': lambda s: replace(s, 'save_pending(instance, &staged)?;', 'module_sources::write(instance, &staged)?; save_pending(instance, &staged)?;'),
    }),
    ('fingerprint', 'confirm actual fingerprint', {}, {
        app + 'module_registries.rs': lambda s: guard(s, 'Confirm the actual root fingerprint'),
    }),
    ('signature', 'reject signature', {'JS414_FAULT':'signature'}, {
        host + 'registry.rs': lambda s: replace(s, 'trust::verify(key, &bytes, &sig)?;', ''),
    }),
    ('publisher', 'reject publisher', {'JS414_FAULT':'publisher'}, {
        host + 'trust.rs': lambda s: guard(s, 'The publisher cannot sign this module name'),
    }),
    ('first-party', 'reject first-party', {'JS414_FAULT':'first-party'}, {
        # Both identity validation and module-name validation enforce this boundary.
        host + 'trust.rs': lambda s: guard(guard(s, 'A registry cannot assign first-party module names'), 'The publisher cannot sign this module name'),
    }),
    ('bundle', 'reject bundle', {'JS414_FAULT':'bundle'}, {
        host + 'registry.rs': lambda s: guard(s, 'Bundle does not match signed index'),
    }),
    ('bytes', 'reject bytes', {'JS414_FAULT':'bytes'}, {
        app + 'module_registries.rs': lambda s: guard(s, 'Wrong package bytes'),
    }),
    ('expiry', 'expired index refuses actual installation', {}, {
        host + 'registry.rs': lambda s: guard(s, 'This registry index has expired; installed modules keep running'),
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
        start = subprocess.run(['scripts/run-gate.sh', 'start', '--gate', 'test:rust-phase6-registry-api'], env=env, text=True, capture_output=True)
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
