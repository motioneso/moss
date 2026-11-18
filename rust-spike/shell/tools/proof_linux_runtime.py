#!/usr/bin/env python3
"""Run through verify-gate with MOSS_CLEAN_INSTALL, MOSS_RUNTIME_PROOF and MOSS_PROOF_PORT.

Imports a scratch Docker root containing only the staged install and a shell baseline.
Never mounts host libraries. This exercises the headless runtime, not the native WebKit UI.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time
import uuid

from linux_runtime import dependencies
from uninstall import uninstall


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=240, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{args[0]} exited {result.returncode}: {result.stderr[-1600:]}")
    return result.stdout


def copy_baseline(root: Path, source: Path, target: str, runtime: Path):
    dest = root / target.lstrip("/")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)
    for library in dependencies(source):
        bundled = runtime / library.name
        if library.name == "libc.so.6" or library.name.startswith("ld-linux"):
            if not bundled.is_file():
                raise ValueError(f"Runtime closure is missing {library.name}")
        dest = root / str(library).lstrip("/")
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(bundled if bundled.is_file() else library, dest)


def tree_digest(root: Path):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob("*") if path.is_file()}


def prove():
    if os.environ.get("JARVIS_GATE_RUN") != "1":
        raise RuntimeError("Run this database proof through scripts/run-gate.sh")
    install = Path(os.environ["MOSS_CLEAN_INSTALL"]).resolve()
    proof = Path(os.environ["MOSS_RUNTIME_PROOF"]).resolve()
    port = int(os.environ["MOSS_PROOF_PORT"])
    if not 5180 <= port <= 5299:
        raise ValueError("Claim a task-owned devports port in 5180-5299")
    proof.mkdir(parents=True, exist_ok=False)
    root = proof / "root"
    root.mkdir()
    shutil.copytree(install, root / "moss")
    # Explicit target prerequisites: POSIX shell and the build-platform interpreter ABI.
    # Utilities only drive the proof; they are not supplied as Moss's runtime closure.
    for source, target in (("/bin/dash", "/bin/sh"), ("/bin/cat", "/bin/cat"),
                           ("/bin/mv", "/bin/mv"), ("/bin/chmod", "/bin/chmod")):
        copy_baseline(root, Path(source), target, install / "runtime/lib")
    (root / "etc").mkdir()
    (root / "etc/passwd").write_text("moss:x:1000:1000:Moss proof:/data:/bin/sh\n")
    (root / "etc/group").write_text("moss:x:1000:\n")
    (root / "etc/nsswitch.conf").write_text("passwd: files\ngroup: files\nhosts: files dns\n")
    (root / "etc/hosts").write_text("127.0.0.1 localhost\n")
    for name in ("data", "tmp"):
        (root / name).mkdir(mode=0o777)
        (root / name).chmod(0o1777)
    origin = f"https://127.0.0.1:{port}"
    config = {"listen": f"127.0.0.1:{port}", "origins": [origin], "sharing": False,
              "certificate": "/data/cert.pem", "private_key": "/data/key.pem",
              "credentials": "/data/credentials.json"}
    (root / "network.json").write_text(json.dumps(config))
    image = "moss-js146-proof-" + uuid.uuid4().hex[:10]
    container = image
    archive = proof / "root.tar"
    with tarfile.open(archive, "w") as tar:
        tar.add(root, arcname=".")
    processes = []
    image_created = False
    try:
        run(["docker", "import", str(archive), image])
        image_created = True
        run(["docker", "run", "-di", "--name", container, "--network", "none", "--user", "1000:1000",
             "--env", "HOME=/data", "--entrypoint", "/bin/sh", image, "-c", "while read line; do :; done"])

        def execute(*args, **kwargs):
            return run(["docker", "exec", "-i", container, *args], **kwargs)

        def shell(command):
            return execute("/bin/sh", "-c", command)

        inspect = json.loads(run(["docker", "inspect", container]))[0]
        assert inspect["Mounts"] == [], "proof must have no host mounts"
        assert inspect["HostConfig"]["NetworkMode"] == "none"
        print("PASS: scratch root, no host mounts, no external network, ordinary uid 1000", flush=True)

        shell("mv /moss/runtime/lib/libcrypto.so.3 /moss/runtime/lib/libcrypto.hidden")
        broken = subprocess.run(["docker", "exec", container, "/moss/moss-run", "openssl", "version"], capture_output=True, text=True)
        assert broken.returncode != 0 and "libcrypto.so.3" in broken.stderr
        print("PASS negative control: same OpenSSL command fails without bundled libcrypto.so.3", flush=True)
        shell("mv /moss/runtime/lib/libcrypto.hidden /moss/runtime/lib/libcrypto.so.3")
        print(execute("/moss/moss-run", "openssl", "version").strip(), flush=True)
        execute("/moss/moss-run", "openssl", "req", "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes", "-days", "1",
                "-subj", "/CN=Moss clean root", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", "/data/key.pem", "-out", "/data/cert.pem")
        shell("umask 077; cat /network.json > /data/network.json; chmod 600 /data/key.pem")
        execute("/moss/moss-run", "openssl", "crl2pkcs7", "-nocrl", "-certfile", "/moss/runtime/ssl/ca-certificates.crt", "-out", "/dev/null")
        print("PASS: real RSA certificate generation and bundled public CA parsing", flush=True)

        def start(command, log, pid):
            shell(f": >{log}")
            process = subprocess.Popen(["docker", "exec", container, "/bin/sh", "-c",
                                        f'{command} >{log} 2>&1 & child=$!; echo "$child" >{pid}; wait "$child"'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            processes.append(process)
            return process

        supervisor = start("/moss/moss-run moss-db up --root /data/database --pg /moss/postgres --repo /moss/schema", "/data/db.log", "/data/db.pid")
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if supervisor.poll() is not None:
                raise RuntimeError("Supervisor exited: " + shell("cat /data/db.log /data/database/logs/initdb.log /data/database/logs/postgres.log 2>/dev/null || true")[-3200:])
            if '"event":"ready"' in shell("cat /data/db.log").replace(" ", ""):
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Supervisor did not become ready")
        check = json.loads(execute("/moss/moss-run", "moss-db", "check", "--root", "/data/database", "--write", "runtime-closure"))
        assert check["app_database"]["vector_extension"]
        assert check["app_database"]["migrations_recorded"] > 0
        assert check["proof_database"]
        print("PASS: real initdb, schema migrations, pgvector and database write/read", flush=True)
        shell("umask 077; /moss/moss-run moss-db credentials --root /data/database > /data/credentials.json")
        start("/moss/moss-run moss-shell serve --network /data/network.json --web /moss/web", "/data/server.log", "/data/server.pid")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                response = execute("/moss/moss-run", "openssl", "s_client", "-quiet", "-verify_return_error", "-verify_ip", "127.0.0.1", "-CAfile", "/data/cert.pem", "-connect", f"127.0.0.1:{port}",
                                   input=f"GET /api/hello HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
                if "200 OK" in response:
                    assert json.loads(response.split("\n\n")[-1])["product"] == "moss"
                    break
            except RuntimeError:
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError("HTTPS hello failed: " + shell("cat /data/server.log")[-1600:])
        print("PASS: real moss-shell serves HTTPS hello with certificate verification", flush=True)
        shell('kill -TERM "$(cat /data/server.pid)"')
        execute("/moss/moss-run", "moss-db", "stop", "--root", "/data/database")
        for process in processes:
            assert process.wait(timeout=35) == 0
        print("PASS: orderly server and database Stop", flush=True)
        case = proof / "uninstall-case"
        shutil.copytree(install, case, symlinks=True, copy_function=os.link)
        (case / "servers/default").mkdir(parents=True)
        run(["docker", "cp", container + ":/data/database", str(case / "servers/default/database")])
        saved = tree_digest(case / "servers")
        assert saved and any(name.endswith("PG_VERSION") for name in saved)
        uninstall(case)
        assert tree_digest(case / "servers") == saved
        assert not (case / "moss-shell").exists()
        print("PASS: uninstall removes programs and preserves every byte of the real instance", flush=True)
        print("NOT PROVEN: native WebKit app, desktop resources, cross-distribution ABI, public OS trust, updates, signing, full This computer UI", flush=True)
    finally:
        subprocess.run(["docker", "rm", "-f", container], capture_output=True)
        for process in processes:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if image_created:
            subprocess.run(["docker", "image", "rm", image], capture_output=True)
        # Generated credentials, private keys and database files are not proof artifacts.
        shutil.rmtree(root)
        archive.unlink(missing_ok=True)
        shutil.rmtree(proof / "uninstall-case", ignore_errors=True)


if __name__ == "__main__":
    prove()
