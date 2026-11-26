#!/usr/bin/env python3
"""Compile each guard removal in an isolated source tree; require the intended assertion."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--guard', choices=['signature', 'serial', 'expiry', 'hash', 'os', 'arch', 'schema'])
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
source = root / 'rust-spike/app-update'
mutations = {
    'signature': ('trust::verify(&self.public_key, bytes, signature)?;', '', 'UNSIGNED-GUARD'),
    'serial': ('index.serial >= seen.serial', 'true', 'OLDER-SERIAL-GUARD'),
    'expiry': ('index.expires > now', 'true', 'EXPIRED-GUARD'),
    'hash': ('bytes.len() as u64 == self.size && trust::digest(bytes) == self.digest', 'true', 'WRONG-HASH-GUARD'),
    'os': ('a.os == self.os && a.arch == self.arch', 'a.arch == self.arch', 'WRONG-OS-GUARD'),
    'arch': ('a.os == self.os && a.arch == self.arch', 'a.os == self.os', 'WRONG-ARCH-GUARD'),
    'schema': ('(artifact.schema_min..=artifact.schema_max).contains(&self.schema)', 'true', 'WRONG-SCHEMA-GUARD'),
}
for guard, (old, new, marker) in mutations.items():
    if args.guard and args.guard != guard:
        continue
    with tempfile.TemporaryDirectory(prefix='phase7-update-negative-') as temp:
        scratch = Path(temp) / 'rust-spike'
        shutil.copytree(source, scratch / 'app-update', ignore=shutil.ignore_patterns('target', '__pycache__'))
        (scratch / 'module-host/src').mkdir(parents=True)
        shutil.copyfile(root / 'rust-spike/module-host/src/trust_crypto.rs', scratch / 'module-host/src/trust_crypto.rs')
        path = scratch / 'app-update/src/lib.rs'
        text = path.read_text()
        if text.count(old) != 1:
            raise SystemExit(f'{guard}: guard source changed; update the negative control')
        path.write_text(text.replace(old, new))
        cmd = ['cargo', '+1.95.0', 'test', '--locked', '--manifest-path', str(scratch / 'app-update/Cargo.toml'), '--test', 'phase7_update_feed', 'phase7_update_feed', '--', '--exact', '--nocapture', '--test-threads=1']
        result = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        print(f'guard removed: {guard}; command: {" ".join(cmd)}; exit={result.returncode}', flush=True)
        if result.returncode == 0 or marker not in result.stdout:
            print(result.stdout[-10000:])
            raise SystemExit(f'{guard}: did not fail at {marker}')
        print(f'Observed expected failing assertion: {marker}', flush=True)
