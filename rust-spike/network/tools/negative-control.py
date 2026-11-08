#!/usr/bin/env python3
"""Run one deliberately broken copy through the same live gate, never edit the worktree."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

assert os.environ.get("JARVIS_GATE_RUN") == "1", "Use verify-gate"
mode = os.environ.get("JS44_CONTROL", "")
assert mode in ("signed-out", "logs", "browser-token")
root = Path(__file__).resolve().parents[3]
scratch = Path(tempfile.mkdtemp(prefix="moss-network-removal-"))
try:
    copy = scratch / "rust-spike"
    shutil.copytree(root / "rust-spike", copy,
                    ignore=shutil.ignore_patterns("target", "node_modules", ".git"))
    path = copy / "network/src/web.rs"
    source = path.read_text()
    if mode == "signed-out":
        needle = 'if !public(&path) {'
        assert source.count(needle) == 1
        source = source.replace(needle, 'request.extensions_mut().insert(AccessContext::new(uuid::Uuid::nil(), "removal-control"));\n    if false && !public(&path) {')
        expected = "Signed-out request reached private data"
    elif mode == "logs":
        needle = 'let path = request.uri().path().to_owned();'
        assert source.count(needle) == 1
        source = source.replace(needle, 'eprintln!("{}", request.uri());\n    ' + needle)
        expected = "Session token or password appeared in server logs"
    else:
        start = source.index('pub async fn browser_auth_response(')
        end = source.index('\nasync fn owner_exists', start)
        source = source[:start] + 'pub async fn browser_auth_response(response: Response) -> Response { response }\n' + source[end:]
        expected = "Session token appeared in browser JSON"
    path.write_text(source)
    env = dict(os.environ)
    # Reuse compiled registry dependencies; path dependencies rebuild from the broken copy.
    env["CARGO_TARGET_DIR"] = str(root / "rust-spike/shell/target")
    subprocess.run(["cargo", "+1.95.0", "build", "--offline", "--manifest-path", str(copy / "shell/Cargo.toml"), "-p", "moss-shell"], env=env, check=True)
    binary = scratch / "broken-shell"
    shutil.copy2(root / "rust-spike/shell/target/debug/moss-shell", binary)
    env["JS44_SERVER_BIN"] = str(binary)
    env.pop("JS44_HOLD", None)
    env["JS44_PROOF_DIR"] = str(scratch / "live")
    result = subprocess.run(["pnpm", "exec", "tsx", "rust-spike/network/tools/live.ts"], cwd=root, env=env, capture_output=True, text=True)
    # Never print the broken server log (it deliberately contains live session credentials).
    if result.returncode == 0 or expected not in result.stdout + result.stderr:
        print(f"FAIL {mode}: removal did not fail at its intended assertion", flush=True)
        sys.exit(1)
    print(f"PASS removal {mode}: same live assertion failed as expected: {expected}", flush=True)
finally:
    shutil.rmtree(scratch)
