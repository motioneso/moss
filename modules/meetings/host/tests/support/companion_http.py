"""Pair after reinstall through the real HTTPS server, with a synthetic browser session."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import urllib.error

data = json.load(sys.stdin)
target = Path(os.environ.get("CARGO_TARGET_DIR", "/tmp/moss-meetings-host")) / "debug"
port = subprocess.check_output(["devports", "claim", "js353-device-reinstall"], text=True).strip()
server = None
try:
    assert port.isdigit(), "claimed a development port"
    origin = f"https://localhost:{port}"
    with tempfile.TemporaryDirectory(prefix="js353-http-") as folder:
        root = Path(folder)
        subprocess.run([str(target / "moss-network"), "local-certificate", str(root / "tls"), origin], check=True, stdout=subprocess.DEVNULL)
        secret = "disposable-device-reinstall-session-signing-key"

        def private(name, value):
            with os.fdopen(os.open(root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as f:
                json.dump(value, f)

        private("credentials.json", {"app_url": os.environ["JS48_APP_URL"], "auth_url": os.environ["JS48_AUTH_URL"], "auth_secret": secret, "connector_key": "ab" * 32})
        private("network.json", {"listen": f"127.0.0.1:{port}", "origins": [origin], "certificate": str(root / "tls/certificate.pem"), "private_key": str(root / "tls/key.pem"), "credentials": str(root / "credentials.json")})
        private("modules.json", {"data": data["modules"], "admin_user_id": data["owner"], "migrations_url": os.environ["JS48_BOOTSTRAP_URL"], "producer_url": os.environ["JS48_APP_URL"], "worker_url": os.environ["JS48_WORKER_URL"], "connector_key": "ab" * 32})
        context = ssl.create_default_context(cafile=str(root / "tls/certificate.pem"))
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
        with open(root / "server.log", "w") as log:
            server = subprocess.Popen([str(target / "moss-shell"), "--network", str(root / "network.json"), "--modules", str(root / "modules.json")], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log)
            deadline = time.monotonic() + 60
            while True:
                assert server.poll() is None, "server exited before health"
                assert time.monotonic() < deadline, "server health deadline"
                try:
                    with opener.open(origin + "/api/hello", timeout=2) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.1)

            def post(path, body, cookie=None):
                headers = {"Content-Type": "application/json", "Origin": origin}
                if cookie:
                    headers["Cookie"] = cookie
                request = urllib.request.Request(origin + path, json.dumps(body).encode(), headers)
                with opener.open(request, timeout=30) as response:
                    assert response.status == 200, path
                    return json.load(response)

            signature = base64.b64encode(hmac.new(secret.encode(), data["session"].encode(), hashlib.sha256).digest()).decode()
            cookie = "better-auth.session_token=" + urllib.parse.quote(data["session"] + "." + signature, safe="")
            verifier = "fresh-reinstall-verifier"
            verifier_hash = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
            deadline = time.monotonic() + float(os.environ.get("JS353_PAIR_TIMEOUT", "180"))
            while True:
                try:
                    created = post("/api/companion/pair", {"deviceName": "Reinstalled Mac", "platform": "macos", "appVersion": "1", "osVersion": "14", "verifierHash": verifier_hash})
                    break
                except urllib.error.HTTPError as error:
                    if error.code != 503 or time.monotonic() >= deadline:
                        raise
                    time.sleep(0.2)
            code = urllib.parse.parse_qs(urllib.parse.urlparse(created["approvalPath"]).fragment)["code"][0]
            assert post("/api/companion/pair/decide", {"code": code, "decision": "approve"}, cookie)["status"] == "approved"
            issued = post("/api/companion/pair/redeem", {"attemptId": created["attemptId"], "verifier": verifier})
            assert issued["status"] == "issued"
            print(issued["device"]["id"])
            server.terminate()
            try:
                server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
            server = None
finally:
    if server is not None:
        server.kill()
        server.wait()
    subprocess.run(["devports", "release", port], stdout=subprocess.DEVNULL, check=False)
