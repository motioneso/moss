"""Synthetic transport proof. Sessions are injected by verify.py, NOT real Moss auth.

No CLI/login endpoint: this must not be deployed as an authentication service.
The only exposed browser operations are a JPEG frame and bounded synthetic text input.
"""
import base64
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import secrets
import threading
import time


class Denied(Exception):
    pass


class Broker:
    def __init__(self, runtime, port):
        self.runtime = runtime
        self.origin = f'http://127.0.0.1:{port}'
        self.sessions = {}
        self.connections = {}
        self.views = {}
        self.lock = threading.Lock()
        # In-process fault injection for negative controls only; never request-configurable.
        self.disabled = set()
        broker = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def handle_request(self):
                try:
                    with broker.lock:
                        cookie = SimpleCookie(self.headers.get('Cookie', ''))
                        token = cookie.get('probe_session')
                        session = broker.sessions.get(token.value if token else '')
                        if not session:
                            raise Denied()
                        if 'session' not in broker.disabled and (
                                not session['active'] or session['expires'] <= time.monotonic()):
                            raise Denied()
                        if 'origin' not in broker.disabled and self.headers.get('Origin') != broker.origin:
                            raise Denied()
                        parts = self.path.split('/')
                        if len(parts) != 3 or parts[1] not in ('frame', 'input'):
                            raise Denied()
                        view = broker.views.get(parts[2])
                        if not view:
                            raise Denied()
                        connection = broker.connections[view['connection']]
                        if 'owner' not in broker.disabled and connection['owner'] != session['owner']:
                            raise Denied()
                        if 'viewer_session' not in broker.disabled and view['session'] != session['id']:
                            raise Denied()
                        if 'generation' not in broker.disabled and view['generation'] != connection['generation']:
                            raise Denied()
                        if 'active' not in broker.disabled and not connection['active']:
                            raise Denied()
                        if 'lease' not in broker.disabled and view['expires'] <= time.monotonic():
                            raise Denied()
                        runtime_id = connection['runtime']
                        if self.command == 'GET' and parts[1] == 'frame':
                            frame = broker.runtime.call(runtime_id, 'Page.captureScreenshot',
                                                        {'format': 'jpeg', 'quality': 65})
                            body = base64.b64decode(frame['data'])
                            kind = 'image/jpeg'
                        elif self.command == 'POST' and parts[1] == 'input':
                            size = int(self.headers.get('Content-Length', '0'))
                            if not 0 < size <= 1024:
                                raise Denied()
                            data = json.loads(self.rfile.read(size))
                            if set(data) != {'text'} or not isinstance(data['text'], str) or len(data['text']) > 128:
                                raise Denied()
                            broker.runtime.call(runtime_id, 'Input.insertText', {'text': data['text']})
                            body, kind = b'{}', 'application/json'
                        else:
                            raise Denied()
                    self.send_response(200)
                    self.send_header('Content-Type', kind)
                    self.send_header('Content-Length', str(len(body)))
                    self.send_header('Cache-Control', 'no-store')
                    self.send_header('X-Content-Type-Options', 'nosniff')
                    self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
                    self.end_headers()
                    self.wfile.write(body)
                except Denied:
                    self.send_error(403, 'Unavailable')
                except Exception:
                    self.send_error(500, 'Probe failed')

            do_GET = handle_request
            do_POST = handle_request

        self.server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def session(self, owner):
        token = secrets.token_urlsafe(32)
        self.sessions[token] = {'id': secrets.token_hex(16), 'owner': owner,
                                'active': True, 'expires': time.monotonic() + 600}
        return token

    def attach(self, token, connection):
        session = self.sessions[token]
        source = self.connections[connection]
        if source['owner'] != session['owner'] or not source['active']:
            raise Denied()
        if any(v['connection'] == connection and v['expires'] > time.monotonic()
               for v in self.views.values()):
            raise Denied()
        view = secrets.token_hex(16)
        self.views[view] = {'connection': connection, 'session': session['id'],
                            'generation': source['generation'],
                            'expires': time.monotonic() + 120}
        return view

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
