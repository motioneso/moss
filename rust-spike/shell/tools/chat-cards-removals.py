#!/usr/bin/env python3
"""3b record-gate controls. Run sequentially inside verify-gate; restore every source byte."""
import os
from pathlib import Path
import re
import subprocess

if os.environ.get("JARVIS_GATE_RUN") != "1":
    raise SystemExit("Use verify-gate")
root = Path(__file__).resolve().parents[3]
logs = Path(os.environ["JS383_PROOF_DIR"]) / "card-removals"
logs.mkdir(parents=True, exist_ok=True)
manifest = "rust-spike/shell/Cargo.toml"
book = "rust-spike/shell/app/src/chat_approvals.rs"
runner = "rust-spike/shell/app/src/runner_data.rs"
exact = "chat_approvals::tests::approved_record_binds_actor_turn_tool_and_exact_parameters_once"
roundtrip = "runner_data::tests::socket::module_card_approve_reject_and_exact_record_gate_round_trip"
controls = [
    ("record-actor", book, r'r.actor == actor\s*&&\s*r.turn', 'r.turn', exact),
    ("record-turn", book, r'r.turn == turn\s*&&\s*r.state', 'r.state', exact),
    ("record-state", book, r'r.state == ApprovalState::Approved', 'true', exact),
    ("record-module", book, r'a.module == module && ', '', exact),
    ("record-tool", book, r'a.tool == tool && ', '', exact),
    ("record-parameters", book, r'a.parameters == \*parameters', 'true', exact),
    ("record-single-use", book, r'record.state = ApprovalState::Used;', '', exact),
    ("record-voided", book, r'if r\.turn == turn\s*&&', 'if false &&', "chat_approvals::tests::voided_action_cannot_be_used_in_a_later_turn"),
    ("record-dispatch", runner, r'if let Some\(action\) = approved\(module, &tool, &parameters\)', 'if let Some(action) = None::<chat_approvals::Action>', roundtrip),
    ("shown-version", runner, r'action.version.as_deref\(\)', 'None', roundtrip),
]

for name, source, pattern, replacement, test in controls:
    path = root / source
    original = path.read_bytes()
    changed, count = re.subn(pattern, replacement, original.decode(), flags=re.S)
    if count != 1:
        raise SystemExit(f"Expected one protection {name}; found {count}")
    command = ["cargo", "+1.95.0", "test", "--offline", "--locked", "--manifest-path", manifest, "--bin", "moss-shell", test, "--", "--exact"]
    for removed in [False, True, False]:
        try:
            path.write_text(changed if removed else original.decode())
            log = logs / f"{name}.{'removed' if removed else 'protected'}.log"
            with log.open("w") as out:
                result = subprocess.run(command, cwd=root, stdout=out, stderr=subprocess.STDOUT, timeout=600)
            output = log.read_text()
            expected = "test result: FAILED. 0 passed; 1 failed;" if removed else "test result: ok. 1 passed; 0 failed;"
            if expected not in output or result.returncode != (101 if removed else 0):
                print(output[-4000:], flush=True)
                raise SystemExit(f"Unexpected assertion result {name}: rc={result.returncode}")
            if removed:
                print(f"REMOVAL {name}: protected rc=0; removed rc=101; 1 assertion failed", flush=True)
                for line in output.splitlines():
                    if "panicked at" in line or line.startswith("assertion"):
                        print(f"  {line}", flush=True)
        finally:
            path.write_bytes(original)
print(f"PASS {len(controls)} card removal controls; source restored", flush=True)
