#!/usr/bin/env python3
"""Observe Finance chat assertions fail with their protections removed, then restore bytes."""
import os
from pathlib import Path
import subprocess

if os.environ.get("JARVIS_GATE_RUN") != "1":
    raise SystemExit("Use verify-gate")
root = Path(__file__).resolve().parents[3]
logs = Path(os.environ["CARGO_TARGET_DIR"]) / "chat-controls"
logs.mkdir(parents=True, exist_ok=True)
controls = [
    ("fixed-labels", "modules/finance/src/chat.rs",
     'let label = property["description"].as_str().ok_or_else(bad)?;',
     'let label = parameters.get("name").and_then(Value::as_str).unwrap_or("Fallback");',
     "model_values_only_appear_in_labelled_fields"),
    ("complete-card-values", "modules/finance/src/chat.rs",
     "if label.len() > 120 {", "if label.len() > 120 || value.len() > 4096 {",
     "large_batches_and_unicode_notes_keep_every_value_in_full"),
    ("singleton-receipt", "modules/finance/src/chat_changes.rs",
     "if table.keys.is_empty() {", "if false {",
     "budget_configure_tool_uses_host_valid_receipt_filters"),
    ("receipt-projection", "modules/finance/src/chat_changes.rs",
     "project(&before, table.columns)", "json!(before)",
     "receipts_do_not_include_internal_row_columns"),
]
for name, source, protection, removed, test in controls:
    path = root / source
    original = path.read_bytes()
    assert original.decode().count(protection) == 1, name
    command = ["cargo", "+1.95.0", "test", "--offline", "--locked", "--manifest-path",
               "modules/finance/src/Cargo.toml", "--test", "chat", test, "--", "--exact"]
    for removal in [False, True, False]:
        try:
            path.write_text(original.decode().replace(protection, removed) if removal else original.decode())
            log = logs / f"{name}.{'removed' if removal else 'protected'}.log"
            with log.open("w") as output:
                run = subprocess.run(command, cwd=root, stdout=output, stderr=subprocess.STDOUT)
            text = log.read_text()
            expected = "test result: FAILED. 0 passed; 1 failed;" if removal else "test result: ok. 1 passed; 0 failed;"
            if run.returncode != (101 if removal else 0) or expected not in text:
                print(text[-4000:], flush=True)
                raise SystemExit(f"Unexpected assertion result: {name}, exit {run.returncode}")
            print(f"Finance chat {name}: {'removed' if removal else 'protected'} exit {run.returncode}; one assertion", flush=True)
        finally:
            path.write_bytes(original)
print(f"PASS {len(controls)} Finance chat removal controls; source restored", flush=True)
