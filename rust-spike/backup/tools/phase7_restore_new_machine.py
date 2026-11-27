#!/usr/bin/env python3
"""phase7_restore_new_machine: real database, OS custody and desktop Restore dev instance.

All accounts, words, keys and files are generated test fixtures. Source and target use
different HOME and data folders. Browser requests go to real servers without interception.
"""
import argparse
import json
import os
import re
import secrets
import shutil
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from phase7_backup_engine import Runner, REPO, EXE, expect, fail


def command(argv, **kwargs):
    print("+", subprocess.list2cmdline(list(map(str, argv))), flush=True)
    result = subprocess.run(list(map(str, argv)), **kwargs)
    if result.returncode:
        fail(f"command exited {result.returncode}")
    return result


def build():
    cargo = ["cargo", "+1.95.0", "build", "--locked"]
    command([*cargo, "--manifest-path", REPO / "rust-spike/Cargo.toml", "-p", "moss-backup", "-p", "bundled-db", "-p", "keystore", "--bins"])
    command([*cargo, "--manifest-path", REPO / "rust-spike/network/Cargo.toml", "--bin", "moss-network"])
    command([*cargo, "--manifest-path", REPO / "rust-spike/shell/Cargo.toml", "-p", "moss-app", "--bins", "--example", "restore-dev", "-p", "moss-server"])
    command([*cargo, "--manifest-path", REPO / "rust-spike/shell/Cargo.toml", "-p", "moss-shell-ui", "--target", "wasm32-unknown-unknown"])
    command([*cargo, "--manifest-path", REPO / "rust-spike/ui/bindgen/Cargo.toml"])
    target = Path(os.environ["CARGO_TARGET_DIR"])
    web = target / "restore-web"
    command([target / f"debug/ui-bindgen{EXE}", target / "wasm32-unknown-unknown/debug/moss-shell-ui.wasm", web, "app"])
    command([sys.executable, REPO / "rust-spike/shell/assets/build-assets.py", web])
    command([sys.executable, REPO / "rust-spike/module-ui/build-assets.py", web / "module-shared"])
    shutil.copy2(REPO / "rust-spike/shell/assets/index.html", web / "index.html")


def machine_env(home):
    home.mkdir(parents=True)
    env = dict(os.environ, HOME=str(home), USERPROFILE=str(home),
               APPDATA=str(home / "AppData/Roaming"), LOCALAPPDATA=str(home / "AppData/Local"))
    # Linux Secret Service is supplied by the disposable session; HOME still differs.
    return env


def free_port():
    # CI has no devports service. On the shared workstation all listeners are reserved.
    if os.environ.get("GITHUB_ACTIONS") == "true":
        import socket
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1], False
    done = subprocess.run(["devports", "claim", "JS-439-restore"], text=True, capture_output=True, check=True)
    return int(done.stdout.strip()), True


def wait_http(url, child):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if child.poll() is not None:
            fail("fixture server exited before it was ready (see its task-owned log)")
        try:
            urllib.request.urlopen(url, timeout=2, context=ssl._create_unverified_context()).close()
            return
        except (OSError, urllib.error.HTTPError):
            time.sleep(0.2)
    fail("fixture server readiness deadline")


class RestoreRunner(Runner):
    def __init__(self, args):
        super().__init__(args)
        self.args = args
        self.ports = []
        self.target_env = machine_env(self.scratch / "target-home")
        self.data = self.scratch / "target-data"
        self.install = self.scratch / "install"
        self.install.mkdir()
        self.target_processes = []
        self.open_logs = []

    def port(self):
        port, reserved = free_port()
        if reserved:
            self.ports.append(port)
        return port

    def server(self, argv, env, log):
        file = log.open("w")
        self.open_logs.append(file)
        child = subprocess.Popen(list(map(str, argv)), env=env, stdin=subprocess.DEVNULL, stdout=file, stderr=file)
        self.target_processes.append(child)
        return child

    def stage_install(self):
        for name in ("moss-db", "moss-server", "moss-launcher"):
            source = self.bin / (name + EXE)
            if source.exists():
                shutil.copy2(source, self.install / source.name)
        shutil.copytree(self.pg, self.install / "postgres")
        shutil.copytree(Path(os.environ["CARGO_TARGET_DIR"]) / "restore-web", self.install / "web")
        source = (self.repo / "rust-spike/bundled-db/src/migrate.rs").read_text()
        folders = re.findall(r'"([^"]+)"', source.split("pub const FOLDERS:", 1)[1].split("];", 1)[0])
        folders += [re.search(r'const BOOTSTRAP: &str = "([^"]+)";', source)[1]]
        for folder in folders:
            shutil.copytree(self.repo / folder, self.install / "schema" / folder)

    def main(self):
        os.environ.update(machine_env(self.scratch / "source-home"))
        os.environ["HOSTNAME"] = "Restore source"
        os.environ["COMPUTERNAME"] = "Restore source"
        self.start_database()
        self.set_up_custody()
        self.stage_install()
        source_port = self.port()
        origin = f"https://127.0.0.1:{source_port}"
        self.run("moss-network", "local-certificate", self.instance / "tls", origin)
        network = {"listen": f"127.0.0.1:{source_port}", "origins": [origin], "sharing": False,
                   "certificate": str(self.instance / "tls/certificate.pem"), "private_key": str(self.instance / "tls/key.pem"),
                   "credentials": str(self.instance / "key-bundle.json")}
        path = self.instance / "network.json"
        path.write_text(json.dumps(network))
        if os.name != "nt":
            path.chmod(0o600)
        source = self.server([self.tool("moss-server"), "serve", "--instance", self.instance, "--web", self.install / "web"],
                             dict(os.environ), self.scratch / "source.log")
        wait_http(origin + "/sign-in", source)
        password = secrets.token_hex(24)
        email = f"restore-{secrets.token_hex(8)}@example.test"
        name = "Restore fixture " + secrets.token_hex(8)
        signup = urllib.request.Request(origin + "/api/auth/sign-up/email",
            data=json.dumps({"name": name, "email": email, "password": password}).encode(),
            headers={"content-type": "application/json", "origin": origin})
        with urllib.request.urlopen(signup, context=ssl._create_unverified_context(), timeout=60) as response:
            expect(response.status == 200, "source owner is created through the real authenticated setup route")
        marker = "restore-item-" + secrets.token_hex(16)
        planted = self.json("backup-fixture", "plant", "--instance", self.instance, "--canary", "http://127.0.0.1:1/never", "--marker", marker)
        # Force multiple authenticated chunks and place the damaged byte at the end.
        (self.instance / "vault/late-chunk.bin").write_bytes(secrets.token_bytes(2 * 1024 * 1024))
        good = self.backup()
        archive = self.instance / "backups" / (good["id"] + ".mossbak")
        bad_settings = self.instance / "modules.json"
        bad_settings.write_text("{")
        partial = self.backup()
        bad_settings.unlink()
        partial_archive = self.instance / "backups" / (partial["id"] + ".mossbak")
        damaged = self.scratch / "damaged.mossbak"
        bytes_ = bytearray(archive.read_bytes())
        bytes_[-1] ^= 1
        damaged.write_bytes(bytes_)
        # Source remains live after backups and after every target error; the browser checks
        # the target listings. The source is never used by target children.
        trace = self.scratch / "restore.trace"
        app_port, target_port = self.port(), self.port()
        self.target_env["MOSS_RESTORE_SERVER_PORT"] = str(target_port)
        app = self.server([self.bin / f"examples/restore-dev{EXE}", self.data, self.install, app_port, trace],
                          self.target_env, self.scratch / "restore-dev.log")
        wait_http(f"https://127.0.0.1:{app_port}", app)
        print(f"real Restore dev instance: https://127.0.0.1:{app_port}", flush=True)
        config = {"origin": f"https://127.0.0.1:{app_port}", "sourceOrigin": origin,
                  "data": str(self.data), "trace": str(trace),
                  "archive": str(archive), "damaged": str(damaged), "partial": str(partial_archive),
                  "words": self.words, "name": name, "email": email, "password": password, "proof": str(Path(self.args.proof).resolve())}
        # Generated fixture words travel on stdin, never command arguments or logged files.
        result = subprocess.run(["node", str(REPO / "rust-spike/backup/tools/restore-browser.mjs")],
                                input=json.dumps(config), text=True, stderr=subprocess.PIPE, timeout=1800)
        if result.returncode:
            # Only fixed engine milestones; never credentials or database/server log bytes.
            milestones = {"archive-checked", "staging-created", "data-checked", "machine-prepared",
                          "key-saving", "key-loading", "key-saved", "activated"}
            if trace.exists():
                print("restore milestones: " + json.dumps([line for line in trace.read_text().splitlines()
                                                          if line in milestones]), flush=True)
            print("failed target listing: " + json.dumps(sorted(p.name for p in (self.data / "servers").iterdir())), flush=True)
            # Browser exceptions contain selectors and assertions, never typed values.
            print(result.stderr[-5000:], file=sys.stderr)
            fail("real first-run Restore browser journey")
        roots = [p for p in (self.data / "servers").iterdir() if p.name.startswith("restored-")]
        expect(len(roots) == 1, "target publishes exactly one completed root")
        # Read through the actual restored running database, using the target OS key store.
        result = subprocess.run([self.tool("backup-fixture"), "restored", "--instance", str(roots[0]),
                                 "--marker", marker, "--sha256", planted["sha256"]],
                                env=self.target_env, text=True, capture_output=True, timeout=60)
        expect(result.returncode == 0, "signed-in restored instance contains the planted item and attachment with the original bytes")
        scan = self.json("backup-fixture", "scan", "--instance", self.instance, "--root", roots[0])
        expect(not scan["hits"], "restored root contains no plaintext master or restored credential value")
        self.json("backup-fixture", "restored", "--instance", self.instance,
                  "--marker", marker, "--sha256", planted["sha256"])
        expect(True, "the original instance still runs with its original item and attachment")
        listing = sorted(p.name for p in roots[0].iterdir())
        expect(not any((roots[0] / name).exists() for name in ("credentials.json", "key-file-choice.json")),
               "target has neither source plain credentials nor a headless key choice")
        print("completed target listing: " + json.dumps(listing), flush=True)
        print("phase7_restore_new_machine PASS", flush=True)

    def close(self):
        for child in reversed(self.target_processes):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=60)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=60)
        for root in self.data.glob("servers/restored-*"):
            subprocess.run([self.tool("moss-server"), "stop", "--instance", str(root)], env=self.target_env, capture_output=True, timeout=60)
            subprocess.run([self.tool("moss-db"), "stop", "--root", str(root / "database")], env=self.target_env, capture_output=True, timeout=60)
            subprocess.run([self.tool("backup-fixture"), "forget", "--instance", str(root)], env=self.target_env, capture_output=True, timeout=60)
        self.stop_children()
        self.stop_database()
        for file in self.open_logs:
            file.close()
        for port in self.ports:
            subprocess.run(["devports", "release", str(port)], capture_output=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = Path(os.environ.get("CARGO_TARGET_DIR", str(REPO / "rust-spike/target")))
    parser.add_argument("--bin", default=str(target / "debug"))
    parser.add_argument("--postgres", default=os.environ.get("PHASE7_BACKUP_POSTGRES"))
    parser.add_argument("--repo", default=str(REPO))
    parser.add_argument("--scratch", default=str(target.parent / "restore-proof"))
    parser.add_argument("--proof", default=str(target.parent / "restore-screenshots"))
    parser.add_argument("--no-build", action="store_true")
    args = parser.parse_args()
    if not args.postgres:
        fail("--postgres must name the pinned database bundle")
    if not args.no_build:
        build()
    runner = RestoreRunner(args)
    try:
        runner.main()
    finally:
        runner.close()
        shutil.rmtree(runner.scratch, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except AssertionError as error:
        print(f"phase7_restore_new_machine FAIL: {error}", flush=True)
        sys.exit(1)
