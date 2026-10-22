"""Container-only synthetic page. Never navigate to or sign into a real account."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import subprocess
import sys
import signal
import threading

PAGE = b'''<!doctype html><title>Synthetic sign-in</title>
<h1>Synthetic browser session</h1><label>Test text <input id="entry"></label>
<p id="saved"></p><script>
document.querySelector('#saved').textContent=localStorage.getItem('marker')||'empty';
document.querySelector('#entry').focus();
</script>'''


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)


server = HTTPServer(('127.0.0.1', 8080), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
flags = ['--no-sandbox'] if sys.argv[1:] == ['--negative-control-no-sandbox'] else []
browser = subprocess.Popen([
    'chromium-browser', '--headless', '--disable-setuid-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--no-first-run', '--disable-background-networking',
    '--user-data-dir=/profile/chrome', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9222', *flags, 'http://127.0.0.1:8080',
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
signal.signal(signal.SIGTERM, lambda *_: browser.terminate())
sys.exit(browser.wait())
