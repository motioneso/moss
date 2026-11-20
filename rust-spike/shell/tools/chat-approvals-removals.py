#!/usr/bin/env python3
"""Part 3a approval assertion-removal controls in the task checkout; always restore source bytes."""
import os
from pathlib import Path
import re
import subprocess

if os.environ.get("JARVIS_GATE_RUN") != "1":
    raise SystemExit("Use verify-gate")
root = Path(__file__).resolve().parents[3]
logs = Path(os.environ["JS370_PROOF_DIR"]) / "approval-removals"
logs.mkdir(parents=True, exist_ok=True)
base = ["cargo", "+1.95.0", "test", "--offline", "--locked", "--manifest-path"]
def server(test):
    return ["--bin", "moss-shell", test]

controls = [
    ("approval-owner", "rust-spike/shell/app/src/chat_approvals.rs", r' && r\.actor == actor\)', ')', "rust-spike/shell/Cargo.toml", server("chat_approvals::tests::another_account_cannot_answer_an_approval_and_sees_it_as_unknown")),
    ("turn-end-void-record", "rust-spike/shell/app/src/chat_approvals.rs", r'if r\.turn == turn\s*&&', 'if false &&', "rust-spike/shell/Cargo.toml", server("chat_approvals::tests::no_approval_outlives_its_turn")),
    ("turn-end-void-call", "rust-spike/shell/app/src/runner_data.rs", r'st\.book\.void_turn\(turn_id\);', '', "rust-spike/shell/Cargo.toml", server("runner_data::tests::socket::the_turn_limit_ends_a_stuck_turn_and_voids_its_card")),
    ("expired-cannot-be-used", "rust-spike/shell/app/src/runner_data.rs", r'        self\.expire\(Instant::now\(\)\);\n        \{', '        {', "rust-spike/shell/Cargo.toml", server("runner_data::tests::socket::an_expired_card_cannot_be_approved_even_before_the_sweep_runs")),
    ("expiry-answers-runner", "rust-spike/shell/app/src/runner_data.rs", r'for id in refused \{', 'for id in refused.into_iter().take(0) {', "rust-spike/shell/Cargo.toml", server("runner_data::tests::socket::an_unanswered_card_times_out_and_the_runner_is_told_no")),
    ("turn-limit", "rust-spike/shell/app/src/runner_data.rs", r'if started\.elapsed\(\) >= self\.limits\.turn \{', 'if false {', "rust-spike/shell/Cargo.toml", server("runner_data::tests::socket::the_turn_limit_ends_a_stuck_turn_and_voids_its_card")),
    ("fixed-card-title", "rust-spike/shell/app/src/runner_data.rs", r'chat_approvals::PERMISSION_TITLE\.into\(\)', 'm["card"]["title"].as_str().unwrap_or_default().to_string()', "rust-spike/shell/Cargo.toml", server("runner_data::tests::socket::an_agent_permission_ask_is_answered_only_by_its_owner_through_the_record")),
    ("card-values-redacted", "rust-spike/shell/app/src/chat_approvals.rs", r'let value = moss_agents::redact::redact_line\(value\);', 'let value = value.to_string();', "rust-spike/shell/Cargo.toml", server("chat_approvals::tests::the_card_title_is_fixed_and_agent_text_is_a_capped_field_value")),
    ("idle-clock-paused-while-waiting", "rust-spike/shell/app/src/runner_data.rs", r'            if waiting \{\n                last_heard = Instant::now\(\);\n            \}\n', '', "rust-spike/shell/Cargo.toml", server("runner_data::tests::socket::answering_a_card_after_the_idle_limit_does_not_end_the_turn")),
    ("runner-ask-timer", "rust-spike/agents/src/bin/moss-runner.rs", r'match tokio::time::timeout\(limit, rx\)\.await \{', 'match Ok::<_, ()>(rx.await) {', "rust-spike/agents/Cargo.toml", ["--bin", "moss-runner", "tests::an_unanswered_ask_is_refused_when_its_timer_runs_out"]),
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
print(f"PASS {len(controls)} approval removal controls; original source restored", flush=True)
