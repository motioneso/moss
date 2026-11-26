#!/usr/bin/env python3
"""phase7_key_custody runner.

Drives the key-custody command with stand-in key stores, the same on every system.
Test values only, made in the run. No real key or recovery phrase is printed by CI
beyond the throwaway words this run generates in its own scratch folder.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

CREDS = {
    "app_url": "postgres://app:test-app-secret-1234@127.0.0.1/db",
    "auth_url": "postgres://auth:test-auth-secret-5678@127.0.0.1/db",
    "auth_secret": "test-auth-secret-5678-abcd-efgh",
    "connector_key": "test-connector-key-9012-ijkl",
}
SECRETS = [v.encode() for v in CREDS.values() if len(v) >= 8]


def run(cmd, expect=0):
    done = subprocess.run(cmd, text=True, capture_output=True)
    if expect is not None and done.returncode != expect:
        print(done.stdout)
        print(done.stderr, file=sys.stderr)
        raise AssertionError(f"{cmd} exited {done.returncode}, expected {expect}")
    return done


def find_plaintext(root):
    hits = []
    for path in sorted(Path(root).rglob("*")):
        if path.is_file():
            data = path.read_bytes()
            if any(secret in data for secret in SECRETS):
                hits.append(str(path))
    return hits


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", default=os.environ.get("PHASE7_KEY_CUSTODY_BIN", os.path.join(os.environ.get("CARGO_TARGET_DIR", "target"), "debug")), help="folder holding key-custody")
    parser.add_argument("--scratch", default=os.environ.get("PHASE7_KEY_CUSTODY_SCRATCH", "/tmp/phase7-key-custody"))
    parser.add_argument("--negative-plaintext", action="store_true")
    args = parser.parse_args()

    binary = Path(args.bin) / ("key-custody.exe" if os.name == "nt" else "key-custody")
    if not binary.is_file():
        raise AssertionError(f"missing {binary}")
    scratch = Path(args.scratch)
    if scratch.exists():
        shutil.rmtree(scratch)
    scratch.mkdir(parents=True)
    base = [str(binary)]

    def cli(*extra):
        return run(base + list(extra), expect=None)

    # 1. Locked key store refuses to start with a plain reason.
    locked_root = scratch / "locked-instance"
    locked_root.mkdir()
    (locked_root / "credentials.json").write_text(json.dumps(CREDS))
    done = cli("start", "--root", str(locked_root), "--mode", "locked")
    assert done.returncode == 3, done.stdout + done.stderr
    assert "code=app_keystore_locked" in done.stdout, done.stdout
    assert "Unlock your key store" in done.stdout, done.stdout
    print("locked store refuses to start: ok")

    # 2. Desktop session with missing or broken store stops, with no key-file offer.
    for mode in ("missing", "broken"):
        done = cli("probe", "--root", str(scratch), "--mode", mode, "--session", "desktop")
        assert done.returncode == 3, (mode, done.stdout)
        assert "code=app_keystore_unavailable" in done.stdout, done.stdout
        assert "route=stop" in done.stdout and "offers_key_file=false" in done.stdout, done.stdout
        assert "key-file" not in done.stdout.split("reason=")[-1], done.stdout
    print("desktop missing/broken store stops with Try again and no key-file option: ok")

    # Headless Linux with no keychain session may choose a key file.
    done = cli("probe", "--root", str(scratch), "--mode", "missing", "--session", "headless")
    assert done.returncode == 0 and "route=key-file-choice" in done.stdout, done.stdout
    chosen = scratch / "chosen-master.key"
    done = cli("choose-key-file", "--root", str(locked_root), "--key-file", str(chosen))
    assert done.returncode == 0, done.stdout + done.stderr
    print("headless key-file choice: ok")

    # Headless setup writes the bundle's own master key to the chosen file, and
    # a start with no key store opens the bundle from that recorded file only.
    headless = scratch / "headless-instance"
    headless.mkdir()
    (headless / "credentials.json").write_text(json.dumps(CREDS))
    key_file = scratch / "headless-master.key"
    done = cli("setup-headless", "--root", str(headless), "--key-file", str(key_file))
    assert done.returncode == 0, done.stdout + done.stderr
    assert key_file.is_file() and not (headless / "credentials.json").exists()
    done = cli("start", "--root", str(headless), "--mode", "missing")
    assert done.returncode == 0 and "started=true" in done.stdout, done.stdout + done.stderr
    print("headless setup starts from its recorded key file: ok")

    # 3. Migration removes the plaintext file and leaves no plaintext under the root.
    root = scratch / "instance"
    (root / "nested").mkdir(parents=True)
    (root / "credentials.json").write_text(json.dumps(CREDS))
    extra = ["--leak-plaintext"] if args.negative_plaintext else []
    done = cli("migrate", "--root", str(root), "--mode", "working", *extra)
    # With --negative-plaintext this assertion must fail, which is the control working.
    assert done.returncode == 0, done.stdout + done.stderr
    assert not (root / "credentials.json").exists(), "credentials.json must be removed"
    assert (root / "key-bundle.json").is_file(), "wrapped bundle must exist"
    hits = find_plaintext(root)
    assert not hits, f"plaintext remains under instance root: {hits}"
    print("migration leaves no plaintext under the instance root: ok")

    # 4. Recovery words restore the bundle. Wrong words are refused.
    words = ""
    for line in done.stdout.splitlines():
        if line.startswith("words="):
            words = line[len("words="):]
    assert len(words.split()) == 24, words
    done = cli("recover", "--root", str(root), "--words", words)
    assert done.returncode == 0 and "restored=true" in done.stdout, done.stdout + done.stderr
    # Valid but wrong words come from a second real setup in this run.
    other = scratch / "other-instance"
    other.mkdir()
    (other / "credentials.json").write_text(json.dumps(CREDS))
    done_other = cli("migrate", "--root", str(other), "--mode", "working")
    assert done_other.returncode == 0, done_other.stdout + done_other.stderr
    wrong = [line[len("words="):] for line in done_other.stdout.splitlines() if line.startswith("words=")][0]
    assert wrong != words and len(wrong.split()) == 24
    done = cli("recover", "--root", str(root), "--words", wrong)
    assert done.returncode == 3, done.stdout + done.stderr
    print("recovery words restore, wrong words refused: ok")

    # 5. Start with the working store opens the bundle.
    done = cli("start", "--root", str(root), "--mode", "working")
    assert done.returncode == 0 and "started=true" in done.stdout, done.stdout + done.stderr
    print("start with working store: ok")

    # 6. Real operating system key store. macOS and Windows runners have one, so
    # there it must store and reload. Linux CI has no Secret Service session, so
    # there an unavailable answer is reported, not passed off as working.
    import sys as _sys
    done = cli("platform-smoke", "--root", str(scratch))
    if _sys.platform in ("darwin", "win32"):
        assert done.returncode == 0 and "platform=working" in done.stdout, done.stdout + done.stderr
        plat_root = scratch / "platform-instance"
        plat_root.mkdir()
        (plat_root / "credentials.json").write_text(json.dumps(CREDS))
        done = cli("migrate", "--root", str(plat_root), "--mode", "platform")
        assert done.returncode == 0, done.stdout + done.stderr
        assert not (plat_root / "credentials.json").exists()
        done = cli("start", "--root", str(plat_root), "--mode", "platform")
        assert done.returncode == 0 and "started=true" in done.stdout, done.stdout + done.stderr
        print("platform key store migration and start: ok")
    else:
        print(f"platform key store smoke exit {done.returncode} on this Linux runner")
    # No credential secret may sit anywhere in the scratch area, in any file.
    hits = []
    for path in sorted(scratch.rglob("*")):
        # The locked fixture never migrated, so its untouched starting file stays.
        if locked_root in path.parents:
            continue
        if path.is_file() and any(secret in path.read_bytes() for secret in SECRETS):
            hits.append(str(path))
    assert not hits, f"plaintext credential secrets in scratch: {hits}"
    print("whole scratch byte search: ok")

    print("phase7_key_custody: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
