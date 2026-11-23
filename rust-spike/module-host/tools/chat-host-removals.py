#!/usr/bin/env python3
"""Run only inside the disposable host gate, sequentially, restoring bytes with finally.

These controls deliberately weaken this task's own worktree. Do not run other cargo commands
in this worktree concurrently. A compiler error is never accepted as a red assertion.
"""
import os
from pathlib import Path
import re
import subprocess

if os.environ.get("JARVIS_GATE_RUN") != "1":
    raise SystemExit("Use scripts/run-gate.sh with JS361_REMOVAL_PROOF=1")
root = Path(__file__).resolve().parents[1]
logs = Path(os.environ.get("JS361_PROOF_DIR", "/tmp/js361-proof/removals"))
logs.mkdir(parents=True, exist_ok=True)
cargo = ["cargo", "+1.95.0", "test", "--offline", "--locked", "--manifest-path", str(root / "Cargo.toml")]
# name, source, exact regex, replacement, cargo target/filter, expected failing assertions
controls = [
    ("turn-actor-rls", "src/chat_tools.rs", r'\.call_chat_unfenced\(module, access.clone\(\), "tool",', '.call_chat_unfenced(module, AccessContext::new("00000000-0000-4000-8000-000000000362".parse().unwrap(), "wrong-turn"), "tool",', ["--test", "chat_tools", "privacy::chat_tool_reads_use_the_actor_under_real_rls_including_admin", "--", "--ignored", "--exact", "--nocapture"], 1),
    ("admin-rls", "src/rls.rs", r'(let role = runtime_role\(&manifest.id\);\s*)let owner = "owner_user_id=app.current_actor_user_id\(\)";', r'\1let owner = "true";', ["--test", "chat_tools", "privacy::chat_tool_reads_use_the_actor_under_real_rls_including_admin", "--", "--ignored", "--exact", "--nocapture"], 1),
    ("account-enabled", "src/invocation.rs", r'ensure!\(\s*self.lifecycle.account_enabled\(.*?"This module is switched off for this account"\s*\);', '', ["--test", "chat_tools", "switched_off_tools_vanish_and_forged_calls_are_refused", "--", "--exact"], 1),
    ("card-required", "src/chat_tools.rs", r'\(ChatToolRule::Card \{ \.\. \}, None\) => \{.*?\n            \}', '', ["--test", "chat_tools", "card_required_auto_run_is_refused", "--", "--exact"], 1),
    ("exact-parameters", "src/services.rs", r'serde_json::to_vec\(&\(tool, parameters\)\)', 'serde_json::to_vec(&tool)', ["--test", "chat_tools", "grant_binds_actor_module_tool_exact_parameters_and_single_use", "--", "--exact"], 1),
    ("grant-tool", "src/services.rs", r'serde_json::to_vec\(&\(tool, parameters\)\)', 'serde_json::to_vec(parameters)', ["--test", "chat_tools", "grant_binds_actor_module_tool_exact_parameters_and_single_use", "--", "--exact"], 1),
    ("grant-actor", "src/services.rs", r'let cx = VaultContext::for_module_files\(&module, access\)\?;', 'let pooled = AccessContext::new(uuid::Uuid::nil(), "pooled"); let cx = VaultContext::for_module_files(&module, &pooled)?;', ["--test", "chat_tools", "grant_binds_actor_module_tool_exact_parameters_and_single_use", "--", "--exact"], 1),
    ("grant-module", "src/services.rs", r'let module = self.files.create_subdir\(id\)\?;', 'let module = self.files.create_subdir("sample.counter")?;', ["--test", "chat_tools", "grant_does_not_cross_modules", "--", "--exact"], 1),
    ("single-use", "src/chat_services.rs", r'self.write\(module, access, &key, &Value::Null\)\?;', '', ["--test", "chat_tools", "grant_binds_actor_module_tool_exact_parameters_and_single_use", "--", "--exact"], 1),
    ("grant-expiry", "src/chat_services.rs", r'ensure!\(\s*grant\["expires"\].*?"This tool needs the account\x27s approval"\s*\);', '', ["--test", "chat_tools", "expired_grant_is_refused", "--", "--exact"], 1),
    ("chat-redaction", "src/chat_services.rs", r'crate::credentials::sanitize_with\(.*?\);', '', ["--test", "chat_tools", "privacy::planted_credentials_"], 5),
    ("sensitive-chat-fields", "src/credentials.rs", r'sensitive_name\(&name\) && !expose.contains\(&name\)', 'false', ["--test", "chat_tools", "privacy::chat_redaction_preserves_only_exact_public_consent_name", "--", "--exact"], 1),
    ("fixed-card-target", "src/chat_tools.rs", r'let target = format!\("\{\}: \{\}", manifest.name, tool.description\);', 'let target = raw["target"].as_str().unwrap_or_default().to_owned();', ["--test", "chat_tools", "card_fixed_parts_come_from_host_and_manifest", "--", "--exact"], 1),
    ("public-tool-boundary", "src/invocation.rs", r'ensure!\(kind != "tool", "Use the validated chat tool entry points"\);', '', ["--test", "chat_tools", "public_dispatch_cannot_bypass_the_tool_gate", "--", "--exact"], 1),
    ("argument-validation", "src/chat_tools.rs", r'chat_schema::validate\(schema, params\)\?;', '', ["--test", "chat_tools", "schema_validation_precedes_all_guest_entry_points", "--", "--exact"], 1),
    ("nested-and-integer-validation", "src/chat_tools.rs", r'chat_schema::validate\(schema, params\)\?;', '', ["--test", "chat_tools", "schema::"], 2),
    ("policy-card", "src/chat_tools.rs", r'explicit_policy != Some\(true\)', 'true', ["--test", "chat_tools", "rule_table_and_account_policy_agree_with_execution", "--", "--exact"], 1),
    ("pinned-version", "src/chat_tools.rs", r'(?m)^                tool\.approval_version,', '                    false,', ["--test", "chat_tools", "approved_call_forwards_shown_version_and_consumes_grant_before_guest", "--", "--exact"], 1),
    ("pinned-card-version", "src/chat_tools.rs", r'ensure!\(\s*!tool.approval_version \|\| version.is_some\(\),\s*"Pinned card version required"\s*\);', '', ["--test", "chat_tools", "malformed_and_failed_cards_return_errors_missing_builder_is_absent", "--", "--exact"], 1),
    ("chat-grant-consumption", "src/chat_services.rs", r'self.write\(module, access, &key, &Value::Null\)\?;', '', ["--test", "chat_tools", "approved_call_forwards_shown_version_and_consumes_grant_before_guest", "--", "--exact"], 1),
    ("storage-actor", "src/local.rs", r'(?m)^                scope\.access\(\)$', '                &instance', ["--test", "chat_tools", "privacy::calls_use_the_authenticated_account_for_real_host_storage", "--", "--exact"], 1),
    ("install-schema", "src/manifest.rs", r'crate::chat_schema::check\(schema\)\?;', '', ["--test", "chat_tools", "schema::install_refuses_unsupported_schemas_missing_descriptions_and_missing_card_apis", "--", "--exact"], 1),
    ("job-metadata", "src/runtime.rs", r'ensure!\(\s*schema.len\(\) == params.len\(\),\s*"The job parameters do not match their schema"\s*\);', '', ["--test", "enqueue_options", "option_enqueue_retains_schema_and_context_guards", "--", "--exact"], 1),
]

def run(name, args, red):
    path = logs / f"{name}.{'removed' if red else 'protected'}.log"
    with path.open("w") as out:
        result = subprocess.run(cargo + args, stdout=out, stderr=subprocess.STDOUT, timeout=300)
    output = path.read_text()
    marker = "test result: FAILED" if red else "test result: ok."
    if (result.returncode == 0) == red or marker not in output:
        print(output[-5000:], flush=True)
        raise SystemExit(f"Not an expected {'assertion failure' if red else 'pass'}: {name} rc={result.returncode}")
    return result.returncode, output

for name, source, pattern, replacement, args, failures in controls:
    path = root / source
    original = path.read_bytes()
    count = len(re.findall(pattern, original.decode(), flags=re.S))
    if count != 1:
        raise SystemExit(f"Expected one protection for {name}; found {count}")
    changed = re.sub(pattern, replacement, original.decode(), count=1, flags=re.S)
    run(name, args, False)
    try:
        path.write_text(changed)
        rc, output = run(name, args, True)
        if f"{failures} failed;" not in output:
            raise SystemExit(f"Wrong assertion failure count for {name}: {output[-2000:]}")
        evidence = [line for line in output.splitlines() if "FAILED" in line or "panicked at" in line or line.startswith("assertion")]
        print(f"REMOVAL {name}: protected rc=0; removed rc={rc}; {failures} assertion(s) failed", flush=True)
        for line in evidence[:8]:
            print(f"  {line}", flush=True)
    finally:
        path.write_bytes(original)
print(f"PASS {len(controls)} removal controls; original source bytes restored", flush=True)
