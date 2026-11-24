#!/usr/bin/env python3
"""Serial guard-removal proofs against the real server; source is restored after each run."""
import os
from pathlib import Path
import re
import subprocess
import sys


def replace(source, before, after):
    assert before in source, before
    return source.replace(before, after, 1)


def guard(source, message):
    at = source.index('"' + message + '"')
    start = source.rindex('ensure!(', 0, at)
    end = source.index(');', at) + 2
    return source[:start] + source[end:]


app = 'rust-spike/shell/app/src/'
host = 'rust-spike/module-host/src/'
auth = '''    if let Err(response) = module_admin::require_admin(&admin, &access).await {
        return response;
    }
'''
controls = [
    ('payload-actor', 'payload actor refused', {
        app + 'module_policy.rs': lambda s: replace(s, '#[serde(deny_unknown_fields)]', ''),
    }),
    ('account-off', 'account-off refuses its own route', {
        host + 'invocation.rs': lambda s: guard(s, 'This module is switched off for this account'),
    }),
    ('server-admin', 'server switch is admin only', {
        app + 'module_policy.rs': lambda s: replace(s, auth, ''),
        host + 'module_policy.rs': lambda s: replace(s, '        self.admin(access)?;', ''),
    }),
    ('server-off', 'admin-off stops other accounts', {
        host + 'invocation.rs': lambda s: guard(s, 'This module is disabled'),
    }),
    ('policy-admin', 'update policy is admin only', {
        app + 'module_policy.rs': lambda s: s[:s.index('async fn save_policy')] + replace(s[s.index('async fn save_policy'):], auth, ''),
        host + 'module_policy.rs': lambda s: s[:s.index('    pub fn set_update_policy')] + replace(s[s.index('    pub fn set_update_policy'):], '        self.admin(access)?;', ''),
    }),
    ('pin', 'pinned update never auto-activates', {
        host + 'store.rs': lambda s: replace(replace(s, '                || module.pin.is_some()\n', ''), '.and_then(|v| v.pin.as_ref());', '.and_then(|_| None);'),
        host + 'activation.rs': lambda s: guard(s, 'This module is pinned to another version'),
    }),
    ('manual-policy', 'manual update policy refuses auto-activation', {
        host + 'store.rs': lambda s: replace(s, 'state.update_policy.automatic && (quiet_time || artifact.urgent)', 'quiet_time || artifact.urgent'),
    }),
    ('quiet-time', 'ordinary update waits for quiet time', {
        host + 'store.rs': lambda s: replace(s, 'state.update_policy.automatic && (quiet_time || artifact.urgent)', 'state.update_policy.automatic'),
    }),
    ('growth', 'capability growth never auto-activates', {
        host + 'store.rs': lambda s: replace(s, 'if approval.required() {', 'if false {'),
        host + 'activation.rs': lambda s: guard(s, 'This update asks for more access or new migrations and needs administrator approval'),
    }),
    ('duplicate-open', 'open reaches real client once', {
        app + 'module_management.rs': lambda s: replace(s, 'match projection(&admin, &access, cached).await {', 'match projection(&admin, &access, false).await {'),
    }),
]
for name, marker, edits in controls:
    if '--check' in sys.argv:
        for path, weaken in edits.items():
            assert weaken(Path(path).read_text()) != Path(path).read_text(), name
        print(f'Matches: {name}')
        continue
    if len(sys.argv) > 1 and name not in sys.argv[1:]:
        continue
    originals = {path: Path(path).read_text() for path in edits}
    try:
        for path, weaken in edits.items():
            Path(path).write_text(weaken(originals[path]))
        print(f'CONTROL {name}: protection removed', flush=True)
        start = subprocess.run(['scripts/run-gate.sh', 'start', '--gate', 'test:rust-phase6-module-policy'], text=True, capture_output=True)
        print(start.stdout, end='', flush=True)
        if start.returncode:
            raise RuntimeError(start.stderr + start.stdout)
        log = Path(re.search(r'^LOG=(.*)$', start.stdout, re.M)[1])
        wait = subprocess.run(['scripts/run-gate.sh', 'wait', '--follow'], text=True, capture_output=True)
        output = log.read_text()
        if wait.returncode != 1 or marker not in output or 'test result: FAILED' not in output:
            print(output[-5000:], flush=True)
            raise RuntimeError(f'{name} did not reach its expected assertion: {marker}')
        print(f'PASS CONTROL {name}: expected assertion failed; {log}', flush=True)
    finally:
        for path, original in originals.items():
            Path(path).write_text(original)
print('Control sources restored. Run the normal gate on restored sources.', flush=True)
