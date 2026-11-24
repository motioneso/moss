#!/usr/bin/env python3
"""Require each weakened request guard to fail the real-server scenario.

Run serially in an isolated worktree. Every control gets a fresh verify-gate database;
source bytes are restored even when a run fails. No application bypass is added.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def replace(source, before, after):
    if before not in source:
        raise RuntimeError(f"Control no longer matches: {before}")
    return source.replace(before, after, 1)


app = 'rust-spike/shell/app/src/module_install_requests.rs'
sql = 'rust-spike/shell/app/src/module_install_requests.sql'
dto = 'rust-spike/shell/contract/src/install_requests.rs'
controls = [
    ('payload-owner', 'REFUSAL: payload cannot name an owner', {
        dto: lambda s: replace(s, '#[serde(deny_unknown_fields)]\npub struct RequestInstall', 'pub struct RequestInstall'),
    }),
    ('foreign-read', 'REFUSAL: another account cannot read the request', {
        sql: lambda s: replace(s, 'USING (owner_account_id = app.current_actor_user_id() OR app.current_actor_is_admin());', 'USING (true);'),
    }),
    ('unavailable', 'REFUSAL: unavailable module cannot be requested', {
        app: lambda s: replace(s, 'if !offered {', 'if false && !offered {'),
    }),
    ('admin-approval', 'REFUSAL: member cannot bind approval', {
        # Remove all three layers before probing the persisted request binding. The
        # existing executor still refuses the member, but must not bind their approval.
        app: lambda s: replace(replace(s,
            '    if let Err(response) = module_admin::require_admin(&admin, &access).await {\n        return response;\n    }\n', ''),
            'module_management::owned(&admin, &access, &decision.operation)',
            'Record::read(&admin.instance, &decision.operation).map_err(|_| unavailable())'),
        sql: lambda s: replace(replace(s,
            'USING (app.current_actor_is_admin())', 'USING (true)'),
            'WITH CHECK (app.current_actor_is_admin() AND approved_by = app.current_actor_user_id());',
            'WITH CHECK (approved_by = app.current_actor_user_id());'),
    }),
    ('explicit-approval', 'REFUSAL: approval must be explicit', {
        app: lambda s: replace(s, 'if !decision.approve {', 'if false && !decision.approve {'),
    }),
    ('review-source', 'REFUSAL: review must match the requested source', {
        app: lambda s: replace(s, '|| review.source != saved.source', '|| false'),
    }),
    ('completed-binding', 'REFUSAL: completed binding cannot be replaced', {
        app: lambda s: replace(s, 'if !same_operation && !(retryable && fresh_review)', 'if !same_operation && !fresh_review'),
    }),
]

for name in ['CARGO_HOME', 'RUSTUP_HOME', 'CARGO_TARGET_DIR']:
    if not os.environ.get(name):
        raise RuntimeError('Set task-owned ' + name)
env = {**os.environ, 'CARGO_BUILD_JOBS': '1', 'CARGO_PROFILE_DEV_DEBUG': '0', 'CARGO_PROFILE_TEST_DEBUG': '0'}
results = []
for name, marker, edits in controls:
    originals = {path: Path(path).read_bytes() for path in edits}
    if '--check' in sys.argv:
        for path, weaken in edits.items():
            assert weaken(originals[path].decode()) != originals[path].decode(), name
        print('Matches: ' + name)
        continue
    if len(sys.argv) > 1 and name not in sys.argv[1:]:
        continue
    try:
        for path, weaken in edits.items():
            Path(path).write_text(weaken(originals[path].decode()))
        print('CONTROL START ' + name, flush=True)
        start = subprocess.run(['scripts/run-gate.sh', 'start', '--gate', 'test:rust-phase6-install-requests'], env=env, text=True, capture_output=True)
        print(start.stdout, end='', flush=True)
        if start.returncode:
            raise RuntimeError(start.stderr + start.stdout)
        log = re.search(r'^LOG=(.+)$', start.stdout, re.M)[1]
        with open('/tmp/js416-control-wait.log', 'w') as output:
            wait = subprocess.run(['scripts/run-gate.sh', 'wait', '--follow', '--log', log], stdout=output, stderr=subprocess.STDOUT)
        text = Path(log).read_text()
        observed = wait.returncode == 1 and marker in text and 'test result: FAILED.' in text
        results.append({'control': name, 'log': log, 'wait_exit': wait.returncode, 'expected_assertion': marker, 'observed': observed})
        Path('/tmp/js416-controls.json').write_text(json.dumps(results, indent=2))
        print('CONTROL END ' + name + ' ' + str(observed), flush=True)
        if not observed:
            raise RuntimeError('Unexpected result; inspect ' + log)
    finally:
        for path, original in originals.items():
            Path(path).write_bytes(original)
