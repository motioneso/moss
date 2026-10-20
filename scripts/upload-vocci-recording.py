#!/usr/bin/env python3
"""Upload existing completed captures; never connects to a ring or decodes Opus.

Session file: private JSON {"cookie":"..."}. Source state is a persisted opaque
UUID for ONE physical source device; reuse it on retries, use a different file
for another device. Audio must already be decoded by the validated legacy decoder.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave
import io


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def private_json(path):
    target = Path(path)
    if stat.S_IMODE(target.stat().st_mode) & 0o077:
        raise ValueError("Credential/state file must have owner-only permissions")
    return json.loads(target.read_text())


def source_identity(path):
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if target.exists():
        return str(uuid.UUID(private_json(target)["sourceDeviceId"]))
    # Publish complete UUID state without overwriting another uploader's winner.
    with tempfile.NamedTemporaryFile(mode="w", dir=target.parent, delete=False) as handle:
        temporary = Path(handle.name)
        json.dump({"sourceDeviceId": str(uuid.uuid4())}, handle)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        try:
            os.link(temporary, target)
        except FileExistsError:
            pass
        return str(uuid.UUID(private_json(target)["sourceDeviceId"]))
    finally:
        temporary.unlink()


def bounded_bytes(path, limit):
    with Path(path).open("rb") as handle:
        value = handle.read(limit + 1)
    if not value or len(value) > limit:
        raise ValueError("Input file empty or exceeds import limit")
    return value


def file_manifest(name, data):
    return {"name": name, "base64": base64.b64encode(data).decode("ascii"),
            "sha256": hashlib.sha256(data).hexdigest()}


def canonical_wav(data):
    with wave.open(io.BytesIO(data), "rb") as source:
        if (source.getnchannels(), source.getsampwidth(), source.getframerate(), source.getcomptype()) != (1, 2, 16000, "NONE"):
            raise ValueError("WAV must be 16 kHz mono signed-16-bit PCM")
        if source.getnframes() > 1_920_000:
            raise ValueError("Recording exceeds 120 seconds")
        frames = source.readframes(source.getnframes())
        if len(frames) != source.getnframes() * 2:
            raise ValueError("Truncated WAV")
    output = io.BytesIO()
    with wave.open(output, "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(16000)
        target.writeframes(frames)
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["url", "session-file", "recording-id", "packets", "sidecar", "wav"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--source-state", default="~/.local/state/moss/vocci-import/device.json")
    parser.add_argument("--wait", action="store_true")
    args = parser.parse_args()
    base = urllib.parse.urlsplit(args.url)
    if base.scheme not in ("https", "http") or not base.hostname or base.username or base.password or base.query or base.fragment or base.path not in ("", "/"):
        raise ValueError("URL must be a plain origin without credentials")
    if base.scheme == "http" and base.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("HTTP is allowed only on loopback; use HTTPS remotely")
    if not re.fullmatch(r"(?:amsg_)?[0-9]{10}_[A-Za-z0-9_-]{1,24}", args.recording_id):
        raise ValueError("Unexpected legacy recording identity")
    cookie = private_json(Path(args.session_file).expanduser())["cookie"]
    if not isinstance(cookie, str) or not cookie or "\n" in cookie or "\r" in cookie:
        raise ValueError("Invalid session cookie")
    payload = {"version": 1, "sourceDeviceId": source_identity(args.source_state),
               "recordingId": args.recording_id,
               "packets": file_manifest(args.recording_id + ".opus", bounded_bytes(args.packets, 1024 * 1024)),
               "sidecar": file_manifest(args.recording_id + ".json", bounded_bytes(args.sidecar, 64 * 1024)),
               "wav": file_manifest(args.recording_id + ".wav", canonical_wav(bounded_bytes(args.wav, 4 * 1024 * 1024)))}
    body = json.dumps(payload, separators=(",", ":")).encode()
    if len(body) > 8 * 1024 * 1024:
        raise ValueError("Request exceeds 8 MiB")
    opener = urllib.request.build_opener(NoRedirect())
    origin = args.url.rstrip("/")

    def request(path, data=None):
        req = urllib.request.Request(origin + path, data=data, headers={"Cookie": cookie, "Content-Type": "application/json"})
        try:
            with opener.open(req, timeout=60) as response:
                result = response.read(65537)
                if len(result) > 65536:
                    raise ValueError("Unexpected oversized status response")
                return json.loads(result)
        except urllib.error.HTTPError as error:
            raise ValueError("Moss rejected import/status (HTTP " + str(error.code) + ")") from None

    result = request("/api/meetings/recording-imports", body)
    if args.wait:
        deadline = time.monotonic() + 600
        while result["state"] in ("queued", "transcribing") and time.monotonic() < deadline:
            time.sleep(2)
            result = request("/api/meetings/recording-imports/" + str(uuid.UUID(result["id"])))
    print(json.dumps({key: result.get(key) for key in ("id", "meetingId", "state", "mode", "durationMs", "bookmarksMs", "code", "retryable")}))
    if result["state"] == "failed":
        return 1
    return 2 if args.wait and result["state"] != "complete" else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, wave.Error):
        print("Import failed. Check local files, owner-only credentials, URL and server status; private input was not printed.", file=sys.stderr)
        sys.exit(1)
