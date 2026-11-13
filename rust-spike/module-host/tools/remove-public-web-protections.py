#!/usr/bin/env python3
"""Removal controls for the public-web fetch mode. Each protection is deleted in a disposable
copy and the named test must then fail. No bypass switch ships in the host."""
from pathlib import Path
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

source = Path(__file__).resolve().parents[1]
W = "src/public_web.rs"
controls = [
    ("public address rule", W, r"crate::registry::public_ip\(ip\) && !six_to_four", "true", "private_loopback_tailnet_and_reserved_destinations_never_reach_the_network"),
    ("6to4 refusal", W, r"crate::registry::public_ip\(ip\) && !six_to_four", "crate::registry::public_ip(ip)", "public_web::tests::addresses_in_private_ranges_are_never_public"),
    ("address check after name lookup", W, r"for ip in &resolved\.checked \{\s*ensure_public\(\*ip\)\?;\s*\}", "", "every_redirect_hop_is_checked_again"),
    ("destination re-check on redirect hops (robots probe also off, since it would catch the same address)", W, r"let robots_off = !gated \|\| ", "let robots_off = true || ", "every_redirect_hop_is_checked_again", (r"let host = self\.check_destination\(&current, options\)\?;", 'let host = if hops == 0 { self.check_destination(&current, options)? } else { current.host_str().unwrap_or("").to_string() };')),
    ("https-only rule", W, r'if url\.scheme\(\) == "http" \{', "if false {", "only_https_on_the_standard_port_without_a_password_is_allowed"),
    ("robots rules", W, r"if !robots_off && !self\.robots_allow", "if false && !self.robots_allow", "robots_rules_are_honoured_and_an_unreadable_file_blocks"),
    ("unreadable robots file blocks", W, r"_ => Robots::deny_all\(\),", "_ => Robots::allow_all(),", "robots_rules_are_honoured_and_an_unreadable_file_blocks"),
    ("robots skip limited to the Reddit feed host", W, r"options\.skip_robots && host == ROBOTS_EXCEPTION_HOST", "options.skip_robots", "only_the_reddit_feed_address_may_skip_robots"),
    ("activity omits request text", "src/services.rs", r'json!\(\{"port":port,"operation":r\.operation,"resource":r\.resource,', 'json!({"port":port,"operation":r.operation,"resource":r.resource,"parameters":r.parameters,', "activity_names_the_mode_only_and_belongs_to_one_person"),
    ("activity written to a shared account instead of the caller", "src/services.rs", r'scope\.access\(\),(\s*)"activity",', r'&AccessContext::new(uuid::Uuid::nil(), "write"),\1"activity",', "activity_names_the_mode_only_and_belongs_to_one_person"),
]
all_controls = list(controls)
if len(sys.argv) > 1:
    controls = [c for c in controls if sys.argv[1] in c[0]]
base = dict(os.environ)
for name, file, pattern, replacement, test, *also in controls:
    with tempfile.TemporaryDirectory(prefix=".pw-control-", dir=source.parent) as scratch:
        copy = Path(scratch)
        shutil.copytree(source, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns("target"))
        package = "moss-module-host-control-" + uuid.uuid4().hex
        for filename in ("Cargo.toml", "Cargo.lock"):
            f = copy / filename
            f.write_text(f.read_text().replace('name = "moss-module-host"', f'name = "{package}"', 1))
        with (copy / "Cargo.toml").open("a") as manifest:
            manifest.write('\n[lib]\nname = "moss_module_host"\n')
        path = copy / file
        changed, count = re.subn(pattern, replacement, path.read_text(), count=1, flags=re.S)
        if count != 1:
            raise SystemExit(f"Control did not find its protection: {name}")
        for other in also:
            p2, r2 = other
            changed, extra = re.subn(p2, r2, changed, count=1, flags=re.S)
            if extra != 1:
                raise SystemExit(f"Control did not find its second protection: {name}")
        path.write_text(changed)
        if test.startswith("public_web::"):
            args = ["--lib", test, "--", "--exact"]
        else:
            args = ["--test", "public_web", test, "--", "--exact"]
        run = subprocess.run(["cargo", "test", "--offline", "--locked", "--manifest-path", str(copy / "Cargo.toml"), *args], env=base, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
        if run.returncode == 0 or "test result: FAILED" not in run.stdout:
            print(run.stdout[-3000:])
            raise SystemExit(f"Control was not a failing assertion: {name}")
        print(f"PASS removal control: {name} -> {test} failed with the protection removed", flush=True)
print("All removal controls failed as expected; the working tree was never mutated.")
