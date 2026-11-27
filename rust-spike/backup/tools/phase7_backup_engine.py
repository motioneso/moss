#!/usr/bin/env python3
"""phase7_backup_engine runner.

Builds a throwaway instance on the pinned database bundle, sets up key custody with a key file,
plants test data, and proves the backup engine end to end: write fencing, no plaintext in the
archive, a drill that restores and checks, damage caught even when the hash agrees, no worker
or outbound call during a drill, retention, and opening an archive with the recovery words.

Every secret and word is generated in the run and stays in the scratch folder. Nothing secret
is printed.
"""
import argparse
import http.server
import json
import os
import random
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
EXE = ".exe" if os.name == "nt" else ""


def fail(message):
    raise AssertionError(message)


def expect(condition, message):
    if not condition:
        fail(message)
    print(f"ok: {message}", flush=True)


def redact(text):
    return "\n".join("words=<redacted>" if line.startswith("words=") else line for line in text.splitlines())


class Runner:
    def __init__(self, args):
        self.bin = Path(args.bin)
        self.pg = Path(args.postgres).resolve()
        self.repo = Path(args.repo).resolve()
        self.scratch = Path(args.scratch).resolve()
        if self.scratch.exists():
            shutil.rmtree(self.scratch)
        self.scratch.mkdir(parents=True)
        self.instance = self.scratch / "instance"
        self.instance.mkdir()
        self.database = None
        self.children = []
        self.hits = 0

    def tool(self, name):
        path = self.bin / (name + EXE)
        if not path.is_file():
            fail(f"missing {path}")
        return str(path)

    def run(self, name, *args, input_text=None, ok=True):
        done = subprocess.run([self.tool(name), *map(str, args)], text=True, capture_output=True,
                              input=input_text, timeout=600)
        if ok is not None and (done.returncode == 0) != ok:
            print(redact(done.stdout))
            print(redact(done.stderr), file=sys.stderr)
            fail(f"{name} {args[0]} exited {done.returncode}")
        return done

    def json(self, name, *args, ok=True):
        done = self.run(name, *args, ok=ok)
        lines = [line for line in done.stdout.splitlines() if line.startswith("{")]
        if not lines:
            fail(f"{name} {args[0]} printed no result: {done.stdout} {done.stderr}")
        return json.loads(lines[-1])

    def spawn(self, name, *args):
        child = subprocess.Popen([self.tool(name), *map(str, args)], text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(child)
        return child

    # A failed check can leave a child paused or waiting. Windows cannot rebuild a running binary.

    def stop_children(self):
        for child in self.children:
            if child is not self.database and child.poll() is None:
                child.kill()
                child.wait(timeout=60)

    # -- setup ---------------------------------------------------------------------------------

    def start_database(self):
        self.database = self.spawn("moss-db", "up", "--root", self.instance / "database", "--pg", self.pg,
                                   "--repo", self.repo)
        for line in self.database.stdout:
            event = json.loads(line) if line.startswith("{") else {}
            if event.get("event") == "ready":
                print(f"database ready, {event['migrations']['applied']} migrations applied", flush=True)
                return
            if event.get("event") == "error":
                fail(f"database start: {event.get('error')}")
        fail(f"database exited early: {self.database.stderr.read()[-4000:]}")

    def stop_database(self):
        if self.database and self.database.poll() is None:
            subprocess.run([self.tool("moss-db"), "stop", "--root", str(self.instance / "database")],
                           capture_output=True, timeout=120)
            try:
                self.database.wait(timeout=60)
            except subprocess.TimeoutExpired:
                self.database.kill()

    def set_up_custody(self):
        done = self.run("moss-db", "credentials", "--root", self.instance / "database", "--module-host")
        credentials = self.instance / "credentials.json"
        credentials.write_text(done.stdout)
        if os.name != "nt":
            credentials.chmod(0o600)
        keys = self.scratch / "keys"
        keys.mkdir()
        done = self.run("key-custody", "setup-headless", "--root", self.instance, "--key-file", keys / "master.key",
                        "--mode", "missing", input_text="SAVED\n")
        words = [line[len("words="):] for line in done.stdout.splitlines() if line.startswith("words=")]
        expect(len(words) == 1 and len(words[0].split()) == 24, "key custody set up with a 24-word recovery key")
        self.words = words[0].split()
        expect(not credentials.exists(), "the plain credentials file is gone after key custody")

    def start_canary(self):
        runner = self

        class Canary(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                runner.hits += 1
                self.send_response(204)
                self.end_headers()

            def log_message(self, *args):
                pass

        self.canary = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Canary)
        threading.Thread(target=self.canary.serve_forever, daemon=True).start()
        self.canary_url = f"http://127.0.0.1:{self.canary.server_address[1]}/job-ran"
        # The canary itself must answer, or a zero count would prove nothing.
        before = self.hits
        import urllib.request
        urllib.request.urlopen(self.canary_url, timeout=5).read()
        expect(self.hits == before + 1, "the canary counts a call")
        self.hits = 0

    # -- helpers -------------------------------------------------------------------------------

    def wait_marker(self, marker, process, stage, seconds=300):
        until = time.time() + seconds
        while time.time() < until:
            if marker.exists():
                try:
                    text = marker.read_text()
                except OSError:
                    text = ""
                if text.strip():
                    if stage == "backup-between-dump-and-files" and text.strip() == stage:
                        return text
                    if text.startswith("{") and json.loads(text).get("stage") == stage:
                        return json.loads(text)
            if process.poll() is not None:
                out, err = process.communicate()
                fail(f"{stage}: the command ended before pausing: {out} {err[-4000:]}")
            time.sleep(0.05)
        fail(f"{stage}: never paused")

    def finish(self, process, label):
        out, err = process.communicate(timeout=600)
        lines = [line for line in out.splitlines() if line.startswith("{")]
        result = json.loads(lines[-1]) if lines else {}
        if process.returncode != 0 or not result.get("ok"):
            print(out)
            print(err[-4000:], file=sys.stderr)
            fail(f"{label} failed")
        return result

    def backup(self, *extra):
        return self.json("moss-backup", "backup", "--instance", self.instance, "--pg", self.pg, *extra)

    def verify(self, backup_id, ok):
        return self.json("moss-backup", "verify", "--instance", self.instance, "--pg", self.pg, "--id", backup_id,
                         "--scratch", self.drills, ok=ok)

    def ledger(self):
        entries = self.json("moss-backup", "list", "--instance", self.instance)["backups"]
        return {entry["id"]: entry for entry in entries}

    # -- proof ---------------------------------------------------------------------------------

    def main(self):
        self.start_database()
        self.set_up_custody()
        self.start_canary()
        self.drills = self.scratch / "drills"
        self.drills.mkdir()
        marker = f"moss-proof-marker-{random.getrandbits(64):016x}"
        planted = self.json("backup-fixture", "plant", "--instance", self.instance, "--canary", self.canary_url,
                            "--marker", marker)

        # A backup started while a writer holds the fence waits for the writer to finish.
        before = self.spawn("backup-fixture", "write", "--instance", self.instance, "--name", "before",
                            "--hold-ms", "4000")
        expect(json.loads(before.stdout.readline()).get("entered") == "before", "a writer holds the fence")
        pause = self.scratch / "backup.pause"
        backup_a = self.spawn("moss-backup", "backup", "--instance", self.instance, "--pg", self.pg,
                              "--test-pause", pause)
        while before.poll() is None:
            if pause.exists():
                fail("a backup captured while a writer held the fence")
            time.sleep(0.05)
        self.finish(before, "the writer before the backup")
        self.wait_marker(pause, backup_a, "backup-between-dump-and-files")
        expect(True, "the backup captured only after the writer finished")

        # A writer that starts during the capture waits until the capture ends.
        during = self.spawn("backup-fixture", "write", "--instance", self.instance, "--name", "during",
                            "--hold-ms", "200")
        time.sleep(3)
        expect(during.poll() is None and not (self.instance / "vault/notes/during.txt").exists(),
               "a writer that starts during the capture waits, and has written nothing")
        pause.unlink()
        backup_a = self.finish(backup_a, "backup A")
        self.finish(during, "the writer during the backup")
        expect((self.instance / "vault/notes/during.txt").exists(), "the waiting writer finished after the backup")

        # No plaintext secret, key or planted content anywhere in the archives or ledger.
        scan = self.json("backup-fixture", "scan", "--instance", self.instance, "--root", self.instance / "backups",
                         "--marker", marker, "--marker", planted["content"])
        expect(scan["archives"] == 1 and scan["needles"] > 10, "the scan searched for every secret and key")
        expect(scan["hits"] == [], "a byte search of the archive finds no plaintext secret")

        # Damage is caught, even when the ledger hash agrees with the damaged file.
        backup_b = self.backup()
        path = self.instance / "backups" / f"{backup_b['id']}.mossbak"
        data = bytearray(path.read_bytes())
        offset = len(data) // 2
        data[offset] ^= 0x01
        path.write_bytes(bytes(data))
        refused = self.verify(backup_b["id"], ok=None)
        expect("ledger" in refused["error"], "a flipped byte fails verify")
        self.json("backup-fixture", "rehash", "--instance", self.instance, "--id", backup_b["id"])
        refused = self.verify(backup_b["id"], ok=None)
        expect(not refused["ok"], "a flipped byte fails verify even when its hash matches the ledger")
        expect(self.ledger()[backup_b["id"]]["verified"] is False, "the damaged backup stays unverified")

        # The drill restores backup A with workers and outbound calls blocked.
        drill_pause = self.scratch / "drill.pause"
        drill = self.spawn("moss-backup", "verify", "--instance", self.instance, "--pg", self.pg,
                           "--id", backup_a["id"], "--scratch", self.drills, "--test-pause", drill_pause)
        paused = self.wait_marker(drill_pause, drill, "drill-restored")
        worker = self.json("backup-fixture", "hostile-worker", "--instance", self.instance, "--pause", drill_pause)
        expect(worker["accepted"] == [] and len(worker["refused"]) == 5,
               "a worker holding every real credential cannot sign in to the drill")
        seen = self.json("backup-fixture", "inspect-drill", "--pause", drill_pause)
        expect(seen["loginRoles"] == [], "no restored role can sign in")
        attachment = seen["attachments"][0]
        expect(attachment["fileSha256"] == attachment["recordSha256"] == planted["sha256"]
               and attachment["fileSize"] == attachment["recordSize"],
               "the drill restores an attachment that matches its record")
        expect("before" in seen["noteRows"] and "before" in seen["noteFiles"],
               "a write that finished before the backup is in both the dump and the files")
        expect("during" not in seen["noteRows"] and "during" not in seen["noteFiles"],
               "a write made during the backup is in neither")
        expect(seen["queuedJobs"] == 1, "the planted job was restored, still queued")
        drill_pause.unlink()
        report = self.finish(drill, "the drill of backup A")
        expect(report["verified"] and report["files"] >= 2, "the drill verified backup A")
        expect(self.hits == 0, "no job or outbound call ran during the drill")
        expect(not Path(paused["scratch"]).exists(), "the drill removed its scratch folder")
        expect(self.ledger()[backup_a["id"]]["verified"] is True, "the ledger records backup A as verified")

        # The recovery words alone open the archive and its wrapped credentials.
        words_file = self.scratch / "keys" / "words.txt"
        words_file.write_text(" ".join(self.words))
        opened = self.json("moss-backup", "open", "--archive", self.instance / "backups" / f"{backup_a['id']}.mossbak",
                           "--words-file", words_file)
        digest = self.json("backup-fixture", "credentials-digest", "--instance", self.instance)
        expect(opened["id"] == backup_a["id"] and opened["credentialsSha256"] == digest["credentialsSha256"],
               "the recovery words open the archive and its credentials decrypt")
        wrong = list(self.words)
        wrong[0], wrong[1] = wrong[1], wrong[0]
        words_file.write_text(" ".join(wrong))
        refused = self.json("moss-backup", "open", "--archive",
                            self.instance / "backups" / f"{backup_a['id']}.mossbak", "--words-file", words_file, ok=False)
        expect(not refused["ok"], "the wrong words do not open the archive")
        words_file.unlink()

        # Retention: 7 daily and 4 weekly, never the pinned or the newest verified backup.
        self.json("moss-backup", "pin", "--instance", self.instance, "--id", backup_b["id"])
        removed = self.json("moss-backup", "prune", "--instance", self.instance)["removed"]
        expect(removed == [], "pruning a young instance keeps both backups")
        aged = self.scratch / "aged-instance"
        aged.mkdir()
        seeded = self.json("backup-fixture", "seed-ledger", "--instance", aged, "--days", "60", "--pin", "40",
                           "--verify", "50")["seeded"]
        by_days = {item["daysBack"]: item["id"] for item in seeded}
        removed = set(self.json("moss-backup", "prune", "--instance", aged)["removed"])
        kept = {e["id"] for e in self.json("moss-backup", "list", "--instance", aged)["backups"]}
        expect(by_days[40] in kept, "retention keeps the pinned backup")
        expect(by_days[50] in kept, "retention keeps the last verified backup")
        expect(all(by_days[d] in kept for d in range(7)), "retention keeps the last 7 daily backups")
        expect(len(kept) <= 7 + 4 + 2 and len(removed) == 60 - len(kept), "retention drops the rest")
        expect(all(not (aged / "backups" / f"{i}.mossbak").exists() for i in removed),
               "pruned archives are deleted")

        print("phase7_backup_engine PASS", flush=True)


def build():
    command = ["cargo", "+1.95.0", "build", "--locked", "--manifest-path", str(REPO / "rust-spike" / "Cargo.toml"),
               "-p", "moss-backup", "-p", "bundled-db", "-p", "keystore", "--bins"]
    print("+", " ".join(command), flush=True)
    if subprocess.run(command).returncode != 0:
        fail("the backup tools did not build")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = Path(os.environ.get("CARGO_TARGET_DIR", str(REPO / "rust-spike" / "target")))
    parser.add_argument("--bin", default=os.environ.get("PHASE7_BACKUP_BIN", str(target / "debug")))
    # A lane keeps its pinned bundle beside its target folder.
    beside = target.parent / "postgres relocated"
    parser.add_argument("--postgres", default=os.environ.get("PHASE7_BACKUP_POSTGRES",
                                                             str(beside) if beside.is_dir() else None))
    parser.add_argument("--no-build", action="store_true", help="use the tools already in --bin")
    parser.add_argument("--repo", default=str(REPO))
    parser.add_argument("--scratch", default=os.environ.get("PHASE7_BACKUP_SCRATCH",
                                                            os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"),
                                                                         "phase7-backup")))
    args = parser.parse_args()
    if not args.postgres:
        fail("--postgres (or PHASE7_BACKUP_POSTGRES) must name the pinned database bundle")
    if not args.no_build:
        build()
    runner = Runner(args)
    try:
        runner.main()
    finally:
        runner.stop_children()
        runner.stop_database()
    shutil.rmtree(runner.scratch, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except AssertionError as error:
        print(f"phase7_backup_engine FAIL: {error}", flush=True)
        sys.exit(1)
