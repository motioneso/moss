#!/usr/bin/env python3
"""Throwaway LAN chat bridge. No Moss services, database, or workspace mounts."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
INSTRUCTIONS = (HERE / "model-instructions.txt").read_text()
ACTIVE = {}
LOCK = threading.Lock()
SLOTS = threading.BoundedSemaphore(2)


def model_command():
    # Mount the CLI executable and its login, not the user's home or checkout.
    # Other settings, MCP servers, plugins, hooks and executable tools are disabled.
    wrapper = Path(shutil.which("codex") or "").resolve()
    candidates = list(wrapper.parent.parent.glob(
        "node_modules/@openai/codex-linux-*/vendor/*/bin/codex"))
    binary = Path(os.environ.get("MOSS_CODEX_BINARY", candidates[0] if candidates else ""))
    auth = Path.home() / ".codex/auth.json"
    if not binary.is_file() or not auth.is_file() or not shutil.which("bwrap"):
        raise RuntimeError("Needs a logged-in Codex CLI and bubblewrap on Linux.")
    args = ["bwrap", "--die-with-parent", "--unshare-pid", "--new-session",
            "--ro-bind", str(binary), "/codex", "--dir", "/chat", "--chdir", "/chat",
            "--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev",
            "--ro-bind", str(auth), str(auth),
            "--ro-bind", str(HERE / "response-schema.json"), "/response-schema.json"]
    for path in ["/etc/ssl/certs", "/etc/resolv.conf", "/etc/hosts"]:
        args += ["--ro-bind", os.path.realpath(path), path]
    args += ["/codex", "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
             "--skip-git-repo-check", "--json", "--output-schema", "/response-schema.json"]
    for feature in ["shell_tool", "apps", "plugins", "hooks", "multi_agent", "multi_agent_v2",
                    "browser_use", "computer_use", "image_generation", "view_image",
                    "skill_search", "code_mode_host", "goals", "sleep_tool", "tool_suggest"]:
        args += ["-c", f"features.{feature}=false"]
    args += ["-c", 'web_search="disabled"', "-c", "skills.include_instructions=false",
             "-c", 'model_reasoning_effort="low"']
    if os.environ.get("MOSS_CHAT_MODEL"):
        args += ["--model", os.environ["MOSS_CHAT_MODEL"]]
    return args + ["-"]


COMMAND = None


def stop_process(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # No prompt, model output, or auth logging.

    def respond(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        route = urlsplit(self.path).path
        if route == "/api/health":
            return self.respond(200, {"live": True, "data": "example", "backend": "Codex"})
        files = {"/": "live.html", "/live.html": "live.html",
                 "/mockups": "index.html", "/index.html": "index.html"}
        if route not in files:
            return self.respond(404, {"error": "Not found"})
        data = (HERE / files[route]).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        # Prevent a different website from submitting through a visitor's browser.
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + self.headers.get("Host", ""):
            return self.respond(403, {"error": "Use the prototype's own page."})
        if self.headers.get_content_type() != "application/json":
            return self.respond(415, {"error": "Expected JSON"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 100_000:
                raise ValueError()
            body = json.loads(self.rfile.read(length))
            request_id = body["id"]
            if not isinstance(request_id, str) or not 10 <= len(request_id) <= 80:
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            return self.respond(400, {"error": "Invalid request"})
        route = urlsplit(self.path).path
        if route == "/api/cancel":
            with LOCK:
                process = ACTIVE.get(request_id)
                if process:
                    stop_process(process)
            return self.respond(200, {"cancelled": True})
        if route != "/api/chat":
            return self.respond(404, {"error": "Not found"})
        messages = body.get("messages")
        if not isinstance(messages, list) or not 1 <= len(messages) <= 40:
            return self.respond(400, {"error": "Start a new conversation after 20 replies."})
        for message in messages:
            if (not isinstance(message, dict) or message.get("role") not in ["user", "assistant"]
                    or not isinstance(message.get("content"), str)
                    or len(message["content"]) > 24_000):
                return self.respond(400, {"error": "Message too long or invalid."})
        if not SLOTS.acquire(blocking=False):
            return self.respond(429, {"error": "Two replies are already running. Try again shortly."})
        process = None
        try:
            prompt = INSTRUCTIONS + "\n\nConversation (JSON data):\n" + json.dumps(messages)
            process = subprocess.Popen(COMMAND, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, text=True, start_new_session=True,
                                       env={k: v for k, v in os.environ.items()
                                            if k in ["HOME", "PATH", "USER", "LANG"]})
            with LOCK:
                ACTIVE[request_id] = process
            output, _ = process.communicate(prompt, timeout=120)
            if process.returncode:
                raise RuntimeError("Model connection stopped. Please try again.")
            final = None
            for line in output.splitlines():
                event = json.loads(line)
                item = event.get("item", {})
                if event.get("type") == "item.completed" and item.get("type") == "agent_message":
                    final = json.loads(item["text"])
            if not isinstance(final, dict) or not isinstance(final.get("text"), str):
                raise RuntimeError("The model did not return a visual reply. Please try again.")
            self.respond(200, final)
        except subprocess.TimeoutExpired:
            self.respond(504, {"error": "This reply took too long. Please try again."})
        except (RuntimeError, ValueError, KeyError):
            self.respond(502, {"error": "The model connection could not finish. Please retry."})
        finally:
            if process:
                stop_process(process)
            with LOCK:
                ACTIVE.pop(request_id, None)
            SLOTS.release()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, type=int, help="A port reserved with devports claim")
    args = parser.parse_args()
    if not 5180 <= args.port <= 5299:
        parser.error("Use a devports reservation in 5180–5299")
    COMMAND = model_command()
    print(f"Live visual chat listening on 0.0.0.0:{args.port}", flush=True)
    try:
        ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()
    finally:
        with LOCK:
            for process in ACTIVE.values():
                stop_process(process)
