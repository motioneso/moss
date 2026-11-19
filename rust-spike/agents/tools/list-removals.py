#!/usr/bin/env python3
"""Observe assertion failures with each runner/list protection removed, then restore bytes."""
import os
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[1]
logs = Path(os.environ.get("JS367_PROOF_DIR", "/tmp/js367-proof")) / "removals"
logs.mkdir(parents=True, exist_ok=True)
for key in ["CARGO_HOME", "CARGO_TARGET_DIR"]:
    if not os.environ.get(key):
        raise SystemExit(f"Set {key}")
cargo = ["cargo", "+1.95.0", "test", "--offline", "--locked", "--manifest-path", str(root / "Cargo.toml")]
controls = [
    ("gateway-offered-list", "src/gateway.rs", r'let Some\(def\) = host.tools\(account\).into_iter\(\).find\(\|t\| t.name == name\) else \{.*?\n    \};', 'let def = host.tools(account).into_iter().find(|t| t.name == name).unwrap_or_else(crate::builtins::current_time);', ["--lib", "gateway::tests::an_unoffered_tool_is_refused_before_execution"]),
    ("account-list", "src/turn_tools.rs", r'if account != self.account \{\s*return vec!\[\];\s*\}', '', ["--lib", "turn_tools::tests::a_turn_list_and_execution_do_not_cross_accounts"]),
    ("account-execution", "src/turn_tools.rs", r'if account != self.account \{\s*return Box::pin\(async \{ Err\("Wrong tool account".into\(\)\) \}\);\s*\}', '', ["--lib", "turn_tools::tests::a_turn_list_and_execution_do_not_cross_accounts"]),
    ("gateway-hello", "src/gateway.rs", r'if crate::hello::same_secret\(&lease, expected\)', 'if true', ["--lib", "gateway::tests::wrong_gateway_lease_cannot_list_tools"]),
    ("runner-hello", "src/bin/moss-runner.rs", r'if moss_agents::hello::same_secret\(&s, &secret\)', 'if true', ["--bin", "moss-runner", "tests::runner_requires_the_hello_secret_before_ready"]),
]

def run(name, args, removed):
    path = logs / f"{name}.{'removed' if removed else 'protected'}.log"
    with path.open("w") as output:
        result = subprocess.run(cargo + args + ["--", "--exact"], stdout=output, stderr=subprocess.STDOUT, timeout=300)
    text = path.read_text()
    expected = "test result: FAILED. 0 passed; 1 failed;" if removed else "test result: ok. 1 passed; 0 failed;"
    if expected not in text or (result.returncode == 0) == removed:
        print(text[-4000:])
        raise SystemExit(f"Unexpected control result for {name}: rc={result.returncode}")
    if removed and "assertion" not in text and "wrong " not in text:
        raise SystemExit(f"No assertion evidence for {name}")
    return result.returncode

for name, source, pattern, replacement, args in controls:
    path = root / source
    original = path.read_bytes()
    changed, count = re.subn(pattern, replacement, original.decode(), flags=re.S)
    if count != 1:
        raise SystemExit(f"Expected one protection for {name}, found {count}")
    run(name, args, False)
    try:
        path.write_text(changed)
        red = run(name, args, True)
    finally:
        path.write_bytes(original)
    run(name, args, False)
    print(f"REMOVAL {name}: protected rc=0, removed rc={red} (1 assertion failed), restored rc=0", flush=True)
print(f"PASS {len(controls)} removal controls; source restored")
