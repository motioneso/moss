"""Probe browser process tree. Chromium speaks DevTools over a pipe pair, which this
runner bridges to one Unix socket (/ctl/cdp.sock). Messages are NUL-delimited JSON."""
import fcntl
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time

HEADED = os.environ.get('PROBE_HEADED') == '1'


def main():
    if os.getuid() != 1000:
        return 1
    os.umask(0o077)
    Path('/profile/chrome').mkdir(mode=0o700, exist_ok=True)
    children = []
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True
        for child in children:
            if child.poll() is None:
                child.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    to_r, to_w = os.pipe()
    from_r, from_w = os.pipe()

    def child_setup():
        hi_r = fcntl.fcntl(to_r, fcntl.F_DUPFD, 10)
        hi_w = fcntl.fcntl(from_w, fcntl.F_DUPFD, 10)
        os.dup2(hi_r, 3)
        os.dup2(hi_w, 4)

    try:
        children.append(subprocess.Popen(
            [sys.executable, '-B', '/opt/moss/proxy.py'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        deadline = time.monotonic() + 5
        while True:
            if stopping or children[0].poll() is not None:
                return 1
            try:
                with socket.create_connection(('127.0.0.1', 8080), timeout=0.2):
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    return 1
                time.sleep(0.05)
        flags = [] if HEADED else ['--headless']
        children.append(subprocess.Popen([
            'chromium-browser', *flags, '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', '--no-first-run', '--disable-background-networking',
            '--disable-quic', '--proxy-server=http://127.0.0.1:8080',
            '--proxy-bypass-list=<-loopback>',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
            '--user-data-dir=/profile/chrome', '--window-size=1280,1800',
            '--remote-debugging-pipe', 'about:blank',
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            close_fds=False, preexec_fn=child_setup))
        os.close(to_r)
        os.close(from_w)

        state = {'conn': None}
        lock = threading.Lock()

        def pump_out():
            while True:
                data = os.read(from_r, 65536)
                if not data:
                    return
                with lock:
                    conn = state['conn']
                if conn:
                    try:
                        conn.sendall(data)
                    except OSError:
                        pass

        def serve():
            path = '/ctl/cdp.sock'
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
            server = socket.socket(socket.AF_UNIX)
            server.bind(path)
            server.listen(1)
            while True:
                conn, _ = server.accept()
                with lock:
                    old = state['conn']
                    state['conn'] = conn
                if old:
                    old.close()
                threading.Thread(target=pump_in, args=(conn,), daemon=True).start()

        def pump_in(conn):
            try:
                while data := conn.recv(65536):
                    os.write(to_w, data)
            except OSError:
                pass
            finally:
                with lock:
                    if state['conn'] is conn:
                        state['conn'] = None
                conn.close()

        threading.Thread(target=pump_out, daemon=True).start()
        threading.Thread(target=serve, daemon=True).start()
        while not stopping and all(child.poll() is None for child in children):
            time.sleep(0.2)
        return 0 if stopping else 1
    finally:
        stop()
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == '__main__':
    sys.exit(main())
