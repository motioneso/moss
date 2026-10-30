"""Fixed browser process tree. No client-supplied flags, URLs or debugging port."""
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time


def main():
    if len(sys.argv) != 1 or os.getuid() != 1000:
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
        children.append(subprocess.Popen([
            'chromium-browser', '--headless', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', '--no-first-run', '--disable-background-networking',
            '--disable-quic', '--proxy-server=http://127.0.0.1:8080',
            '--proxy-bypass-list=<-loopback>',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
            '--user-data-dir=/profile/chrome', '--window-size=1280,1800',
            '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222',
            'about:blank',
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
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
