#!/usr/bin/env python3
"""Fixed Workshop host transport. No application authority or artifact acceptance here."""
import argparse
import base64
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import socketserver
import stat
import subprocess
import sys
import tempfile
import time

INPUT_LIMIT = 131072
OUTPUT_LIMIT = 2097152
WIRE_LIMIT = 240000
WALL_SECONDS = 60
REFERENCE_KEYS = {"run", "actor", "project", "revision", "attempt", "lease", "sourceHash", "recipe"}
ID_PATTERN = re.compile(r"[a-f0-9]{32}")
HASH_PATTERN = re.compile(r"[a-f0-9]{64}")


def encode(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


def read_file(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError("invalid file")
        result = stream.read(limit + 1)
        if len(result) > limit:
            raise ValueError("file limit")
        return result


def write_file(path, value):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".write-", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("private owned directory required")


def load_config(path):
    config = json.loads(read_file(path, 4096))
    if set(config) != {"state", "control", "image", "prefix", "docker", "userSystemd"}:
        raise ValueError("config shape")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", config["image"]):
        raise ValueError("immutable image required")
    if not re.fullmatch(r"workshop-[a-f0-9]{16}", config["prefix"]):
        raise ValueError("private resource namespace required")
    if type(config["userSystemd"]) is not bool:
        raise ValueError("systemd scope")
    for field in ["state", "control", "docker"]:
        if not isinstance(config[field], str) or not re.fullmatch(r"/[a-zA-Z0-9_./-]+", config[field]):
            raise ValueError("absolute deployment paths required")
    for field in ["state", "control"]:
        private_directory(Path(config[field]))
    return config


def command(*args, check=True):
    # Commands produce only bounded host metadata, never generated diagnostics.
    result = subprocess.run(args, capture_output=True, timeout=10)
    if len(result.stdout) + len(result.stderr) > 65536 or (check and result.returncode):
        raise RuntimeError("host operation failed")
    return result


def systemctl(config, *args, check=True):
    return command("systemctl", *(["--user"] if config["userSystemd"] else []), *args, check=check)


def resource_name(config, run):
    if not isinstance(run, str) or not ID_PATTERN.fullmatch(run):
        raise ValueError("run identity")
    return config["prefix"] + "-" + run


def decode_request(wire, key):
    outer = json.loads(wire)
    if not isinstance(outer, dict) or set(outer) != {"payload", "mac"}:
        raise ValueError("envelope")
    raw = base64.b64decode(outer["payload"], validate=True)
    if not isinstance(outer["mac"], str) or not hmac.compare_digest(
        hmac.digest(key, raw, "sha256").hex(), outer["mac"]
    ):
        raise ValueError("authentication")
    request = json.loads(raw)
    if not isinstance(request, dict) or set(request) != {"op", "expires", "reference", "source"}:
        raise ValueError("request")
    if request["op"] not in {"start", "status", "stop", "result"}:
        raise ValueError("operation")
    if type(request["expires"]) is not int or not time.time() < request["expires"] <= time.time() + 60:
        raise ValueError("expired request")
    reference = request["reference"]
    if not isinstance(reference, dict) or set(reference) != REFERENCE_KEYS:
        raise ValueError("reference")
    for field in REFERENCE_KEYS - {"sourceHash", "recipe"}:
        if not isinstance(reference[field], str) or not ID_PATTERN.fullmatch(reference[field]):
            raise ValueError("reference identity")
    if not isinstance(reference["sourceHash"], str) or not HASH_PATTERN.fullmatch(reference["sourceHash"]):
        raise ValueError("source hash")
    if reference["recipe"] not in {"build", "render"}:
        raise ValueError("recipe")
    if request["op"] == "start":
        source = base64.b64decode(request["source"], validate=True)
        if not 0 < len(source) <= INPUT_LIMIT or hashlib.sha256(source).hexdigest() != reference["sourceHash"]:
            raise ValueError("source binding")
    elif request["source"] is not None:
        raise ValueError("unexpected source")
    return request


def unit_state(config, name):
    result = systemctl(config, "show", name + ".service", "--property=ActiveState", "--value")
    state = result.stdout.decode().strip()
    if state not in {"active", "activating", "deactivating", "inactive", "failed"}:
        raise RuntimeError("unknown unit state")
    return state


def container_absent(config, name):
    # A daemon error cannot be mistaken for absence (unlike inspect's shared error code).
    names = command(config["docker"], "ps", "-a", "--filter", "name=^" + name + "$", "--format", "{{.Names}}")
    return not names.stdout.strip()


def status(config, run_dir, name):
    if (run_dir / "terminal").exists():
        return "stopped" if (run_dir / "stop").exists() else read_file(run_dir / "terminal", 32).decode()
    state = unit_state(config, name)
    if state in {"active", "activating", "deactivating"}:
        return "stopping" if (run_dir / "stop").exists() else "running"
    if not container_absent(config, name):
        return "recovery-needed"
    if (run_dir / "stop").exists():
        terminal = "stopped"
    elif (run_dir / "exit.json").exists():
        terminal = "exited" if json.loads(read_file(run_dir / "exit.json", 256))["code"] == 0 else "failed"
    else:
        return "recovery-needed"
    write_file(run_dir / "terminal", terminal.encode())
    return terminal


def dispatch(config, config_path, request):
    reference = request["reference"]
    name = resource_name(config, reference["run"])
    state_dir = Path(config["state"])
    run_dir = state_dir / reference["run"]
    if run_dir.exists():
        if json.loads(read_file(run_dir / "reference.json", 2048)) != reference:
            raise ValueError("reference mismatch")
        if request["op"] == "start":
            return {"ok": False, "error": "already-started"}
    elif request["op"] != "start":
        raise ValueError("unknown reference")
    else:
        runs = [path for path in state_dir.iterdir() if ID_PATTERN.fullmatch(path.name)]
        # ponytail: two concurrent units and 1024 lifetime claims per installation. Archive
        # an inactive deployment journal before capacity growth; never expire replay fences.
        if len(runs) >= 1024:
            return {"ok": False, "error": "journal-full"}
        active = sum(status(config, path, resource_name(config, path.name)) in
                     {"running", "stopping", "recovery-needed"} for path in runs)
        if active >= 2:
            return {"ok": False, "error": "busy"}
        pending = Path(tempfile.mkdtemp(dir=state_dir, prefix=".claim-"))
        try:
            write_file(pending / "reference.json", encode(reference))
            write_file(pending / "source.json", base64.b64decode(request["source"], validate=True))
            os.rename(pending, run_dir)
        finally:
            if pending.exists():
                shutil.rmtree(pending)
        # Persist the consumed claim before asking the independent manager to launch.
        fd = os.open(state_dir, os.O_DIRECTORY)
        os.fsync(fd)
        os.close(fd)
        command("systemd-run", *(["--user"] if config["userSystemd"] else []), "--quiet",
                "--unit=" + name, "--property=RuntimeMaxSec=60", "--property=TimeoutStopSec=5",
                "--property=KillMode=control-group", "--property=UMask=0077",
                "--property=StandardOutput=null", "--property=StandardError=null",
                "--property=ExecStopPost=" + config["docker"] + " rm -f " + name,
                "--", sys.executable, str(Path(__file__).resolve()), "--config", str(config_path),
                "--run", reference["run"])
        return {"ok": True, "state": "accepted", "reference": reference}
    if request["op"] == "stop":
        if not (run_dir / "stop").exists():
            write_file(run_dir / "stop", b"")
        systemctl(config, "stop", name + ".service", check=False)
        # Only reap after the manager is terminal, so a racing create cannot follow removal.
        if unit_state(config, name) in {"inactive", "failed"}:
            command(config["docker"], "rm", "-f", name, check=False)
    current = status(config, run_dir, name)
    result = {"ok": True, "state": current, "reference": reference}
    if request["op"] == "result" and current == "exited":
        result["proposal"] = base64.b64encode(read_file(run_dir / "proposal.json", OUTPUT_LIMIT)).decode()
    return result


def bounded_pipe(process, source):
    pending = memoryview(source)
    output = bytearray()
    stderr_bytes = 0
    deadline = time.monotonic() + WALL_SECONDS - 5
    with selectors.DefaultSelector() as selector:
        for stream, kind, event in [(process.stdin, "in", selectors.EVENT_WRITE),
                                    (process.stdout, "out", selectors.EVENT_READ),
                                    (process.stderr, "err", selectors.EVENT_READ)]:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, event, kind)
        while selector.get_map():
            if time.monotonic() >= deadline:
                raise TimeoutError("runtime deadline")
            for entry, _ in selector.select(0.5):
                if entry.data == "in":
                    try:
                        pending = pending[os.write(entry.fd, pending):]
                    except BrokenPipeError:
                        pending = memoryview(b"")
                    if not pending:
                        selector.unregister(entry.fileobj)
                        entry.fileobj.close()
                    continue
                chunk = os.read(entry.fd, 65536)
                if not chunk:
                    selector.unregister(entry.fileobj)
                    entry.fileobj.close()
                elif entry.data == "out":
                    if len(output) + len(chunk) > OUTPUT_LIMIT:
                        raise ValueError("output limit")
                    output.extend(chunk)
                else:
                    stderr_bytes += len(chunk)
                    if stderr_bytes > 65536:
                        raise ValueError("diagnostic limit")
    return process.wait(timeout=2), bytes(output)


def run_container(config, run):
    name = resource_name(config, run)
    run_dir = Path(config["state"]) / run
    reference = json.loads(read_file(run_dir / "reference.json", 2048))
    source = read_file(run_dir / "source.json", INPUT_LIMIT)
    if hashlib.sha256(source).hexdigest() != reference["sourceHash"] or (run_dir / "stop").exists():
        raise ValueError("invalidated source")
    memory, pids, cpu = ("512m", "128", "0.5") if reference["recipe"] == "render" else ("192m", "64", "0.25")
    process = None
    code = 1
    try:
        command(config["docker"], "create", "-i", "--name", name,
                "--label", "moss.workshop=" + config["prefix"], "--pull", "never",
                "--user", "1000:1000", "--network", "none", "--read-only", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--memory", memory, "--memory-swap", memory,
                "--pids-limit", pids, "--cpus", cpu, "--log-driver", "none", "--ulimit", "nofile=256:256",
                "--tmpfs", "/attempt:rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700",
                "--entrypoint", "/usr/local/bin/node", config["image"], "/opt/workshop/run.mjs", reference["recipe"])
        process = subprocess.Popen([config["docker"], "start", "-ai", name], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        code, output = bounded_pipe(process, source)
        if code == 0:
            write_file(run_dir / "proposal.json", output)
    except Exception:
        code = 1
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            for stream in [process.stdin, process.stdout, process.stderr]:
                stream.close()
        write_file(run_dir / "exit.json", encode({"code": code}))
    # ExecStopPost removes the exact container even when this helper is killed.
    return code


def serve(config, config_path):
    key = read_file(Path(config["control"]) / "key", 32)
    if len(key) != 32:
        raise ValueError("service key")
    with (Path(config["state"]) / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        socket_path = Path(config["control"]) / "control.sock"
        if socket_path.exists():
            if not stat.S_ISSOCK(socket_path.lstat().st_mode):
                raise ValueError("socket path occupied")
            socket_path.unlink()

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                self.connection.settimeout(3)
                try:
                    wire = self.rfile.readline(WIRE_LIMIT + 1)
                    if len(wire) > WIRE_LIMIT or not wire.endswith(b"\n"):
                        raise ValueError("wire limit")
                    reply = dispatch(config, config_path, decode_request(wire, key))
                except (ValueError, TypeError, KeyError, UnicodeError):
                    reply = {"ok": False, "error": "denied"}
                except Exception:
                    reply = {"ok": False, "error": "control-unavailable"}
                try:
                    self.wfile.write(encode(reply) + b"\n")
                except OSError:
                    pass

        # ponytail: serial bounded control requests; builds run in independent units.
        with socketserver.UnixStreamServer(str(socket_path), Handler) as server:
            socket_path.chmod(0o600)
            server.serve_forever()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--run")
    args = parser.parse_args()
    config = load_config(args.config)
    if args.run:
        return run_container(config, args.run)
    serve(config, args.config.resolve())
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("Workshop host control unavailable.", file=sys.stderr)
        sys.exit(1)
