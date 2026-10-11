#!/usr/bin/env python3
"""Synthetic nginx transport regression, not live audio/provider acceptance.

Run on Linux with Docker: python3 scripts/test-meeting-capture-proxy.py
Only the proxy listen/upstream addresses and observable temp directory are changed.
The production location blocks run in the static-web Dockerfile's nginx image.
No database, credentials, recorded audio, or third-party provider is involved.
"""

import contextlib
import ctypes
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import time
import uuid


ROOT = Path(__file__).resolve().parent.parent
CAP = 5_200_000
AUDIO_PATH = "/api/meetings/capture/audio?transport=synthetic"
CHUNK = 65_536


class Upstream(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    received = threading.Event()

    def log_message(self, *_args):
        pass

    def respond(self, data):
        payload = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.respond({"path": self.path})

    def body_chunks(self):
        chunked = self.headers.get("Transfer-Encoding", "").lower() == "chunked"
        remaining = int(self.headers.get("Content-Length", "0"))
        while True:
            if chunked:
                line = self.rfile.readline()
                if not line:
                    return
                remaining = int(line.split(b";", 1)[0], 16)
                if remaining == 0:
                    self.rfile.readline()
                    return
            elif remaining == 0:
                return
            while remaining:
                data = self.rfile.read1(min(CHUNK, remaining))
                if not data:
                    return
                remaining -= len(data)
                yield data
            if chunked:
                assert self.rfile.read(2) == b"\r\n"

    def do_POST(self):
        digest = hashlib.sha256()
        size = 0
        for chunk in self.body_chunks():
            size += len(chunk)
            digest.update(chunk)
            self.received.set()
            # Exercise backpressure without storing the body on disk.
            time.sleep(0.001)
        self.respond({
            "size": size,
            "sha256": digest.hexdigest(),
            "path": self.path,
            "http": self.request_version,
        })


class Server(http.server.ThreadingHTTPServer):
    def handle_error(self, *_args):
        # Rejected/aborted uploads deliberately close the upstream connection.
        pass


class TempFileWatch:
    """inotify retains creation events even if nginx immediately unlinks a file."""

    def __init__(self, directory):
        libc = ctypes.CDLL(None, use_errno=True)
        self.fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if self.fd < 0:
            raise OSError(ctypes.get_errno(), "inotify_init1")
        if libc.inotify_add_watch(self.fd, os.fsencode(directory), 0x100 | 0x80) < 0:
            os.close(self.fd)
            raise OSError(ctypes.get_errno(), "inotify_add_watch")

    def created(self):
        try:
            return bool(os.read(self.fd, 65_536))
        except BlockingIOError:
            return False

    def close(self):
        os.close(self.fd)


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def unused_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def connection(port):
    return http.client.HTTPConnection("127.0.0.1", port, timeout=15)


def begin_upload(port, chunked, size, path=AUDIO_PATH):
    client = connection(port)
    client.putrequest("POST", path)
    client.putheader("Content-Type", "application/json")
    client.putheader("Connection", "close")
    client.putheader("Transfer-Encoding" if chunked else "Content-Length",
                     "chunked" if chunked else str(size))
    client.endheaders()
    return client


def send_chunk(client, data, chunked):
    if chunked:
        client.send(f"{len(data):x}\r\n".encode() + data + b"\r\n")
    else:
        client.send(data)


def upload(port, body, chunked, require_streaming=True):
    Upstream.received.clear()
    with contextlib.closing(begin_upload(port, chunked, len(body))) as client:
        send_chunk(client, body[:CHUNK], chunked)
        if require_streaming:
            assert Upstream.received.wait(5), "upstream did not receive bytes before upload completed"
        for offset in range(CHUNK, len(body), CHUNK):
            send_chunk(client, body[offset:offset + CHUNK], chunked)
        if chunked:
            client.send(b"0\r\n\r\n")
        response = client.getresponse()
        assert response.status == 200, f"valid upload rejected: {response.status}"
        result = json.loads(response.read())
        assert result["size"] == len(body), result
        assert result["sha256"] == hashlib.sha256(body).hexdigest(), "body changed in transit"
        assert result["path"] == AUDIO_PATH, result
        if require_streaming:
            assert result["http"] == "HTTP/1.1", result


def rejects_oversize(port, body, chunked, path=AUDIO_PATH):
    with contextlib.closing(begin_upload(port, chunked, len(body) + 1, path)) as client:
        if chunked:
            # Declaring the final chunk exceeds the limit; rejection can close the
            # connection before the client finishes sending that chunk/terminator.
            try:
                for offset in range(0, len(body), CHUNK):
                    send_chunk(client, body[offset:offset + CHUNK], True)
                send_chunk(client, b" ", True)
                client.send(b"0\r\n\r\n")
            except (BrokenPipeError, ConnectionResetError):
                pass
        response = client.getresponse()
        assert response.status == 413, f"oversized upload returned {response.status}"
        response.read()


@contextlib.contextmanager
def proxy(config, image, upstream_port):
    port = unused_port()
    name = f"moss-meeting-proxy-{uuid.uuid4().hex[:12]}"
    with tempfile.TemporaryDirectory(prefix="moss-meeting-proxy-") as temporary:
        directory = Path(temporary)
        body_dir = directory / "body"
        body_dir.mkdir(mode=0o777)
        body_dir.chmod(0o777)
        # Adapt addresses only; exercise every production location unchanged.
        config = config.replace("listen 80;", f"listen {port};", 1)
        config = config.replace("set $api_upstream http://api:3000;",
                                f"set $api_upstream http://127.0.0.1:{upstream_port};", 1)
        config = config.replace("server_name _;", "server_name _;\n"
                                "    client_body_temp_path /var/cache/nginx/client_temp;", 1)
        conf = directory / "default.conf"
        conf.write_text(config)
        watch = TempFileWatch(body_dir)
        try:
            docker("run", "--detach", "--rm", "--name", name, "--network", "host",
                   "--mount", f"type=bind,src={conf},dst=/etc/nginx/conf.d/default.conf,readonly",
                   "--mount", f"type=bind,src={body_dir},dst=/var/cache/nginx/client_temp",
                   image)
            docker("exec", name, "nginx", "-t")
            for attempt in range(50):
                try:
                    with contextlib.closing(connection(port)) as client:
                        client.request("GET", "/health")
                        response = client.getresponse()
                        assert response.status == 200
                        response.read()
                    break
                except (OSError, http.client.HTTPException):
                    if attempt == 49:
                        raise
                    time.sleep(0.1)
            yield port, watch
        finally:
            subprocess.run(["docker", "rm", "--force", name], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            watch.close()


def main():
    source = (ROOT / "infra/nginx/jarv1s-web.conf").read_text()
    image = re.search(r"^FROM (nginx:\S+) AS runtime$",
                      (ROOT / "apps/web/Dockerfile").read_text(), re.MULTILINE).group(1)
    routes = (ROOT / "packages/meetings/src/capture-routes.ts").read_text()
    api_cap = re.search(r'"/api/meetings/capture/audio",[\s\S]*?bodyLimit: (\d+)', routes)
    assert int(api_cap.group(1)) == CAP, "update transport regression for the API cap"
    assert f"client_max_body_size {CAP};" in source
    # Maximum 3.84 MB synthetic PCM represented as base64, with JSON whitespace
    # bringing the complete body to the exact API limit. No microphone is used.
    body = json.dumps({"pcmBase64": "A" * 5_120_000}).encode().ljust(CAP, b" ")
    with Server(("127.0.0.1", 0), Upstream) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with proxy(source, image, server.server_port) as (port, watch):
                for chunked in (False, True):
                    upload(port, body, chunked)
                    assert not watch.created(), "audio upload created an nginx body temp file"
                    rejects_oversize(port, body, chunked)
                    assert not watch.created(), "oversized audio created an nginx body temp file"
                    print(f"PASS {'chunked' if chunked else 'fixed-length'}: {CAP} bytes "
                          "streamed intact without body files; one extra byte rejected")
                # The audio exception must not increase limits on neighboring API paths.
                rejects_oversize(port, b" " * 1_048_576, False, "/api/meetings/capture/control")
                print("PASS unrelated API route retains nginx's 1 MiB limit")

            # Security regression sensitivity: both missing protections must actually
            # produce a body-file event. Empty-directory-at-end checks would miss this.
            for label, old, new, chunked in (
                ("buffering enabled", "proxy_request_buffering off;", "proxy_request_buffering on;", False),
                ("HTTP/1.0 chunked fallback", "proxy_http_version 1.1;", "proxy_http_version 1.0;", True),
            ):
                assert old in source
                with proxy(source.replace(old, new, 1), image, server.server_port) as (port, watch):
                    upload(port, body, chunked, require_streaming=False)
                    assert watch.created(), f"negative control missed temp file: {label}"
                    print(f"PASS negative control: detected body-file creation with {label}")
        finally:
            server.shutdown()
            thread.join()


if __name__ == "__main__":
    main()
