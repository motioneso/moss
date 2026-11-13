#!/usr/bin/env python3
"""Test-only HTTPS site used by the public-web proof. It serves fixed pages, tells the proof every
request it received (one line each in the log file), and holds no real data."""
import http.server, pathlib, ssl, sys, time, urllib.parse

cert, key, port, log, ready = sys.argv[1:]

ROBOTS = {
    "ok.test": None,  # no robots file at all
    "private.test": "User-agent: *\nDisallow: /private\nAllow: /private/open\n",
    "deny.test": "User-agent: *\nDisallow: /\n",
    "broken.test": 500,  # a robots file that cannot be read
    "www.reddit.com": "User-agent: *\nDisallow: /\n",
}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send(self, status, body=b"", headers=None, length=True):
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if length:
            self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_GET(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        with open(log, "a") as out:
            out.write(f"{host} {self.path} UA={self.headers.get('User-Agent')}\n")
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        path = url.path
        if path == "/robots.txt":
            rule = ROBOTS.get(host, None)
            if rule is None:
                return self.send(404)
            if isinstance(rule, int):
                return self.send(rule, b"error")
            return self.send(200, rule.encode(), {"Content-Type": "text/plain"})
        if path == "/redirect":
            return self.send(302, b"", {"Location": query["to"][0]})
        if path.startswith("/status/"):
            headers = {}
            if "after" in query:
                headers["Retry-After"] = query["after"][0]
            return self.send(int(path.split("/")[2]), b"secret-error-body", headers)
        if path == "/challenge":
            return self.send(403, b"secret-challenge-body", {"cf-mitigated": "challenge"})
        if path == "/big":
            return self.send(200, b"a" * int(query["n"][0]), {"Content-Type": "text/plain"})
        if path == "/lying-length":
            body = b"a" * 10
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "50")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True
            return
        if path == "/bad-length":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "abc")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            return
        if path == "/slow":
            time.sleep(float(query.get("s", ["5"])[0]))
            return self.send(200, b"late", {"Content-Type": "text/plain"})
        if path == "/binary":
            return self.send(200, bytes(range(256)), {"Content-Type": "application/octet-stream"})
        if path == "/feed.xml":
            return self.send(200, b"<rss><channel><title>Fixture</title></channel></rss>", {"Content-Type": "application/rss+xml; charset=utf-8"})
        return self.send(200, b"<html><body>hello from " + host.encode() + b"</body></html>", {"Content-Type": "text/html; charset=utf-8"})


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


server = Server(("127.0.0.1", int(port)), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(cert, key)
server.socket = context.wrap_socket(server.socket, server_side=True)
pathlib.Path(ready).write_text("ready")
server.serve_forever()
