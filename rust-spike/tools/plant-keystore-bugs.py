"""Plants one bug at a time in the key store and records which tests catch it.

Edits the source in place and restores it after each bug. Run from a clean tree:
    python3 -I tools/plant-keystore-bugs.py . <output.txt>
"""
import os, pathlib, re, signal, subprocess, sys, time

root = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
# CARGO_TARGET_DIR, if set, comes from the caller.
env = dict(os.environ, PATH=os.path.expanduser("~/.cargo/bin") + ":" + os.environ["PATH"])
S, P, R, B = "keystore/src/store.rs", "keystore/src/probe.rs", "keystore/src/recovery.rs", "keystore/src/bin/fake-secret-service.rs"
mutations = [
    (P, "matches!(self, Keychain::NoSessionBus(_) | Keychain::NotInstalled)",
        "!matches!(self, Keychain::Working { .. })", "a broken keychain also offers the key file"),
    (P, "Ok(_) => Keychain::Working { already_running },\n        Err(error) => Keychain::Broken(error.to_string()),",
        "_ => Keychain::Working { already_running },", "any answer from the keychain counts as working"),
    (P, "b.method_timeout(ANSWER_WITHIN).build()", "b.build()", "no time limit on the keychain's answer"),
    (S, "if folder.mode() & 0o077 != 0 || file.mode() & 0o077 != 0 {", "if file.mode() & 0o077 != 0 {",
        "folder permissions not checked"),
    (S, "if folder.mode() & 0o077 != 0 || file.mode() & 0o077 != 0 {", "if folder.mode() & 0o077 != 0 {",
        "key file permissions not checked"),
    (S, re.compile(r"(?:bundle\.)?header_text\.as_bytes\(\)"), "b\"\"", "sealed parts not bound to the bundle header"),
    (S, ".map_err(State::KeysDoNotMatch)?;", ".ok();", "test credential not checked"),
    (S, ".mode(0o600).open(&staging)?;", ".mode(0o644).open(&staging)?;", "files written readable by others"),
    (S, "if !file.file_type().is_file() || file.uid() != current_uid() {", "if file.uid() != current_uid() {",
        "a linked key file is followed"),
    (S, "if text(\"recoveryKeyId\") != Some(recovery.id().as_str()) {", "if false {",
        "stored key name not checked against the key"),
    (S, "if recovery.id() != bundle.recovery_key_id {", "if false {", "typed words not matched to this setup first"),
    (S, "fs::rename(&paths.key_file, &aside)", "fs::remove_file(&paths.key_file)",
        "a damaged key file is deleted instead of kept"),
    (S, ".custom_flags(libc::O_NOFOLLOW)", "", "making it private follows a link"),
    (R, "if typed.len() < 4 {", "if typed.len() < 3 {", "three-letter prefixes accepted"),
    (S, "for path in [&paths.key_file, &paths.bundle, &paths.test_credential] {",
        "for path in [&paths.key_file, &paths.bundle, &paths.test_credential].iter().take(0) {",
        "a failed setup leaves its files behind"),
    (S, "if fs::symlink_metadata(&paths.bundle).is_ok() || fs::symlink_metadata(&paths.key_file).is_ok() {",
        "if fs::symlink_metadata(&paths.bundle).is_ok() {", "setup replaces a key file whose bundle is missing"),
    (S, "    if staged.is_err() {\n        let _ = fs::remove_file(&staging);\n    }\n", "",
        "a failed write leaves its staging file"),
]
lines = []
for path, old, new, what in mutations:
    file = root / path
    original = file.read_text()
    count = len(old.findall(original)) if isinstance(old, re.Pattern) else original.count(old)
    if count == 0:
        lines.append(f"!! did not apply: {what}")
        continue
    file.write_text(old.sub(new, original) if isinstance(old, re.Pattern) else original.replace(old, new))
    try:
        started = time.time()
        child = subprocess.Popen(["cargo", "test", "-p", "keystore", "--no-fail-fast"], cwd=root, env=env,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                 start_new_session=True)
        try:
            text, _ = child.communicate(timeout=240)
            code = child.returncode
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            text, _ = child.communicate()
            code = "timeout"
        leftovers = subprocess.run(["pgrep", "-f", "-x", ".*/target/debug/fake-secret-service .*"],
                                   capture_output=True, text=True).stdout.split()
        for pid in leftovers:
            os.kill(int(pid), signal.SIGKILL)
        failed = re.findall(r"^test (\S+) \.\.\. FAILED$", text, re.M)
        compile_error = re.search(r"^error(\[E\d+\])?:", text, re.M) and not failed
        if code == "timeout":
            verdict = "TIMED OUT"
        else:
            verdict = "DID NOT COMPILE" if compile_error else ("caught" if failed else "NOT CAUGHT")
        lines.append(f"{verdict}: {what} (changed {count} place{'s' if count > 1 else ''}; exit {code}; "
                     f"{time.time() - started:.0f} s; {len(leftovers)} leftover fakes)")
        lines.extend(f"    failed: {name}" for name in failed)
        if code == "timeout":
            lines.extend("    | " + line for line in text.splitlines()[-15:])
        print(lines[-1], flush=True)
    finally:
        file.write_text(original)
out.write_text("\n".join(lines) + "\n")
print(out.read_text())
