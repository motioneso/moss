#!/usr/bin/env python3
"""Synthetic A0 host-control feasibility check; never install this as a service."""

import json
import os
from pathlib import Path
import secrets
import shutil
import socketserver
import subprocess
import sys
import time


def command(*args, timeout=15, check=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"{args[0]} failed: {(result.stdout + result.stderr)[-500:]}")
    return result


def serve(config_path):
    config = json.loads(Path(config_path).read_text())

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            self.connection.settimeout(3)
            reply = {"ok": False, "error": "denied"}
            try:
                data = self.rfile.readline(2049)
                if len(data) > 2048 or not data.endswith(b"\n"):
                    raise ValueError("envelope")
                request = json.loads(data)
                if not isinstance(request, dict) or set(request) != {"token", "op", "run", "lease"}:
                    raise ValueError("shape")
                if not all(isinstance(value, str) for value in request.values()):
                    raise ValueError("types")
                owner = config["tokens"].get(request["token"])
                run = config["runs"].get(request["run"])
                if not owner or not run or owner != run["owner"] or request["lease"] != run["lease"]:
                    raise ValueError("authority")
                name = run["name"]
                claim = Path(config["claims"]) / name
                if request["op"] == "start":
                    try:
                        # Fixed fixture ID, host-private directory. Burn before dispatch; a lost
                        # acknowledgement stays consumed across broker restart.
                        with claim.open("x"):
                            pass
                    except FileExistsError:
                        reply = {"ok": False, "error": "already-started"}
                    else:
                        command(
                            "systemd-run", "--user", "--quiet", f"--unit={name}",
                            f"--property=RuntimeMaxSec={run['seconds']}",
                            "--property=TimeoutStopSec=3", "--property=KillMode=control-group",
                            f"--property=ExecStopPost={config['docker']} rm -f {name}",
                            "--property=StandardOutput=null", "--property=StandardError=null",
                            "--", config["docker"], "run", "--name", name,
                            "--label", f"workshop.control-proof={config['prefix']}",
                            *config["profile"], config["image"], "tree",
                        )
                        reply = {"ok": True, "state": "accepted"}
                elif request["op"] == "stop" and claim.is_file():
                    command("systemctl", "--user", "stop", f"{name}.service")
                    reply = {"ok": True, "state": "stop-command-completed"}
            except (ValueError, TypeError, TimeoutError):
                pass
            except Exception:
                # No request/token, provider data, Docker stderr or host path in the response.
                reply = {"ok": False, "error": "control-failed"}
            try:
                self.wfile.write(json.dumps(reply).encode() + b"\n")
            except (BrokenPipeError, TimeoutError):
                pass

    # ponytail: serial synthetic launcher; production admission/persistence belongs to R1/D3.
    with socketserver.UnixStreamServer(config["socket"], Handler) as server:
        os.chmod(config["socket"], 0o600)
        Path(config["ready"]).touch()
        server.serve_forever()


CLIENT = r'''
const fs = require("fs"), net = require("net"), assert = require("assert/strict");
assert.equal(process.getuid(), 1000);
assert.equal(fs.existsSync("/var/run/docker.sock"), false);
assert.equal(fs.existsSync("/run/user/1000/bus"), false);
assert.equal(fs.existsSync("/control/config.json"), false);
let input = "";
process.stdin.on("data", x => input += x);
process.stdin.on("end", () => {
  const socket = net.createConnection("/control/control.sock");
  socket.setTimeout(5000, () => { socket.destroy(); process.exit(2); });
  socket.on("error", () => process.exit(3));
  socket.on("connect", () => socket.write(input + "\n"));
  socket.on("data", x => process.stdout.write(x));
  socket.on("end", () => socket.destroy());
});
'''


def run_proof(image, prefix, profile, temporary, containers, docker, report, process_identity):
    if not __debug__ or os.getuid() != 1000:
        raise RuntimeError("Assertions and host UID 1000 required by this synthetic fixture")
    command("systemctl", "--user", "show", "--property=Version")
    control_dir = temporary / "control"
    control_dir.mkdir(mode=0o700)
    (temporary / "claims").mkdir(mode=0o700)
    tokens = {secrets.token_hex(24): owner for owner in ["alice", "bob"]}
    owner_tokens = {owner: token for token, owner in tokens.items()}
    runs = {
        key: {"name": f"{prefix}-{key}", "owner": owner, "lease": secrets.token_hex(8),
              "seconds": seconds}
        for key, owner, seconds in [("peer", "bob", 90), ("cancel", "alice", 60),
                                    ("deadline", "alice", 20)]
    }
    containers.update(run["name"] for run in runs.values())
    config = {"image": image, "prefix": prefix, "profile": profile, "tokens": tokens,
              "runs": runs, "docker": shutil.which("docker"),
              "socket": str(control_dir / "control.sock"), "ready": str(temporary / "ready"),
              "claims": str(temporary / "claims")}
    config_path = temporary / "config.json"
    config_path.write_text(json.dumps(config))
    config_path.chmod(0o600)
    def launch_server():
        Path(config["ready"]).unlink(missing_ok=True)
        Path(config["socket"]).unlink(missing_ok=True)
        return subprocess.Popen([sys.executable, __file__, "--serve", str(config_path)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    server = launch_server()

    def server_ready():
        end = time.monotonic() + 5
        while not Path(config["ready"]).exists() and time.monotonic() < end:
            assert server.poll() is None
            time.sleep(0.05)
        assert Path(config["ready"]).exists()

    def request(owner, action, key, **changes):
        value = {"token": owner_tokens[owner], "op": action, "run": key,
                 "lease": runs[key]["lease"]}
        value.update(changes)
        name = f"{prefix}-client"
        containers.add(name)
        result = docker("run", "--rm", "-i", "--name", name, *profile,
                        "--mount", f"type=bind,src={control_dir},dst=/control,readonly",
                        "--entrypoint", "/usr/local/bin/node", image, "-e", CLIENT,
                        input_text=json.dumps(value), timeout=15)
        return json.loads(result.stdout)

    def ready(key):
        name = runs[key]["name"]
        # Docker start is asynchronous after systemd accepts the unit. Bound readiness locally.
        end = time.monotonic() + 8
        while time.monotonic() < end:
            state = docker("inspect", name, check=False)
            if state.returncode == 0 and json.loads(state.stdout)[0]["State"]["Running"]:
                docker("exec", name, "/usr/local/bin/node", "/probe.mjs", "ready",
                       "/attempt/tree-ready", timeout=5)
                pids = docker("top", name, "-eo", "pid").stdout.splitlines()[1:]
                identities = {int(pid): process_identity(int(pid)) for pid in pids}
                assert len(identities) >= 3 and all(identities.values())
                metadata = json.loads(docker("inspect", name).stdout)[0]
                assert metadata["HostConfig"]["NetworkMode"] == "none"
                assert not metadata["HostConfig"]["Privileged"]
                assert metadata["HostConfig"]["CapDrop"] == ["ALL"]
                assert not [mount for mount in metadata["Mounts"] if mount["Type"] == "bind"]
                return identities
            time.sleep(0.1)
        raise AssertionError("Unit did not start its container")

    def absent(key, identities):
        name = runs[key]["name"]
        names = docker("ps", "-a", "--filter", f"name=^{name}$", "--format", "{{.Names}}")
        assert not names.stdout.strip()
        assert all(process_identity(pid) != identity for pid, identity in identities.items())

    try:
        server_ready()
        for changes in [{"token": "invalid"}, {"lease": "stale"}, {"command": "docker ps"},
                        {"run": "../../outside"}, {"op": "exec"}]:
            assert request("alice", "start", "cancel", **changes) == {"ok": False, "error": "denied"}
        assert request("bob", "start", "cancel") == {"ok": False, "error": "denied"}
        report("container-client-control-authority-and-fixed-vocabulary", status="pass", denials=6)

        assert request("bob", "start", "peer")["ok"]
        peer_ids = ready("peer")
        assert request("alice", "start", "cancel")["ok"]
        cancel_ids = ready("cancel")
        assert request("alice", "start", "cancel")["error"] == "already-started"
        assert request("bob", "stop", "cancel")["error"] == "denied"
        assert request("alice", "stop", "cancel")["ok"]
        absent("cancel", cancel_ids)
        assert request("alice", "start", "cancel")["error"] == "already-started"
        report("authorized-stop-and-replay-rejection", status="pass", processes=len(cancel_ids))

        assert request("alice", "start", "deadline")["ok"]
        deadline_ids = ready("deadline")
        server.kill()
        assert server.wait(timeout=5) == -9
        report("host-control-process-killed", status="pass")
        docker("wait", runs["deadline"]["name"], timeout=30)
        # Observe manager completion without sending a stop that could supply cleanup itself.
        end = time.monotonic() + 6
        while time.monotonic() < end:
            state = command("systemctl", "--user", "show", runs["deadline"]["name"] + ".service",
                            "--property=ActiveState", "--value").stdout.strip()
            if state == "failed":
                break
            time.sleep(0.1)
        assert state == "failed", state
        result = command("systemctl", "--user", "show", runs["deadline"]["name"] + ".service",
                         "--property=Result", "--value").stdout.strip()
        assert result == "timeout", result
        absent("deadline", deadline_ids)
        assert all(process_identity(pid) == identity for pid, identity in peer_ids.items())
        report("systemd-deadline-survives-control-death", status="pass", result=result,
               processes=len(deadline_ids), peer_unchanged=True)
        server = launch_server()
        server_ready()
        assert request("alice", "start", "cancel")["error"] == "already-started"
        assert request("alice", "start", "deadline")["error"] == "already-started"
        assert request("alice", "start", "deadline", lease="stale")["error"] == "denied"
        assert request("bob", "stop", "peer")["ok"]
        absent("peer", peer_ids)
        report("broker-restart-preserves-claims-and-authorized-stop", status="pass")
        report("production-wiring-and-durable-application-authority", status="unproved")
    finally:
        if server.poll() is None:
            server.kill()
            server.wait(timeout=5)
        errors = []
        for run in runs.values():
            unit = run["name"] + ".service"
            try:
                command("systemctl", "--user", "stop", unit, check=False)
                command("systemctl", "--user", "reset-failed", unit, check=False)
                units = command("systemctl", "--user", "list-units", "--all", "--no-legend", unit)
                assert not units.stdout.strip(), units.stdout
            except Exception as error:
                errors.append(str(error))
        assert not errors, errors
        report("owned-transient-unit-cleanup", status="pass", units=len(runs))


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--serve":
        raise SystemExit("Run via run-container-proof.py --control-plane")
    serve(sys.argv[2])
