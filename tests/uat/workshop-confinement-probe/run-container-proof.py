#!/usr/bin/env python3
"""Disposable confinement/build/browser experiments; not a production runtime."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid


def docker(*args, timeout=30, check=True, input_text=None):
    result = subprocess.run(
        ["docker", *args], check=False, timeout=timeout,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, input=input_text,
    )
    if check and result.returncode:
        raise RuntimeError(f"docker {args[0]} failed ({result.returncode}): {result.stderr[:2000]}")
    return result


def report(check, **detail):
    print(json.dumps({"check": check, **detail}), flush=True)


def process_identity(pid):
    try:
        # Ignore the parenthesized comm field: it can itself contain spaces.
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except FileNotFoundError:
        return None


def main():
    if not __debug__:
        raise RuntimeError("This proof requires Python assertions; do not use -O")
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt("Probe interrupted; cleaning up owned resources")

    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-image", required=True, help="Cached immutable sha256 image ID")
    parser.add_argument("--data-only", action="store_true",
                        help="Test local provider adapter -> stdin -> confined SDK worker build")
    parser.add_argument("--artifact-file", type=Path,
                        help="With --data-only, consume an externally generated source envelope")
    parser.add_argument("--web", action="store_true",
                        help="Compile worker, web entry and CSS from an external source envelope")
    parser.add_argument("--browser", action="store_true",
                        help="With --web, render/click in disposable offline Chromium")
    parser.add_argument("--control-plane", action="store_true",
                        help="Test a disposable fixed-operation host launcher and systemd teardown")
    args = parser.parse_args()
    if args.control_plane and (args.data_only or args.artifact_file or args.web or args.browser):
        parser.error("--control-plane is a separate lifecycle proof")
    if args.artifact_file and not args.data_only:
        parser.error("--artifact-file requires --data-only")
    if args.web and not (args.data_only and args.artifact_file):
        parser.error("--web requires --data-only and --artifact-file")
    if args.browser and not args.web:
        parser.error("--browser requires --web")
    paths = ["src/worker/index.ts"] + (["src/web/index.ts", "src/web/styles.css"] if args.web else [])
    external_payload = None
    if args.artifact_file:
        with os.fdopen(os.open(args.artifact_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as artifact:
            assert stat.S_ISREG(os.fstat(artifact.fileno()).st_mode)
            external_payload = artifact.read(16_385)
        assert len(external_payload) <= 16_384
        envelope = json.loads(external_payload)
        assert isinstance(envelope, dict) and set(envelope) == {"files"}
        assert isinstance(envelope["files"], list) and len(envelope["files"]) == len(paths)
        for entry, path in zip(envelope["files"], paths):
            assert isinstance(entry, dict) and set(entry) == {"path", "content"}
            assert entry["path"] == path and isinstance(entry["content"], str)
        external_payload = external_payload.decode("utf-8")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", args.source_image):
        parser.error("Use a full cached image ID, not a mutable tag")
    source = json.loads(docker("image", "inspect", args.source_image).stdout)[0]
    assert source["Id"] == args.source_image
    assert source["Architecture"] == "amd64", "This probe's minimal-library list is amd64 only"
    assert docker("info", "--format", "{{.CgroupVersion}}").stdout.strip() == "2"
    prefix = f"workshop-a0-{uuid.uuid4().hex[:12]}"
    tag = f"{prefix}:probe"
    containers = set()
    image_built = False
    profile = [
        "--pull", "never", "--network", "none", "--read-only", "--user", "1000:1000",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--memory", "512m" if args.browser else "192m",
        "--memory-swap", "512m" if args.browser else "192m",
        "--cpus", "0.5" if args.browser else "0.25",
        "--pids-limit", "128" if args.browser else "64",
        "--tmpfs", "/attempt:rw,noexec,nosuid,nodev,size=" +
        ("64m" if args.browser else "8m") + ",uid=1000,gid=1000,mode=0700",
        "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=1",
        "--log-opt", "compress=false",
    ]

    def inspect(name):
        return json.loads(docker("inspect", name).stdout)[0]

    def kill(name, reason):
        report("termination-intent", container=name, reason=reason)
        docker("kill", name)
        assert docker("wait", name, timeout=10).stdout.strip() == "137"
        assert not inspect(name)["State"]["Running"]

    with tempfile.TemporaryDirectory(prefix=f"{prefix}-") as directory:
        temporary = Path(directory)
        fixture = temporary / "fixtures"
        fixture.mkdir(mode=0o755)
        sentinel = fixture / "denied"
        sentinel.write_text("synthetic-private-sentinel")
        assert sentinel.read_text() == "synthetic-private-sentinel"
        sentinel.chmod(0)
        try:
            # Copy only Node and its runtime libraries from a stopped container. No app,
            # inherited environment, auth home, shell, package manager, or application volumes.
            name = f"{prefix}-source"
            containers.add(name)
            # This trusted inventory reads only the cached public browser installation.
            browser_inventory = r'''
const fs = require("fs"), cp = require("child_process");
const root = "/ms-playwright/" + fs.readdirSync("/ms-playwright").find(x => x.startsWith("chromium_headless_shell-"));
const dirs = [root, ...fs.readdirSync(root).map(x => root + "/" + x).filter(x => fs.statSync(x).isDirectory())];
const dir = dirs.find(x => ["headless_shell", "chrome-headless-shell"].some(name => fs.existsSync(x + "/" + name)));
if (!dir) throw new Error("Cached headless Chromium executable not found");
const executable = ["headless_shell", "chrome-headless-shell"].find(name => fs.existsSync(dir + "/" + name));
const output = cp.execFileSync("/usr/bin/ldd", [dir + "/" + executable], {encoding:"utf8"});
if (output.includes("not found")) throw new Error("Missing browser library");
const libs = [...new Set([...output.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm)].map(x => x[1]))];
console.log(JSON.stringify({dir, executable, libs}));
'''
            command = ["-e", browser_inventory] if args.browser else ["--version"]
            docker("create", "--name", name, *profile, "--entrypoint", "/usr/local/bin/node",
                   args.source_image, *command)
            browser = None
            if args.browser:
                browser = json.loads(docker("start", "-a", name).stdout)
                assert browser["dir"].startswith("/ms-playwright/chromium_headless_shell-")
                assert browser["executable"] in ["headless_shell", "chrome-headless-shell"]
                assert browser["libs"] and all(re.fullmatch(
                    r"/(?:lib|usr/lib|lib64)/[A-Za-z0-9_./+-]+", lib) for lib in browser["libs"])
            paths = ["/usr/local/bin/node", "/lib64/ld-linux-x86-64.so.2"] + [
                f"/lib/x86_64-linux-gnu/{lib}" for lib in
                ["libdl.so.2", "libstdc++.so.6", "libm.so.6", "libgcc_s.so.1",
                 "libpthread.so.0", "libc.so.6"]
            ]
            if browser:
                paths = list(dict.fromkeys(paths + browser["libs"]))
            for path in paths:
                destination = temporary / "root" / path.lstrip("/")
                destination.parent.mkdir(parents=True, exist_ok=True)
                docker("cp", "-L", f"{name}:{path}", str(destination))
            shutil.copyfile(Path(__file__).with_name("container-cases.mjs"),
                            temporary / "root/probe.mjs")
            if args.data_only:
                # Match the installed pinned source image's esbuild. Only public SDK sources
                # enter the tool image; no app source or source image environment is copied.
                (temporary / "root/opt").mkdir()
                docker("cp", "-L", f"{name}:/app/node_modules/.pnpm/@esbuild+linux-x64@0.25.12/"
                       "node_modules/@esbuild/linux-x64/bin/esbuild", str(temporary / "root/opt/esbuild"))
                docker("cp", f"{name}:/app/packages/module-sdk/src", str(temporary / "root/opt/module-sdk"))
                if args.web:
                    for package in ["module-web-sdk", "ui"]:
                        docker("cp", f"{name}:/app/packages/{package}/src",
                               str(temporary / f"root/opt/{package}"))
                    docker("cp", f"{name}:/app/node_modules/.pnpm/lucide-react@0.468.0_react@19.2.7/"
                           "node_modules/lucide-react", str(temporary / "root/opt/lucide-react"))
                    shutil.copyfile(Path(__file__).with_name("web-bundle-case.mjs"),
                                    temporary / "root/web-bundle-case.mjs")
                    if browser:
                        docker("cp", f"{name}:{browser['dir']}", str(temporary / "root/opt/chromium"))
                        if browser["executable"] != "headless_shell":
                            (temporary / "root/opt/chromium" / browser["executable"]).rename(
                                temporary / "root/opt/chromium/headless_shell")
                        docker("cp", f"{name}:/usr/share/fonts/truetype/liberation",
                               str(temporary / "root/opt/fonts"))
                        (temporary / "root/etc/fonts").mkdir(parents=True)
                        (temporary / "root/etc/fonts/fonts.conf").write_text(
                            '<fontconfig><dir>/opt/fonts</dir>'
                            '<cachedir>/attempt/font-cache</cachedir></fontconfig>')
                        for package, version in [("playwright-core", "1.60.0"), ("react", "19.2.7"),
                                                 ("react-dom", "19.2.7_react@19.2.7"),
                                                 ("scheduler", "0.27.0")]:
                            docker("cp", f"{name}:/app/node_modules/.pnpm/{package}@{version}/"
                                   f"node_modules/{package}", str(temporary / f"root/opt/{package}"))
                        shutil.copyfile(Path(__file__).with_name("browser-render-case.mjs"),
                                        temporary / "root/browser-render-case.mjs")
            (temporary / "Dockerfile").write_text(
                'FROM scratch\nCOPY root/ /\nUSER 1000:1000\n'
                'ENTRYPOINT ["/usr/local/bin/node", "/probe.mjs"]\n'
            )
            # Keep even the synthetic denied fixture out of the build context.
            (temporary / ".dockerignore").write_text("fixtures\n")
            image_built = True
            docker("build", "--network", "none", "--pull=false", "--tag", tag,
                   str(temporary), timeout=60)
            image = json.loads(docker("image", "inspect", tag).stdout)[0]
            assert all(value.startswith("PATH=") for value in image["Config"].get("Env") or [])
            assert not image["Config"].get("Volumes")
            report("candidate-image", image=image["Id"], source=source["Id"])

            if args.control_plane:
                control = runpy.run_path(str(Path(__file__).with_name("control-plane-proof.py")))
                control["run_proof"](image["Id"], prefix, profile, temporary, containers,
                                     docker, report, process_identity)
                return

            def start(case):
                name = f"{prefix}-{case}"
                containers.add(name)
                docker("run", "-d", "--name", name, *profile,
                       "--mount", f"type=bind,src={fixture},dst=/fixtures,readonly",
                       image["Id"], case)
                metadata = inspect(name)
                host = metadata["HostConfig"]
                assert host["ReadonlyRootfs"] and host["NetworkMode"] == "none"
                assert host["CapDrop"] == ["ALL"] and not host["Privileged"]
                assert metadata["Config"]["User"] == "1000:1000"
                mounts = metadata["Mounts"]
                binds = [mount for mount in mounts if mount["Type"] == "bind"]
                assert len(binds) == 1 and binds[0]["Source"] == str(fixture)
                assert binds[0]["Destination"] == "/fixtures" and not binds[0]["RW"]
                assert all(mount in binds or (mount["Type"] == "tmpfs" and
                           mount["Destination"] == "/attempt") for mount in mounts)
                assert set(host["Tmpfs"]) == {"/attempt"}
                report("container-profile", container=name, image=metadata["Image"],
                       readonly=True, network="none", uid="1000:1000", memory=host["Memory"],
                       swap=host["MemorySwap"], cpus=host["NanoCpus"], pids=host["PidsLimit"],
                       capabilities=host["CapDrop"], security=host["SecurityOpt"])
                return name

            def execute(name, *case):
                result = docker("exec", name, "/usr/local/bin/node", "/probe.mjs", *case)
                if result.stdout:
                    print(result.stdout, end="", flush=True)

            def successful(case):
                name = start(case)
                code = docker("wait", name, timeout=15).stdout.strip()
                logs = docker("logs", name)
                print(logs.stdout, end="", flush=True)
                assert code == "0", f"{case} exited {code}: {logs.stderr[:2000]}"

            successful("baseline-browser" if args.browser else "baseline")
            if args.data_only:
                if external_payload is not None:
                    payload = external_payload
                    report("external-source-artifact-handoff", status="pass")
                else:
                    envelope = temporary / "generation.json"
                    generator = Path(__file__).with_name("data-only-provider-proof.ts")
                    generated = subprocess.run(["node", "--import", "tsx", str(generator), str(envelope)],
                                               timeout=45, check=True, capture_output=True, text=True)
                    print(generated.stdout, end="", flush=True)
                    assert envelope.stat().st_size <= 16_384
                    payload = envelope.read_text()
                sandbox = start("idle")
                build_case = ("module-browser-build" if args.browser else
                              "module-web-build" if args.web else "module-build")
                result = docker("exec", "-i", sandbox, "/usr/local/bin/node", "/probe.mjs",
                                build_case, input_text=payload, timeout=60 if args.browser else 30)
                print(result.stdout, end="", flush=True)
                if args.browser:
                    # Docker's archive copier cannot see this workspace tmpfs on this host.
                    # Read a bounded regular file through the running container, not its layer.
                    captured = docker("exec", sandbox, "/usr/local/bin/node", "-e", r'''
const fs = require("fs"), assert = require("assert");
const fd = fs.openSync("/attempt/module/web-proof.png", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
assert(fs.fstatSync(fd).isFile());
const bytes = Buffer.alloc(1048577);
const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
assert(count <= 1048576);
fs.closeSync(fd);
process.stdout.write(bytes.subarray(0, count).toString("base64"));
''')
                    screenshot = base64.b64decode(captured.stdout, validate=True)
                    assert screenshot.startswith(b"\x89PNG\r\n\x1a\n")
                    rendered = [json.loads(line) for line in result.stdout.splitlines()
                                if json.loads(line).get("check") == "browser-render-and-click"]
                    assert len(rendered) == 1
                    assert hashlib.sha256(screenshot).hexdigest() == rendered[0]["screenshotSha256"]
                    saved = Path(tempfile.gettempdir()) / f"{prefix}-web-proof.png"
                    saved.write_bytes(screenshot)
                    report("browser-screenshot-export", path=str(saved),
                           sha256=hashlib.sha256(screenshot).hexdigest())
                attack = json.loads(payload)
                attack["files"][0]["path"] = "../escape.ts"
                denied = docker("exec", "-i", sandbox, "/usr/local/bin/node", "/probe.mjs",
                                build_case, input_text=json.dumps(attack), check=False)
                assert denied.returncode != 0 and "Unexpected source artifact" in denied.stderr
                report("stdin-path-traversal-denied", status="pass")
                attack["files"][0]["path"] = "src/worker/index.ts"
                attack["files"][0]["content"] = 'import "/fixtures/denied";'
                denied = docker("exec", "-i", sandbox, "/usr/local/bin/node", "/probe.mjs",
                                build_case, input_text=json.dumps(attack), check=False)
                assert denied.returncode != 0 and "permission denied" in denied.stderr.lower()
                report("compiler-denied-existing-private-sentinel", status="pass")
                report("production-integration" if args.browser else
                       "browser-rendering-and-production-integration" if args.web else
                       "web-build-and-production-integration", status="unproved")
                if external_payload is None:
                    report("authenticated-provider", status="unproved")
                return
            peer = start("peer")
            execute(peer, "ready", "/attempt/peer-only")
            successful("second")
            execute(peer, "peer-check")

            tree = start("tree")
            execute(tree, "ready", "/attempt/tree-ready")
            pids = docker("top", tree, "-eo", "pid").stdout.splitlines()[1:]
            identities = {int(pid): process_identity(int(pid)) for pid in pids}
            assert len(identities) >= 3 and all(identities.values())
            kill(tree, "explicit cancellation of detached descendant tree")
            assert all(process_identity(pid) != identity for pid, identity in identities.items())
            report("descendant-cancellation", status="pass", processes=len(identities))

            oom = start("oom")
            assert docker("wait", oom, timeout=15).stdout.strip() == "137"
            assert inspect(oom)["State"]["OOMKilled"]
            report("memory-termination", status="pass")
            execute(peer, "peer-check")

            pids = start("pids")
            time.sleep(2)
            # Read the host-visible cgroup path, without trying
            # to exec another process into an intentionally full PID cgroup.
            host_pid = inspect(pids)["State"]["Pid"]
            cgroup = Path(f"/proc/{host_pid}/cgroup").read_text().strip().split("::", 1)[1]
            events = Path("/sys/fs/cgroup", cgroup.lstrip("/"), "pids.events").read_text()
            assert int(dict(line.split() for line in events.splitlines())["max"]) > 0
            kill(pids, "PID ceiling reached; terminate spawning loop")
            report("pid-ceiling-and-termination", status="pass")

            cpu = start("cpu")
            try:
                docker("wait", cpu, timeout=3)
                raise AssertionError("CPU runaway unexpectedly exited")
            except subprocess.TimeoutExpired:
                execute(cpu, "cpu-check")
                kill(cpu, "three-second wall-clock deadline")
            report("cpu-throttling-and-deadline-termination", status="pass")

            output = start("output")
            follower = subprocess.Popen(["docker", "logs", "-f", output],
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            try:
                total = 0
                with selectors.DefaultSelector() as selector:
                    selector.register(follower.stdout, selectors.EVENT_READ)
                    while total <= 4096:
                        assert selector.select(timeout=5), "No output; ceiling not exercised"
                        chunk = os.read(follower.stdout.fileno(), 1024)
                        assert chunk, "Output ended before ceiling"
                        total += len(chunk)
                kill(output, "4096-byte captured-output ceiling")
                report("control-side-output-cutoff", status="pass", observed_bytes=total)
            finally:
                follower.terminate()
                follower.wait(timeout=10)
                follower.stdout.close()
            execute(peer, "peer-check")
            report("provider-toolchain-and-production-integration", status="unproved")
        finally:
            if sys.exc_info()[0] is not None:
                for name in sorted(containers):
                    try:
                        state = inspect(name)["State"]
                        report("failure-state", container=name, running=state["Running"],
                               oom=state["OOMKilled"], exit_code=state["ExitCode"])
                        logs = docker("logs", "--tail", "8", name, check=False)
                        report("failure-log", container=name, detail=(logs.stdout + logs.stderr)[-2000:])
                    except Exception as error:
                        report("failure-inspection", container=name, detail=str(error)[:500])
            cleanup_errors = []
            for name in sorted(containers):
                try:
                    docker("rm", "-f", name, check=False)
                    assert docker("inspect", name, check=False).returncode != 0
                except Exception as error:
                    cleanup_errors.append(f"{name}: {error}")
            if image_built:
                try:
                    docker("image", "rm", tag, check=False)
                    assert docker("image", "inspect", tag, check=False).returncode != 0
                except Exception as error:
                    cleanup_errors.append(f"{tag}: {error}")
            sentinel.chmod(0o600)
            assert sentinel.read_text() == "synthetic-private-sentinel"
            assert not cleanup_errors, cleanup_errors
            assert not docker("ps", "-a", "--filter", f"name={prefix}",
                              "--format", "{{.Names}}").stdout.strip()
            assert not docker("image", "ls", "--filter", f"reference={tag}",
                              "--format", "{{.ID}}").stdout.strip()
            report("cleanup-and-sentinel-integrity", status="pass", containers=len(containers))


if __name__ == "__main__":
    main()
