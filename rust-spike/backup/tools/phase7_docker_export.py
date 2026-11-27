#!/usr/bin/env python3
"""phase7_docker_export: published-image, task-owned Linux Docker move proof.

Never restarts the shared daemon. Recreates abrupt-host-loss conditions by explicitly starting
ONLY this disposable stack, then SIGKILLing its processes and observing Docker's real restart
manager. This proves restart=no prevents automatic resurrection after process loss, plus checks
the persisted HostConfig policy. A physical host/daemon reboot is not claimed by this runner.
All keys, words and user values are generated, captured privately, and removed in finally.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

REPO = Path(__file__).resolve().parents[3]
TARGET = Path(os.environ.get("CARGO_TARGET_DIR", REPO / "rust-spike/target"))


def expect(condition, message):
    if not condition:
        raise AssertionError(message)
    print("ok: " + message, flush=True)


def command(args, *, data=None, env=None, check=True, pass_fds=(), timeout=600):
    # Never forward subprocess diagnostics: Docker/migrations may echo generated credentials.
    result = subprocess.run(list(map(str, args)), input=data, capture_output=True,
                            env=env, pass_fds=pass_fds, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"{Path(str(args[0])).name} operation failed (exit {result.returncode}); private output withheld")
    return result


def build():
    env = {**os.environ, "CARGO_BUILD_JOBS": "1", "CARGO_PROFILE_DEV_DEBUG": "0",
           "CARGO_PROFILE_TEST_DEBUG": "0", "CARGO_INCREMENTAL": "0"}
    subprocess.run(["cargo", "+1.95.0", "build", "--locked", "--manifest-path",
                    str(REPO / "rust-spike/Cargo.toml"), "-p", "moss-backup", "--bins"],
                   check=True, env=env)


class Stack:
    def __init__(self, scratch):
        self.scratch = scratch
        self.project = "js440-export-" + secrets.token_hex(5)
        self.file = scratch / "compose.json"
        self.env = dict(os.environ)
        # Compose/children must never inherit host deployment database/credential variables.
        for key in list(self.env):
            if key.startswith(("JARVIS_", "MOSS_", "PG")):
                del self.env[key]
        self.port = None
        self.images_before = set(command(["docker", "image", "ls", "-q", "--no-trunc"]).stdout.split())
        self.image_ids = set()
        self.secrets = [secrets.token_hex(32) for _ in range(8)]
        self.item = "fixture-item-" + secrets.token_hex(12)
        self.attachment = os.urandom(8192)
        self.account = "14da8cd7-d1ef-4d4a-a7a0-595ace14f001"

    def compose(self, *args, **kwargs):
        return command(["docker", "compose", "-p", self.project, "-f", self.file, *args], env=self.env, **kwargs)

    def container(self, service):
        return self.compose("ps", "-aq", service).stdout.decode().strip()

    def inspect(self, container):
        return json.loads(command(["docker", "inspect", container]).stdout)[0]

    def sql(self, sql):
        return command(["docker", "exec", "-i", self.container("postgres"), "psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "jarv1s"], data=sql.encode()).stdout

    def setup(self):
        if shutil.which("devports"):
            self.port = int(command(["devports", "claim", self.project]).stdout.decode().strip())
        elif os.environ.get("CI") == "true":
            # CI uses the same project's reservation CLI, injected by the workflow.
            raise RuntimeError("CI must provide devports on PATH")
        else:
            raise RuntimeError("devports is required; never choose a host port by hand")
        expect(5180 <= self.port <= 5299, "throwaway port is reserved in the shared dev range")
        image = os.environ.get("PHASE7_DOCKER_IMAGE", "ghcr.io/motioneso/moss:edge")
        expect(image.startswith("ghcr.io/motioneso/moss:"), "app and worker use the published Moss image")
        runtime = {"NODE_ENV": "production", "JARVIS_CONNECTOR_SECRET_KEY": self.secrets[1],
                   "JARVIS_AI_SECRET_KEY": self.secrets[2], "JARVIS_CLI_RUNNER_RPC_SECRET": self.secrets[3],
                   "JARVIS_APP_VERSION": image.rsplit(":", 1)[1], "JARVIS_EMBED_PROVIDER": "fake",
                   "JARVIS_MODULES_DIR": "/data/modules", "HOST": "0.0.0.0", "PORT": "3000"}
        for key, role, password in zip(["BOOTSTRAP", "MIGRATION", "APP", "AUTH", "WORKER"],
                                       ["postgres", "jarvis_migration_owner", "jarvis_app_runtime", "jarvis_auth_runtime", "jarvis_worker_runtime"],
                                       [self.secrets[0], *self.secrets[4:8]]):
            runtime[f"JARVIS_{key}_DATABASE_URL"] = f"postgres://{role}:{password}@postgres:5432/jarv1s"
        # Preserve retired key iteration order and a generated signing config in the key bundle.
        runtime["JARVIS_AI_SECRET_KEYS"] = json.dumps({"retired-b": secrets.token_hex(32), "retired-a": secrets.token_hex(32)})
        self.secrets.append(runtime["JARVIS_AI_SECRET_KEYS"])
        config = {"services": {
            "postgres": {"image": "pgvector/pgvector:pg17", "environment": {"POSTGRES_DB": "jarv1s", "POSTGRES_PASSWORD": self.secrets[0]},
                         "restart": "always", "volumes": ["database:/var/lib/postgresql/data"]},
            "app": {"image": image, "command": ["node", "dist/server.js"], "environment": runtime,
                    "restart": "always", "ports": [f"127.0.0.1:{self.port}:3000"], "volumes": ["vault:/data/vaults"]},
            "worker": {"image": image, "command": ["node", "dist/worker.js"], "environment": runtime,
                       "restart": "always", "volumes": ["vault:/data/vaults"]},
            "migrate": {"image": image, "command": ["node_modules/.bin/tsx", "scripts/migrate.ts"],
                        "environment": runtime, "profiles": ["ops"]}},
                  "volumes": {"database": {}, "vault": {}}}
        self.file.write_text(json.dumps(config))
        self.file.chmod(0o600)
        self.compose("pull", "postgres", "app", "worker")
        for name in ("pgvector/pgvector:pg17", image):
            self.image_ids.add(command(["docker", "image", "inspect", "--format", "{{.Id}}", name]).stdout.strip())
        self.compose("up", "-d", "postgres")
        for _ in range(90):
            ready = command(["docker", "exec", self.container("postgres"), "pg_isready", "-U", "postgres", "-d", "jarv1s"], check=False)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("throwaway database never became ready")
        self.compose("--profile", "ops", "run", "--rm", "migrate")
        self.sql(f"INSERT INTO app.users(id,email) VALUES ('{self.account}','fixture@example.invalid'); "
                 f"INSERT INTO app.rls_probe_items(id,owner_user_id,body) VALUES ('14da8cd7-d1ef-4d4a-a7a0-595ace14f002','{self.account}','{self.item}');")
        self.compose("up", "-d", "app", "worker")
        for _ in range(120):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health/ready", timeout=2) as response:
                    if response.status == 200:
                        break
            except (OSError, TimeoutError):
                pass
            time.sleep(1)
        else:
            raise RuntimeError("published app did not become ready (private logs withheld)")
        expect(self.inspect(self.container("worker"))["State"]["Running"], "published app and worker are running against their own migrated database")
        command(["docker", "exec", "-i", self.container("app"), "sh", "-c", f"mkdir -p /data/vaults/{self.account}; cat > /data/vaults/{self.account}/attachment.bin"], data=self.attachment)

    def close(self):
        if self.file.exists():
            self.compose("down", "--volumes", "--remove-orphans", check=False)
        if self.port is not None:
            command(["devports", "release", self.port], check=False)
        # Never remove an image that existed before this run or force-remove a shared image.
        for image in self.image_ids - self.images_before:
            command(["docker", "image", "rm", image.decode()], check=False)
        shutil.rmtree(self.scratch, ignore_errors=True)

    def run_export(self, plan, output, env=None):
        config = self.scratch / (output.stem + ".json")
        config.write_text(json.dumps(plan))
        read_fd, write_fd = os.pipe()
        try:
            result = command([TARGET / "debug/moss-docker-export", "--config", config, "--output", output,
                              "--recovery-fd", write_fd], pass_fds=(write_fd,), check=False, env=env)
            os.close(write_fd)
            write_fd = None
            words = os.read(read_fd, 4096)
        finally:
            os.close(read_fd)
            if write_fd is not None:
                os.close(write_fd)
        return result, words

    def reboot_conditions(self, containers):
        if os.environ.get("PHASE7_DOCKER_RESTART_DAEMON") == "1":
            # A real restart is allowed ONLY on GitHub's disposable hosted Linux machine and
            # only when every existing container belongs to this exact random proof project.
            expect(os.environ.get("GITHUB_ACTIONS") == "true"
                   and os.environ.get("PHASE7_DOCKER_RUNNER") == "github-hosted",
                   "daemon restart is confined to a disposable GitHub-hosted runner")
            all_ids = command(["docker", "ps", "-aq"]).stdout.decode().split()
            expect(bool(all_ids) and all(self.inspect(c)["Config"]["Labels"].get("com.docker.compose.project") == self.project for c in all_ids),
                   "no foreign container exists before restarting the CI daemon")
            command(["sudo", "systemctl", "restart", "docker"], timeout=120)
            for _ in range(60):
                if command(["docker", "info"], check=False).returncode == 0:
                    break
                time.sleep(1)
            time.sleep(4)
            self.assert_fenced(containers)
            print("ok: actual Docker daemon restart on disposable Linux CI leaves old writers stopped", flush=True)
            return
        # Explicitly starting disposable containers clears Docker's manual-stop bit, then abrupt
        # process loss engages the daemon's restart manager. No shared service is restarted.
        # First check persisted policies independently of the exporter's receipt checker.
        for container in containers:
            command(["docker", "start", container])
        time.sleep(11)
        for container in containers:
            command(["docker", "kill", "--signal", "KILL", container], check=False)
        time.sleep(4)
        self.assert_fenced(containers)

    def assert_fenced(self, containers):
        expect(all(not self.inspect(c)["State"]["Running"]
                   and not self.inspect(c)["State"]["Restarting"]
                   and self.inspect(c)["HostConfig"]["RestartPolicy"]["Name"] == "no" for c in containers),
               "reboot-condition replay leaves old app and worker stopped with persisted restart=no")

    def prove(self):
        self.setup()
        app, worker, db = (self.container(s) for s in ("app", "worker", "postgres"))
        # Refusal before side effects: missing mount disposition and a wrong project.
        plan = {"project": self.project, "database": "jarv1s", "postgres": db,
                "writers": [app, worker], "externalSupervisorsDisabled": True,
                "mounts": [{"container": app, "target": "/data/vaults", "archive": "vault", "disposition": "transferred"},
                           {"container": worker, "target": "/data/vaults", "disposition": "reconstructed", "reason": "same volume already captured from app"}]}
        for label, bad in [("mount", {**plan, "mounts": []}), ("identity", {**plan, "project": "wrong-project"})]:
            result, words = self.run_export(bad, self.scratch / (label + ".mossbak"))
            expect(result.returncode != 0 and not words and self.inspect(app)["State"]["Running"],
                   f"{label} mismatch refuses before stopping the source")
        # Real Docker operations with an injected command failure, not a pretend stopped state.
        docker_binary = shutil.which("docker")
        faults = self.scratch / "faults"
        faults.mkdir()
        shim = faults / "docker"
        for operation, reason in [("update", "turn off a source container restart policy"),
                                  ("stop", "stop a source app or worker container")]:
            shim.write_text(f'#!/bin/sh\nif [ "$1" = "{operation}" ]; then exit 42; fi\nexec "{docker_binary}" "$@"\n')
            shim.chmod(0o700)
            fault_env = {**os.environ, "PATH": str(faults) + os.pathsep + os.environ["PATH"]}
            result, words = self.run_export(plan, self.scratch / (operation + ".mossbak"), env=fault_env)
            expect(result.returncode != 0 and not words and reason.encode() in result.stdout,
                   f"a Docker {operation} failure refuses export with a plain reason")
        # The stop failure already changed policies; reset only our throwaway project for capture.
        for container in (app, worker, db):
            command(["docker", "update", "--restart=always", container])
        output = self.scratch / "move.mossbak"
        result, words = self.run_export(plan, output)
        # A failed run's diagnostics are safe structured exporter messages, but never echo them
        # if an accidental change has put a generated secret in the result.
        if result.returncode:
            report = json.loads(result.stdout)
            raise RuntimeError("export refused: " + report.get("error", "unknown error"))
        expect(bool(words) and len(words.split()) == 24, "fresh move recovery words arrive once through a private pipe")
        content = output.read_bytes()
        expect(all(secret.encode() not in content for secret in [*self.secrets, words.decode().strip()]),
               "byte search finds no plaintext credential or recovery words in the archive")
        expect(all(secret.encode() not in result.stdout + result.stderr for secret in self.secrets),
               "export diagnostics contain no generated credential")
        self.reboot_conditions([app, worker])
        command([TARGET / "debug/moss-docker-export", "check-fence", output.with_suffix(".fence.json")])
        expect(not self.inspect(db)["State"]["Running"], "source database is also stopped after its read-only dump")
        words_file = self.scratch / "words"
        words_file.write_bytes(words)
        words_file.chmod(0o600)
        opened = self.scratch / "opened"
        command([TARGET / "debug/docker-export-fixture", output, words_file, opened])
        manifest = json.loads((opened / "manifest.json").read_bytes())
        expect(manifest["accountsCount"] == 1 and manifest["schemaVersion"] and manifest["catalog"]["extensions"],
               "part 4 reader opens account, schema, module and extension inventory")
        expect((opened / "files/vault" / self.account / "attachment.bin").read_bytes() == self.attachment,
               "part 4 reader verifies the seeded attachment bytes and every recorded file hash")
        credentials = (opened / "credentials.json").read_bytes()
        expect(all(secret.encode() in credentials or json.dumps(secret)[1:-1].encode() in credentials for secret in self.secrets),
               "recovery unwraps current and retired keys with their original order")
        # pg_restore renders the custom dump; check the item and account in its actual SQL.
        command(["docker", "start", db])
        for _ in range(30):
            if command(["docker", "exec", db, "pg_isready", "-U", "postgres"], check=False).returncode == 0:
                break
            time.sleep(1)
        command(["docker", "cp", opened / "database.dump", f"{db}:/tmp/fixture.dump"])
        sql = command(["docker", "exec", db, "pg_restore", "--file=-", "/tmp/fixture.dump"]).stdout
        expect(self.item.encode() in sql and self.account.encode() in sql,
               "container pg_restore finds the seeded item and account in the archived custom dump")
        command(["docker", "stop", db])
        # Damage, wrong key, and changed live policy must be rejected by the real readers.
        damaged = bytearray(content)
        damaged[-20] ^= 1
        bad = self.scratch / "damaged.mossbak"
        bad.write_bytes(damaged)
        expect(command([TARGET / "debug/docker-export-fixture", bad, words_file, self.scratch / "bad-open"], check=False).returncode != 0,
               "damaged archive is refused")
        command(["docker", "update", "--restart=always", worker])
        expect(command([TARGET / "debug/moss-docker-export", "check-fence", output.with_suffix(".fence.json")], check=False).returncode != 0,
               "import-side fence check rejects a changed source restart policy")
        command(["docker", "update", "--restart=no", worker])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-build", action="store_true")
    args = parser.parse_args()
    if sys.platform != "linux":
        raise RuntimeError("Docker-host proof is Linux only")
    if not args.no_build:
        build()
    scratch = Path(tempfile.mkdtemp(prefix="phase7-docker-export-", dir=os.environ.get("PHASE7_DOCKER_SCRATCH")))
    scratch.chmod(0o700)
    stack = Stack(scratch)
    try:
        stack.prove()
    finally:
        stack.close()
    print("phase7_docker_export: PASS; throwaway containers, volumes, reserved port and new images cleaned", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"phase7_docker_export: FAIL: {error}", file=sys.stderr)
        sys.exit(1)
