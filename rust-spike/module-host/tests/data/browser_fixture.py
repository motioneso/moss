#!/usr/bin/env python3
"""Test-only HTTPS site for the browser port proof. Pages build their content with scripts, and
probe pages try every route a page has to the network. Every request is logged, one line each."""
import http.server, json, pathlib, ssl, sys, urllib.parse

cert, key, port, log, ready, listener = sys.argv[1:]

PROBE = """
const only = new URLSearchParams(location.search).get('only') || (document.currentScript && new URL(document.currentScript.src).searchParams.get('only')) || 'all';
const want = k => only === 'all' || only === k;
const out = [];
const note = (k, v) => { out.push(k + ':' + v); document.title = out.join(' '); document.body.textContent = out.join(' | '); };
const L = %s;
if (want('ws')) try { const ws = new WebSocket('wss://127.0.0.1:' + L + '/'); ws.onerror = () => note('ws', 'error'); ws.onopen = () => note('ws', 'open'); } catch (e) { note('ws', 'throw'); }
if (want('rtc')) try {
  const pc = new RTCPeerConnection({iceServers: [{urls: 'stun:127.0.0.1:' + L}]});
  pc.createDataChannel('x');
  pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => note('rtc', 'offered'), () => note('rtc', 'error'));
} catch (e) { note('rtc', 'throw'); }
if (want('sw')) try {
  navigator.serviceWorker.register('/sw.js').then(() => note('sw', 'registered'), () => note('sw', 'refused'));
} catch (e) { note('sw', 'throw'); }
for (const rel of ['prefetch', 'preconnect']) if (want(rel)) {
  const l = document.createElement('link'); l.rel = rel; l.href = 'https://127.0.0.1:' + L + '/' + rel; document.head.appendChild(l);
}
if (want('fetch')) fetch('https://127.0.0.1:' + L + '/fetch').then(() => note('fetch', 'ok'), () => note('fetch', 'refused'));
if (want('img')) { const img = new Image(); img.src = 'https://127.0.0.1:' + L + '/img'; }
if (want('dns')) { const d = document.createElement('link'); d.rel = 'dns-prefetch'; d.href = '//probe-dns.invalid-name.test'; document.head.appendChild(d); }
"""

NEWS_JS = """
fetch('/api/headlines').then(r => r.json()).then(items => {
  document.getElementById('r').innerHTML = items.map(i => '<p><a href="' + i.url + '">' + i.title + '</a></p>').join('');
});
"""

ITEMS = [{"url": f"https://ok.test/story/{n}", "title": f"Zebra-marker headline number {n} from the page"} for n in range(7)]
ITEMS.insert(2, {"url": "https://other.test/story/x", "title": "Off list headline that must not be a candidate"})


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send(self, status, body=b"", ctype="text/html; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_GET(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        with open(log, "a") as out:
            out.write(f"{host} {self.path}\n")
        path = urllib.parse.urlparse(self.path).path
        if path == "/robots.txt":
            return self.send(404)
        if path == "/news":
            page = (
                "<html><head><title>Fixture Sports</title></head><body><div id=r>loading</div>"
                '<script src="/app.js"></script>'
                '<script src="https://other.test/third-party.js"></script>'
                '<img src="https://ok.test/pixel.png"></body></html>'
            )
            return self.send(200, page.encode())
        if path == "/app.js":
            return self.send(200, NEWS_JS.encode(), "text/javascript")
        if path == "/api/headlines":
            return self.send(200, json.dumps(ITEMS).encode(), "application/json")
        if path == "/probe":
            q = urllib.parse.urlparse(self.path).query
            page = f"<html><head><title>probe</title></head><body>probing</body><script src=\"/probe.js?{q}\"></script></html>"
            return self.send(200, page.encode())
        if path == "/probe.js":
            return self.send(200, (PROBE % listener).encode(), "text/javascript")
        if path == "/guards":
            page = ('<html><body>guards<script src="https://other.test/off-list.js"></script>'
                    '<script src="https://private.test/private.js"></script></body></html>')
            return self.send(200, page.encode())
        if path == "/nav1":
            return self.send(200, b'<html><title>First page</title><body>one<script>setTimeout(() => location.href = "/nav2", 200)</script></body></html>')
        if path == "/nav2":
            return self.send(200, b'<html><title>Second page</title><body>two</body></html>')
        if path == "/agg":
            page = "<html><body>" + "".join(f'<script src="/chunk/{n}.js" onload="document.body.append(\'L\')" onerror="document.body.append(\'R\')"></script>' for n in range(8)) + "</body></html>"
            return self.send(200, page.encode())
        if path.startswith("/chunk/"):
            return self.send(200, b"1;" + b"a" * (1800 * 1024), "text/javascript")
        if path == "/many":
            page = "<html><body>" + "".join(f'<script src="/s/{n}.js"></script>' for n in range(60)) + "</body></html>"
            return self.send(200, page.encode())
        if path.startswith("/s/"):
            return self.send(200, b"1;", "text/javascript")
        if path == "/huge.js":
            return self.send(200, b"a" * (3 * 1024 * 1024), "text/javascript")
        if path == "/huge":
            return self.send(200, b'<html><body>x<script src="/huge.js" onload="document.body.append(\'LOADED\')" onerror="document.body.append(\'REFUSED\')"></script></body></html>')
        if path == "/hangpage":
            return self.send(200, b'<html><body><script src="/hang"></script></body></html>')
        if path == "/hang":
            import time
            time.sleep(60)
        return self.send(200, b"<html><head><title>plain</title></head><body>hello</body></html>")


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


server = Server(("127.0.0.1", int(port)), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(cert, key)
server.socket = context.wrap_socket(server.socket, server_side=True)
pathlib.Path(ready).write_text("ready")
server.serve_forever()
