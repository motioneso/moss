#!/usr/bin/env python3
"""Exercise local setup in the real native app; inspect the captured UI evidence.

Run test:rust-linux-creation through scripts/run-gate.sh with MOSS_CLEAN_INSTALL
and a new MOSS_DESKTOP_PROOF directory. Reuses the scratch-root desktop proof.
No host port is exposed; the app selects its normal port inside the isolated root.
"""
import json
import secrets
import time
from urllib.parse import urlsplit

from proof_linux_desktop import prove
from proof_linux_runtime import run


INSTANCE = "/data/moss/servers/default"


def wait_for(check, description, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.5)
    raise RuntimeError("Timed out: " + description)


def exercise(execute, shell, image, window, proof):
    assert shell('[ ! -e /data/moss/servers ] && echo fresh').strip() == "fresh"

    def keys(*args):
        execute("xdotool", "windowfocus", window)
        execute("xdotool", *args)

    def click(x, y):
        keys("mousemove", str(x), str(y))
        time.sleep(0.2)
        keys("click", "1")

    def type_text(value):
        # Ephemeral test password goes via stdin, never into command arguments or logs.
        execute("xdotool", "type", "--clearmodifiers", "--file", "-", input=value)

    def capture(name, crop="900:650:100:70"):
        time.sleep(2)
        execute("xwd", "-root", "-silent", "-out", "/data/screen.xwd")
        run(["docker", "cp", image + ":/data/screen.xwd", str(proof / "screen.xwd")])
        run(["ffmpeg", "-y", "-i", str(proof / "screen.xwd"), "-vf", "crop=" + crop,
             "-frames:v", "1", str(proof / (name + ".png"))])

    click(450, 390)  # First-run This computer, at the fixture's fixed 1100x780 size.
    wait_for(lambda: shell(f'[ -f {INSTANCE}/running.json ] && echo ready || true').strip() == "ready",
             "the app to provision and start its local server", 210)
    running = json.loads(execute("/bin/cat", INSTANCE + "/running.json"))
    network = json.loads(execute("/bin/cat", INSTANCE + "/network.json"))
    assert not network["sharing"]
    origin = urlsplit(running["origin"])
    assert origin.scheme == "https" and origin.hostname in ("localhost", "127.0.0.1")
    endpoint = origin.netloc

    def get(path):
        response = execute("/moss/moss-run", "openssl", "s_client", "-quiet",
                           "-verify_return_error", "-verify_ip", "127.0.0.1",
                           "-CAfile", INSTANCE + "/tls/certificate.pem", "-connect", f"127.0.0.1:{origin.port}",
                           input=f"GET {path} HTTP/1.1\r\nHost: {endpoint}\r\nConnection: close\r\n\r\n")
        assert "200 OK" in response
        return json.loads(response.split("\n\n", 1)[1])

    assert get("/api/hello")["product"] == "moss"
    assert get("/api/setup/status")["complete"] is False
    ready = json.loads(execute("/bin/cat", INSTANCE + "/database.log"))
    assert ready["event"] == "ready" and ready["created_cluster"]
    assert ready["migrations"]["applied"] > 0
    (proof / "provision.json").write_text(json.dumps(ready, indent=2) + "\n")
    capture("sign-in-first")
    print("PASS: This computer created a fresh database and real HTTPS server, sharing off", flush=True)

    # Use the real form's tab order; pointer link activation is unreliable without
    # a window manager in this minimal X11 fixture.
    keys("key", "--repeat", "4", "--repeat-delay", "100", "Tab")
    keys("key", "Return")
    capture("owner-form")
    password = secrets.token_urlsafe(24)
    keys("key", "Tab")
    type_text("Linux Proof")
    keys("key", "Tab")
    type_text("linux-proof@example.invalid")
    keys("key", "Tab")
    type_text(password)
    keys("key", "Tab", "Return")
    wait_for(lambda: get("/api/setup/status")["complete"], "owner creation through the native form")
    capture("sharing")
    print("PASS: owner created through the native form; setup status is now complete", flush=True)

    # Sharing's tab order: checkbox, certificate download, save, Today, Sign out.
    keys("key", "--repeat", "5", "--repeat-delay", "100", "Tab")
    capture("sign-out-button")
    keys("key", "Return")
    capture("signed-out")
    keys("key", "Tab")  # Email in the returning sign-in form (no setup link).
    type_text("linux-proof@example.invalid")
    keys("key", "Tab")
    type_text(password)
    keys("key", "Tab", "Return")
    password = None
    time.sleep(3)
    capture("today")
    capture("account", "210:780:0:0")
    check = json.loads(execute("/moss/moss-run", "moss-db", "check", "--root", INSTANCE + "/database"))
    assert check["app_database"]["vector_extension"]
    assert check["app_database"]["migrations_recorded"] > 0
    (proof / "database-check.json").write_text(json.dumps(check, indent=2) + "\n")
    (proof / "server.log").write_text(execute("/bin/cat", INSTANCE + "/server.log"))
    print("CAPTURED: sign-out, returning sign-in, Today and account; inspect PNGs to confirm UI outcomes", flush=True)
    print("NOT PROVEN: automatic semantic UI assertions, real Today content, second device, desktop login, hardware graphics, Windows, reminders", flush=True)


if __name__ == "__main__":
    prove(exercise)
