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


def run(cmd, expect=0, input_text=None):
    done = subprocess.run(cmd, text=True, capture_output=True, input=input_text)
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

    def cli(*extra, input_text=None):
        return run(base + list(extra), expect=None, input_text=input_text)

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
    done = cli("probe", "--root", str(scratch), "--mode", "broken", "--session", "headless")
    assert done.returncode == 3 and "route=stop" in done.stdout, done.stdout
    print("headless broken store stops too: ok")
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
    done = cli("setup-headless", "--root", str(headless), "--key-file", str(key_file), "--mode", "missing", input_text="SAVED\n")
    assert done.returncode == 0, done.stdout + done.stderr
    assert key_file.is_file() and not (headless / "credentials.json").exists()
    done = cli("start", "--root", str(headless), "--mode", "missing")
    assert done.returncode == 0 and "started=true" in done.stdout, done.stdout + done.stderr
    print("headless setup starts from its recorded key file: ok")

    # A real session bus with no Secret Service provider counts as no session.
    # The private bus serves nothing, so no provider can auto-start on it.
    import shutil as _shutil
    if _shutil.which("dbus-daemon"):
        bus_dir = scratch / "empty-bus"
        (bus_dir / "no-services").mkdir(parents=True)
        config = bus_dir / "bus.conf"
        config.write_text(
            '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" '
            '"http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">\n'
            "<busconfig><type>session</type>"
            f"<listen>unix:path={bus_dir}/bus</listen>"
            "<auth>EXTERNAL</auth>"
            f"<servicedir>{bus_dir}/no-services</servicedir>"
            '<policy context="default"><allow send_destination="*" eavesdrop="true"/>'
            '<allow eavesdrop="true"/><allow own="*"/></policy>'
            "</busconfig>\n"
        )
        daemon = subprocess.run(
            ["dbus-daemon", f"--config-file={config}", "--fork", "--print-address=1", "--print-pid=1"],
            text=True, capture_output=True,
        )
        assert daemon.returncode == 0, daemon.stderr
        address, pid = daemon.stdout.splitlines()[:2]
        env = dict(os.environ, DBUS_SESSION_BUS_ADDRESS=address)
        done = subprocess.run(
            [str(binary), "probe", "--root", str(scratch), "--mode", "platform", "--session", "headless"],
            text=True, capture_output=True, env=env,
        )
        try:
            assert done.returncode == 0 and "route=key-file-choice" in done.stdout, done.stdout + done.stderr
        finally:
            os.kill(int(pid), 15)
        print("empty session bus offers the headless key file: ok")

    # 3. Migration removes the plaintext file and leaves no plaintext under the root.
    root = scratch / "instance"
    (root / "nested").mkdir(parents=True)
    (root / "credentials.json").write_text(json.dumps(CREDS))
    (root / "modules.json").write_text(json.dumps({
        "data": "/tmp/data",
        "connector_key": CREDS["connector_key"],
        "ai_key": "test-module-ai-key-3456",
        "producer_url": CREDS["app_url"],
        "migrations_url": "postgres://m:test-migrations-secret-7890@127.0.0.1/db",
        "worker_url": "postgres://w:test-worker-secret-2468@127.0.0.1/db",
    }))
    SECRETS.extend([b"test-module-ai-key-3456", b"test-migrations-secret-7890", b"test-worker-secret-2468"])
    extra = ["--leak-plaintext"] if args.negative_plaintext else []
    migrated = cli("migrate", "--root", str(root), "--mode", "working", *extra, input_text="SAVED\n")
    done = migrated
    # With --negative-plaintext this assertion must fail, which is the control working.
    assert done.returncode == 0, done.stdout + done.stderr
    assert not (root / "credentials.json").exists(), "credentials.json must be removed"
    assert (root / "key-bundle.json").is_file(), "wrapped bundle must exist"
    hits = find_plaintext(root)
    assert not hits, f"plaintext remains under instance root: {hits}"
    print("migration leaves no plaintext under the instance root: ok")

    # A real instance folder: the database program keeps its own per-role
    # secret files under database/. Those are its own store, outside the
    # claimed area. The same password copied anywhere else must fail.
    real = scratch / "real-shape"
    (real / "database" / "secrets").mkdir(parents=True)
    (real / "credentials.json").write_text(json.dumps(CREDS))
    (real / "database" / "secrets" / "session-signing-secret").write_text(CREDS["auth_secret"])
    (real / "database" / "secrets" / "jarvis_app_runtime").write_text("test-app-secret-1234")
    done = cli("migrate", "--root", str(real), "--mode", "working", input_text="SAVED\n")
    assert done.returncode == 0, done.stdout + done.stderr
    stray = scratch / "stray-copy"
    (stray / "database" / "secrets").mkdir(parents=True)
    (stray / "credentials.json").write_text(json.dumps(CREDS))
    (stray / "database" / "secrets" / "jarvis_app_runtime").write_text("test-app-secret-1234")
    (stray / "password-copy.txt").write_text("test-app-secret-1234")
    done = cli("migrate", "--root", str(stray), "--mode", "working", input_text="SAVED\n")
    assert done.returncode == 3, done.stdout + done.stderr
    print("real instance shape migrates, a stray password copy fails: ok")

    # 4. Recovery words restore the bundle. Wrong words are refused.
    words = ""
    for line in migrated.stdout.splitlines():
        if line.startswith("words="):
            words = line[len("words="):]
    assert len(words.split()) == 24, words
    done = cli("recover", "--root", str(root), "--words", words)
    assert done.returncode == 0 and "restored=true" in done.stdout, done.stdout + done.stderr
    # Valid but wrong words come from a second real setup in this run.
    other = scratch / "other-instance"
    other.mkdir()
    (other / "credentials.json").write_text(json.dumps(CREDS))
    done_other = cli("migrate", "--root", str(other), "--mode", "working", input_text="SAVED\n")
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

    # 6. Real operating system key store. Every gate machine must store and
    # reload through it: macOS and Windows runners have one, and the Linux job
    # starts a keyring session before this step.
    done = cli("platform-smoke", "--root", str(scratch))
    assert done.returncode == 0 and "platform=working" in done.stdout, done.stdout + done.stderr
    plat_root = scratch / "platform-instance"
    plat_root.mkdir()
    (plat_root / "credentials.json").write_text(json.dumps(CREDS))
    done = cli("migrate", "--root", str(plat_root), "--mode", "platform", input_text="SAVED\n")
    assert done.returncode == 0, done.stdout + done.stderr
    assert not (plat_root / "credentials.json").exists()
    done = cli("start", "--root", str(plat_root), "--mode", "platform")
    assert done.returncode == 0 and "started=true" in done.stdout, done.stdout + done.stderr
    print("platform key store migration and start: ok")
    # No credential secret may sit anywhere in the scratch area, in any file.
    hits = []
    for path in sorted(scratch.rglob("*")):
        # The locked fixture never migrated, so its untouched starting file stays.
        if locked_root in path.parents:
            continue
        # The stray-copy fixture failed migration on purpose; its starting
        # file stands too, as the retry contract requires.
        if (scratch / "stray-copy") in path.parents:
            continue
        # The database program's own folder is its own store, outside the
        # claimed area, exactly as the migration search treats it.
        rel = path.relative_to(scratch)
        if len(rel.parts) > 1 and rel.parts[1] == "database":
            continue
        if path.is_file() and any(secret in path.read_bytes() for secret in SECRETS):
            hits.append(str(path))
    assert not hits, f"plaintext credential secrets in scratch: {hits}"
    print("whole scratch byte search: ok")

    print("phase7_key_custody: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
