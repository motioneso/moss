#!/usr/bin/env python3
"""Loopback relay for the Finance live bank run with Plaid sandbox keys.

The debug server sends bank calls to http://127.0.0.1:PORT/<host>/<path>. This forwards each one
to https://sandbox.plaid.com/<path>. It never logs a request or reply body.
"""
import http.server
import socketserver
import urllib.error
import urllib.request

UPSTREAM = "https://sandbox.plaid.com"


class Relay(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        path = "/" + self.path.lstrip("/").split("/", 1)[1] if self.path.count("/") > 1 else self.path
        request = urllib.request.Request(
            UPSTREAM + path, data=body, headers={"content-type": "application/json"}, method="POST"
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as reply:
                status, data = reply.status, reply.read()
        except urllib.error.HTTPError as error:
            status, data = error.code, error.read()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


with Server(("127.0.0.1", 0), Relay) as server:
    print(f"endpoint http://127.0.0.1:{server.server_address[1]}", flush=True)
    server.serve_forever()
