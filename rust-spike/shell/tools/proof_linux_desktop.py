#!/usr/bin/env python3
"""Clean-root native startup proof; no database or host mounts.

MOSS_CLEAN_INSTALL selects a --linux-desktop-runtime stage. MOSS_DESKTOP_PROOF
selects a new output directory. Requires Docker, Xvfb, X11 tools, D-Bus and ffmpeg
on the build host. These supply an explicit test desktop, not Moss dependencies.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time
import uuid

from proof_linux_runtime import copy_baseline, run


def prove():
    install = Path(os.environ["MOSS_CLEAN_INSTALL"]).resolve()
    proof = Path(os.environ["MOSS_DESKTOP_PROOF"]).resolve()
    closure = json.loads((install / "runtime/closure.json").read_text())
    if closure["scope"] != "linux-desktop-root":
        raise ValueError("Stage with --linux-desktop-runtime first")
    proof.mkdir(parents=True, exist_ok=False)
    root = proof / "root"
    root.mkdir()
    image = "moss-desktop-proof-" + uuid.uuid4().hex[:10]
    archive = proof / "root.tar"
    created = False
    try:
        shutil.copytree(install, root / "moss")
        shutil.copytree(install / "runtime/rootfs", root, dirs_exist_ok=True)
        for source, target in (
            ("/bin/dash", "/bin/sh"), ("/bin/cat", "/bin/cat"),
            ("/bin/mv", "/bin/mv"), ("/usr/bin/Xvfb", "/usr/bin/Xvfb"),
            ("/usr/bin/xdotool", "/usr/bin/xdotool"), ("/usr/bin/xwd", "/usr/bin/xwd"),
            ("/usr/bin/xkbcomp", "/usr/bin/xkbcomp"),
            ("/usr/bin/dbus-daemon", "/usr/bin/dbus-daemon"),
        ):
            copy_baseline(root, Path(source), target, install / "runtime/lib")
        shutil.copytree("/usr/share/X11/xkb", root / "usr/share/X11/xkb")
        (root / "etc").mkdir(exist_ok=True)
        (root / "etc/passwd").write_text("moss:x:1000:1000:Moss proof:/data:/bin/sh\n")
        (root / "etc/group").write_text("moss:x:1000:\n")
        (root / "etc/nsswitch.conf").write_text("passwd: files\ngroup: files\nhosts: files dns\n")
        (root / "etc/hosts").write_text("127.0.0.1 localhost\n")
        (root / "etc/machine-id").write_text(uuid.uuid4().hex + "\n")
        for name in ("data", "tmp"):
            (root / name).mkdir(mode=0o777)
            (root / name).chmod(0o1777)
        (root / "session.conf").write_text(
            '<busconfig><type>session</type><listen>unix:path=/tmp/bus</listen>'
            '<auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/>'
            '<allow receive_sender="*"/><allow own="*"/></policy></busconfig>')
        with tarfile.open(archive, "w") as tar:
            tar.add(root, arcname=".")
        run(["docker", "import", str(archive), image])
        created = True
        run(["docker", "run", "-di", "--name", image, "--network", "none", "--user", "1000:1000",
             "--env", "HOME=/data", "--env", "DISPLAY=:99",
             "--env", "DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/bus",
             "--env", "GTK_USE_PORTAL=0", "--env", "NO_AT_BRIDGE=1",
             "--env", "LIBGL_ALWAYS_SOFTWARE=1",
             "--env", "WEBKIT_DISABLE_COMPOSITING_MODE=1",
             "--entrypoint", "/bin/sh", image, "-c", "while read line; do :; done"])

        def execute(*args):
            return run(["docker", "exec", image, *args])

        def shell(command):
            return execute("/bin/sh", "-c", command)

        inspect = json.loads(run(["docker", "inspect", image]))[0]
        assert inspect["Mounts"] == []
        assert inspect["HostConfig"]["NetworkMode"] == "none"
        print("PASS: scratch root, no host mounts or network, ordinary uid 1000", flush=True)
        run(["docker", "exec", "-d", image, "/bin/sh", "-c",
             "Xvfb :99 -screen 0 1100x780x24 -nolisten tcp >/data/xvfb.log 2>&1 & "
             "dbus-daemon --config-file=/session.conf --nofork >/data/dbus.log 2>&1 & wait"])
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if shell('[ -S /tmp/.X11-unix/X99 ] && [ -S /tmp/bus ] && echo ready || true').strip() == "ready":
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("Test desktop did not start")
        # A negative control uses the same real native startup command, not a stand-in.
        helper = next(path for path in closure["target_root_files"] if path.endswith("/WebKitWebProcess"))
        execute("/bin/mv", helper, helper + ".hidden")
        command = ["docker", "exec", image, "/moss/moss-run", "moss-app",
                   "--data", "/data/moss", "--install", "/moss"]
        try:
            before = subprocess.run(command, capture_output=True, text=True, timeout=20)
        except subprocess.TimeoutExpired as error:
            (proof / "before.log").write_bytes(error.stderr or b"")
            raise
        (proof / "before.log").write_text(before.stderr)
        assert before.returncode != 0 and (
            "WebKitWebProcess" in before.stderr or "runtime/rootfs payload" in before.stderr)
        print("PASS negative control: native launch fails without its WebKit helper", flush=True)
        execute("/bin/mv", helper + ".hidden", helper)
        run(["docker", "exec", "-d", image, "/bin/sh", "-c",
             '/moss/moss-run moss-app --data /data/moss --install /moss >/data/app.log 2>&1 & '
             'echo "$!" >/data/app.pid; wait'])
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            windows = shell('xdotool search --onlyvisible --pid "$(cat /data/app.pid)" || true').splitlines()
            helpers = shell('for file in /proc/[0-9]*/comm; do read name < "$file"; '
                            'case "$name" in WebKitWebProces) echo ready ;; esac; done')
            if windows and "ready" in helpers:
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("Native startup failed: " + shell("cat /data/app.log")[-1600:])
        window = windows[-1]
        execute("xdotool", "windowsize", window, "1100", "780", "windowmove", window, "0", "0")
        # Allow the first real page paint; the screenshot is evidence to inspect, not a DOM assertion.
        time.sleep(2)
        execute("xwd", "-root", "-silent", "-out", "/data/native.xwd")
        run(["docker", "cp", image + ":/data/native.xwd", str(proof / "native.xwd")])
        run(["ffmpeg", "-y", "-i", str(proof / "native.xwd"), "-vf", "crop=900:650:100:70",
             "-frames:v", "1", str(proof / "native.png")])
        (proof / "after.log").write_text(shell("cat /data/app.log"))
        print("PASS: native window and real WebKit web process; inspect native.png for first-run UI", flush=True)
        print("NOT PROVEN: desktop login manager, This computer creation, hardware rendering, media, second device, installers, signing", flush=True)
    finally:
        if created:
            for name in ("dbus", "xvfb", "app"):
                subprocess.run(["docker", "cp", image + f":/data/{name}.log",
                                str(proof / f"{name}.log")], capture_output=True)
            subprocess.run(["docker", "rm", "-f", image], capture_output=True)
            subprocess.run(["docker", "image", "rm", image], capture_output=True)
        shutil.rmtree(root)
        archive.unlink(missing_ok=True)


if __name__ == "__main__":
    prove()
