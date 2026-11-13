#!/usr/bin/env python3
"""Removal controls for the place and unit checks. Each runs in a disposable copy with one
check removed and must make its test fail. No bypass switch ships in the host."""
from pathlib import Path
import os
import re
import shutil
import subprocess
import tempfile
import uuid

source = Path(__file__).resolve().parents[1]
controls = [
    ("latitude limit", r'degrees\("lat", 90\.0\)', 'degrees("lat", 1e9)', "latitude_range"),
    ("longitude limit", r'degrees\("lon", 180\.0\)', 'degrees("lon", 1e9)', "longitude_range"),
    ("label length limit", r't\.encode_utf16\(\)\.count\(\) <= 200', 't.encode_utf16().count() <= 100000', "label_length_counts_utf16_units"),
    ("blank label refusal", r'!t\.trim\(\)\.is_empty\(\) && t\.encode_utf16', 't.encode_utf16', "a_blank_label_is_refused"),
    ("exact member count", r'o\.len\(\) == 3 && degrees\("lat"', 'degrees("lat"', "a_place_has_exactly_three_members"),
    ("unit list", r'allowed\.contains\(&t\)', 'true', "a_unit_must_come_from_the_fixed_list"),
    ("re-check on read", r'&& !self\.accepts\(&value\)', '&& false', "a_stored_value_that_no_longer_fits_reads_as_unset"),
]
environment = dict(os.environ)
for name, pattern, replacement, test in controls:
    with tempfile.TemporaryDirectory(prefix=".weather-control-", dir=source.parent) as scratch:
        copy = Path(scratch)
        shutil.copytree(source, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns("target"))
        package_name = "moss-module-host-control-" + uuid.uuid4().hex
        for filename in ("Cargo.toml", "Cargo.lock"):
            package_file = copy / filename
            package_file.write_text(package_file.read_text().replace(
                'name = "moss-module-host"', f'name = "{package_name}"', 1))
        with (copy / "Cargo.toml").open("a") as manifest:
            manifest.write('\n[lib]\nname = "moss_module_host"\n')
        path = copy / "src/account_preferences.rs"
        changed, count = re.subn(pattern, replacement, path.read_text(), count=1)
        if count != 1:
            raise SystemExit(f"Control did not find its check: {name}")
        path.write_text(changed)
        run = subprocess.run(["cargo", "+1.95.0", "test", "--locked", "--offline", "--manifest-path", str(copy / "Cargo.toml"), "--lib", test], env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600)
        if run.returncode == 0 or "test result: FAILED" not in run.stdout:
            print(run.stdout[-3000:])
            raise SystemExit(f"Control was not a failing assertion: {name}")
        print(f"PASS removal control: {name} -> {test} failed with the check removed", flush=True)
