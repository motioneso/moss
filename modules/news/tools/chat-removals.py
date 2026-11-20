#!/usr/bin/env python3
"""Part 4a adapter controls; run sequentially through the disposable News gate."""
import os
from pathlib import Path
import subprocess

if os.environ.get("JARVIS_GATE_RUN") != "1":
    raise SystemExit("Use verify-gate")
root = Path(__file__).resolve().parents[3]
logs = Path(os.environ["JS386_PROOF_DIR"]) / "module-removals"
logs.mkdir(parents=True, exist_ok=True)
controls = [
    ("scratchpad-long-card", "modules/scratchpad/src/tools.rs",
     'filter(|s| s.len() > 4096)', 'filter(|_| false)',
     "modules/scratchpad/src/Cargo.toml", "tools", "chat_append_reports_the_actual_change_and_adapts_the_card"),
    ("news-pinned-manifest", "modules/news/moss.module.json",
     '"approvalVersion": true', '"approvalVersion": false',
     "modules/news/host/Cargo.toml", "installed", "chat_refresh_uses_empty_schema_and_the_pinned_card_adapter"),
    ("scratchpad-card-tool", "modules/scratchpad/src/tools.rs",
     'if input["tool"] != "scratchpad.append" {', 'if false {',
     "modules/scratchpad/src/Cargo.toml", "tools", "chat_append_reports_the_actual_change_and_adapts_the_card"),
    ("news-card-empty-input", "modules/news/src/approval.rs",
     'tool == "news.refreshNews" && input.is_empty()', 'tool == "news.refreshNews"',
     "modules/news/src/Cargo.toml", "part7", "chat_card_adapter_uses_the_refresh_card_and_empty_input"),
    ("news-card-tool", "modules/news/src/approval.rs",
     'tool == "news.refreshNews" && input.is_empty()', 'input.is_empty()',
     "modules/news/src/Cargo.toml", "part7", "chat_card_adapter_uses_the_refresh_card_and_empty_input"),
    ("scratchpad-done", "modules/scratchpad/src/tools.rs",
     ',"changed":[{"label":"Text appended","before":"","after":added["appended"]}]', '',
     "modules/scratchpad/src/Cargo.toml", "tools", "chat_append_reports_the_actual_change_and_adapts_the_card"),
]
for name, source, before, after, manifest, suite, test in controls:
    path = root / source
    original = path.read_bytes()
    if original.decode().count(before) != 1:
        raise SystemExit(f"Expected one protection: {name}")
    command = ["cargo", "+1.95.0", "test", "--offline", "--locked", "--manifest-path", manifest,
               "--test", suite, test, "--", "--exact"]
    if "/host/" in manifest:
        command += ["--ignored", "--nocapture", "--test-threads=1"]
    for state in ["protected", "removed", "restored"]:
        try:
            path.write_bytes(original.replace(before.encode(), after.encode()) if state == "removed" else original)
            log = logs / f"{name}.{state}.log"
            with log.open("w") as output:
                result = subprocess.run(command, cwd=root, stdout=output, stderr=subprocess.STDOUT, timeout=600)
            output = log.read_text()
            removed = state == "removed"
            marker = "test result: FAILED. 0 passed; 1 failed;" if removed else "test result: ok. 1 passed; 0 failed;"
            if result.returncode != (101 if removed else 0) or marker not in output:
                print(output[-4000:], flush=True)
                raise SystemExit(f"Unexpected result {name} {state}: rc={result.returncode}")
            print(f"CONTROL {name}: {state} rc={result.returncode}; " + ("assertion failed" if removed else "1 passed"), flush=True)
        finally:
            path.write_bytes(original)
print("PASS 6 module removal controls; original source restored", flush=True)
