#!/usr/bin/env python3
"""Part 4d security controls. Run alone through the disposable chat bridge gate."""
import os
from pathlib import Path
import subprocess

if os.environ.get("JARVIS_GATE_RUN") != "1":
    raise SystemExit("Use scripts/run-gate.sh with JS389_REMOVALS=1")
root = Path(__file__).resolve().parents[3]
logs = Path(os.environ.get("JS389_PROOF_DIR", "/tmp/js389-proof"))
logs.mkdir(parents=True, exist_ok=True)
controls = [
    ("calendar-fixed-card", "modules/calendar/src/chat.rs",
     'Ok(json!({"fields":fields}))',
     'Ok(json!({"fields":fields,"target":input["parameters"]["title"]}))',
     "modules/calendar/src/Cargo.toml", ["--lib", "requested_title_is_a_field_value"]),
    ("meals-fixed-card", "modules/meals/src/chat.rs",
     'Ok(json!({"fields":fields}))',
     'Ok(json!({"fields":fields,"target":input["parameters"]["name"]}))',
     "modules/meals/src/Cargo.toml", ["--lib", "model_values_only_fill_code_labelled_fields"]),
    ("reply-field-placement", "modules/connectors/src/chat.rs",
     'card.as_object_mut().unwrap().remove("target");', '',
     "modules/connectors/src/Cargo.toml", ["--test", "email_writes", "chat_adapter_keeps_saved_recipient_and_subject_in_fields"]),
    ("calendar-preview-no-effect", "modules/calendar/src/chat.rs",
     'let mut fields = vec![json!({"label":"Action","value":action})];',
     'let _ = host.call("kv", "set", "connectors.write-calendar-insert", json!({})); let mut fields = vec![json!({"label":"Action","value":action})];',
     "modules/calendar/src/Cargo.toml", ["--lib", "requested_title_is_a_field_value"]),
    ("reply-preview-no-effect", "modules/connectors/src/chat.rs",
     'let mut card = email_writes::prepare(host, &input["parameters"])?;',
     'let _ = host.call("kv", "set", "connectors.write-gmail-send", json!({})); let mut card = email_writes::prepare(host, &input["parameters"])?;',
     "modules/connectors/src/Cargo.toml", ["--test", "email_writes", "chat_adapter_keeps_saved_recipient_and_subject_in_fields"]),
    ("upsert-receipt", "modules/meals/src/chat_changes.rs",
     'if k == \"owner_user_id\" {\n                                    Filter::Owned', 'if k == \"owner_user_id\" {\n                                    Filter::eq(k, Value::Null)',
     "modules/meals/src/Cargo.toml", ["--lib", "upsert_receipt_handles_host_injected_ownership"]),
    ("sending-risk", "modules/connectors/moss.module.json",
     '"risk": "destructive"', '"risk": "write"',
     "rust-spike/module-host/Cargo.toml", ["--test", "chat_part4d_manifests", "sending_tools_always_declare_destructive_and_require_a_card"]),
]
for name, source, old, new, manifest, tests in controls:
    path = root / source
    original = path.read_bytes()
    text = original.decode()
    if text.count(old) != 1:
        raise SystemExit(f"{name}: expected exactly one removal site")
    try:
        for state in ["protected", "removed", "restored"]:
            path.write_text(text.replace(old, new) if state == "removed" else text)
            command = ["cargo", "+1.95.0", "test", "--offline", "--locked", "--manifest-path", manifest, *tests]
            log = logs / f"{name}-{state}.log"
            with log.open("w") as output:
                result = subprocess.run(command, cwd=root, stdout=output, stderr=subprocess.STDOUT)
            actual = log.read_text()
            expected = 101 if state == "removed" else 0
            marker = "test result: FAILED. 0 passed; 1 failed;" if state == "removed" else "test result: ok. 1 passed; 0 failed;"
            if result.returncode != expected or marker not in actual:
                raise SystemExit(f"{name} {state}: unexpected result {result.returncode}; inspect {log}")
        print(f"REMOVAL {name}: protected rc=0; removed rc=101 (1 assertion failed); restored rc=0", flush=True)
    finally:
        path.write_bytes(original)
print("PASS 7 part 4d removal controls; source restored", flush=True)
