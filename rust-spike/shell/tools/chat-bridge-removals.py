#!/usr/bin/env python3
"""Sequential assertion-removal controls in the task checkout; always restore source bytes."""
import os
from pathlib import Path
import re
import subprocess

if os.environ.get("JARVIS_GATE_RUN") != "1":
    raise SystemExit("Use verify-gate")
root = Path(__file__).resolve().parents[3]
logs = Path(os.environ["JS368_PROOF_DIR"]) / "removals"
logs.mkdir(parents=True, exist_ok=True)
base = ["cargo", "+1.95.0", "test", "--offline", "--locked", "--manifest-path"]
server_test = ["--bin", "moss-shell", "runner_data::tests::forged_names_old_turns_and_repeated_ids_do_not_dispatch"]
bridge_test = ["--lib", "tool_bridge::tests::results_are_bound_to_the_pending_call_and_consumed_once"]
controls = [
    ("server-offered-list", "rust-spike/shell/app/src/runner_data.rs", r'self\.offered\.get\(name\)', 'self.offered.get(name).or_else(|| self.offered.values().next())', "rust-spike/shell/Cargo.toml", server_test),
    ("server-turn-id", "rust-spike/shell/app/src/runner_data.rs", r'!valid_id \|\| ', '', "rust-spike/shell/Cargo.toml", server_test),
    ("server-replay", "rust-spike/shell/app/src/runner_data.rs", r' \|\| !self\.used\.insert\(id.to_owned\(\)\)', '', "rust-spike/shell/Cargo.toml", server_test),
    ("duplicate-wire-name", "rust-spike/shell/app/src/runner_data.rs", r'if !names.insert\(def.name.clone\(\)\)', 'if names.insert(def.name.clone()) && false', "rust-spike/shell/Cargo.toml", ["--bin", "moss-shell", "runner_data::tests::duplicate_wire_names_prevent_a_turn_from_opening"]),
    ("bridge-account", "rust-spike/agents/src/tool_bridge.rs", r'if account != self.account', 'if false', "rust-spike/agents/Cargo.toml", bridge_test),
    ("bridge-result-id", "rust-spike/agents/src/tool_bridge.rs", r'let tx = self.state.lock\(\).unwrap\(\).pending.remove\(call_id\);', 'let mut state = self.state.lock().unwrap(); let key = state.pending.keys().next().cloned(); let tx = key.and_then(|key| state.pending.remove(&key));', "rust-spike/agents/Cargo.toml", bridge_test),
    ("install-name-cap", "rust-spike/module-host/src/tool_names.rs", r'\s*&& "mcp__moss__".len\(\) \+ name.len\(\) <= 110', '', "rust-spike/module-host/Cargo.toml", ["--test", "chat_tools", "schema::prefixed_tool_names_fit_the_measured_claude_limit"]),
]

def run(name, manifest, args, removed):
    log = logs / f"{name}.{'removed' if removed else 'protected'}.log"
    with log.open("w") as out:
        result = subprocess.run(base + [manifest] + args + ["--", "--exact"], cwd=root, stdout=out, stderr=subprocess.STDOUT, timeout=600)
    output = log.read_text()
    expected = "test result: FAILED. 0 passed; 1 failed;" if removed else "test result: ok. 1 passed; 0 failed;"
    if expected not in output or (result.returncode == 0) == removed:
        print(output[-4500:], flush=True)
        raise SystemExit(f"Unexpected control result {name} rc={result.returncode}")
    return output

for name, source, pattern, replacement, manifest, args in controls:
    path = root / source
    original = path.read_bytes()
    changed, count = re.subn(pattern, replacement, original.decode(), flags=re.S)
    if count != 1:
        raise SystemExit(f"Expected one protection {name}; found {count}")
    run(name, manifest, args, False)
    try:
        path.write_text(changed)
        output = run(name, manifest, args, True)
        print(f"REMOVAL {name}: protected rc=0; removed rc=101; 1 assertion failed", flush=True)
        for line in output.splitlines():
            if "FAILED" in line or "panicked at" in line or line.startswith("assertion"):
                print(f"  {line}", flush=True)
    finally:
        path.write_bytes(original)
    run(name, manifest, args, False)
print(f"PASS {len(controls)} bridge removal controls; original source restored", flush=True)
