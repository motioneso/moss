#!/usr/bin/env python3
"""Part 4b assertions with the installed guest protection removed, then restored."""
import os
from pathlib import Path
import subprocess

assert os.environ.get("JARVIS_GATE_RUN") == "1", "Use verify-gate"
root = Path(__file__).resolve().parents[3]
target = Path(os.environ["CARGO_TARGET_DIR"])
logs = Path(os.environ["JS387_PROOF_DIR"]) / "module-removals"
logs.mkdir(parents=True, exist_ok=True)
controls = [
    ("sports-shown-version", "sports", "source_tools.rs",
     'if approved.is_none() || approved != call.approval_version.as_deref() {',
     'if false {', "chat::chat_source_card_passes_the_shown_compact_version_to_the_installed_tool"),
    ("briefings-shown-version", "briefings", "tools.rs",
     'if request.approval_version.as_deref() != Some(version(&definition)?.as_str()) {',
     'if false {', "chat::chat_rerun_uses_the_shown_definition_version"),
    ("wellness-chat-consent", "wellness", "tools.rs",
     'if !consent::effective(host)? {', 'if false {',
     "insights_tools::chat_reads_use_the_installed_tools_and_respect_consent"),
]


def run(module, name, test, phase, removed):
    wasm = target / f"{module}-control.wasm"
    build = subprocess.run(["bash", f"modules/{module}/tools/build-component.sh", str(wasm)],
                           cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (logs / f"{name}.{phase}.build.log").write_bytes(build.stdout)
    if build.returncode:
        raise SystemExit(f"Control build failed: {name} rc={build.returncode}")
    command = ["cargo", "+1.95.0", "test", "--offline", "--locked", "--manifest-path",
               f"modules/{module}/host/Cargo.toml", "--test", "installed", test,
               "--", "--ignored", "--exact", "--nocapture"]
    with (logs / f"{name}.{phase}.log").open("w") as out:
        result = subprocess.run(command, cwd=root, stdout=out, stderr=subprocess.STDOUT,
                                env={**os.environ, f"{module.upper()}_COMPONENT_WASM": str(wasm)})
    output = (logs / f"{name}.{phase}.log").read_text()
    expected = "test result: FAILED. 0 passed; 1 failed;" if removed else "test result: ok. 1 passed; 0 failed;"
    if result.returncode != (101 if removed else 0) or expected not in output:
        print(output[-4000:], flush=True)
        raise SystemExit(f"Unexpected control result {name} rc={result.returncode}")
    print(f"CONTROL {name}: {phase} rc={result.returncode}; {'assertion failed' if removed else '1 passed'}", flush=True)


for name, module, file, old, new, test in controls:
    path = root / f"modules/{module}/src/{file}"
    original = path.read_bytes()
    assert original.decode().count(old) == 1, "Protection anchor changed"
    run(module, name, test, "protected", False)
    try:
        path.write_text(original.decode().replace(old, new))
        run(module, name, test, "removed", True)
    finally:
        path.write_bytes(original)
    run(module, name, test, "restored", False)
# Section 6 also calls for the existing host job-parameter assertion to be re-run.
# Removing UUID validation allows arbitrary text in an id slot; the same test must fail.
path = root / "rust-spike/module-host/src/runtime.rs"
original = path.read_bytes()
old = """ParameterKind::Id => value
                    .as_str()
                    .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok()),"""
assert original.decode().count(old) == 1, "Job metadata protection anchor changed"
command = ["cargo", "+1.95.0", "test", "--offline", "--locked", "--manifest-path",
           "rust-spike/module-host/Cargo.toml", "--test", "enqueue_options",
           "option_enqueue_retains_schema_and_context_guards", "--", "--exact"]
try:
    for phase, removed in [("protected", False), ("removed", True), ("restored", False)]:
        path.write_text(original.decode().replace(old, "ParameterKind::Id => true,") if removed else original.decode())
        log = logs / f"job-metadata.{phase}.log"
        with log.open("w") as out:
            result = subprocess.run(command, cwd=root, stdout=out, stderr=subprocess.STDOUT)
        output = log.read_text()
        expected = "test result: FAILED. 0 passed; 1 failed;" if removed else "test result: ok. 1 passed; 0 failed;"
        if result.returncode != (101 if removed else 0) or expected not in output:
            print(output[-4000:], flush=True)
            raise SystemExit(f"Unexpected job metadata control rc={result.returncode}")
        print(f"CONTROL job-metadata: {phase} rc={result.returncode}; {'assertion failed' if removed else '1 passed'}", flush=True)
finally:
    path.write_bytes(original)
print(f"PASS {len(controls)} installed module and 1 host job metadata removal controls; source restored", flush=True)
