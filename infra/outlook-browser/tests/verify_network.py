"""Real rootless container proof for the egress transport, without a browser.

Uses public Microsoft HTTPS, no account/login. Pull the disposable Python fixture
image first. This does not establish Chromium/MFA or managed-service readiness.
"""
import argparse
import asyncio
import json
import os
import tempfile
import uuid
from pathlib import Path

from egress import Egress


CONTAINER = r'''
import json, socket, ssl
checks = []
for family, address in ((socket.AF_INET, ('1.1.1.1', 443)),
                        (socket.AF_INET6, ('2606:4700:4700::1111', 443))):
    with socket.socket(family, socket.SOCK_STREAM) as connection:
        connection.settimeout(3)
        try:
            connection.connect(address)
        except OSError:
            checks.append('direct-network-denied')
        else:
            raise AssertionError('Direct network available')

def tunnel(authority):
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(20)
    connection.connect('/egress/connect.sock')
    connection.sendall(('CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' +
                        authority + '\r\n\r\n').encode())
    header = b''
    while not header.endswith(b'\r\n\r\n'):
        part = connection.recv(1)
        if not part or len(header) > 8192:
            raise AssertionError('Invalid proxy response')
        header += part
    return connection, header

for authority in ('127.0.0.1:443', '10.0.0.1:443', '172.17.0.1:443',
                  '192.168.1.1:443', '169.254.169.254:443', '100.100.100.200:443',
                  '[::1]:443', '[::ffff:127.0.0.1]:443', '[2002:7f00:1::]:443',
                  '[fc00::1]:443', 'www.microsoft.com:80'):
    connection, header = tunnel(authority)
    with connection:
        assert header.startswith(b'HTTP/1.1 403 '), 'Blocked destination accepted'
    checks.append('proxy-destination-denied')

connection, header = tunnel('www.microsoft.com:443')
assert header.startswith(b'HTTP/1.1 200 '), 'Public HTTPS tunnel failed'
with ssl.create_default_context().wrap_socket(connection,
                                            server_hostname='www.microsoft.com') as secure:
    secure.sendall(b'HEAD / HTTP/1.1\r\nHost: www.microsoft.com\r\nConnection: close\r\n\r\n')
    response = secure.recv(1024)
    assert response.startswith(b'HTTP/1.1 '), 'HTTPS response missing'
checks.append('public-https-with-certificate-verification')
print(json.dumps({'checks': checks}))
'''


class ContainerFailure(Exception):
    def __init__(self, code, output):
        super().__init__('Container proof failed (no private output retained)')
        self.code = code
        self.output = output


async def command(*args, data=None):
    process = await asyncio.create_subprocess_exec(
        'podman', *args, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        output, _ = await asyncio.wait_for(process.communicate(data), 60)
    except BaseException:
        process.kill()
        await process.wait()
        raise
    if process.returncode:
        raise ContainerFailure(process.returncode, output)
    return output


async def verify(image, negative_control=False):
    name = 'moss-outlook-network-test-' + uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix='moss-outlook-network-') as directory:
        egress = Egress(())
        try:
            socket_path = str(Path(directory) / 'connect.sock')
            await egress.listen(socket_path)
            os.chmod(socket_path, 0o600)
            source = CONTAINER
            if negative_control:
                source = source.replace("raise AssertionError('Direct network available')",
                                        "print('DIRECT_NETWORK_AVAILABLE', flush=True); exit(42)")
            try:
                output = await command('run', '--rm', '--name', name, '--pull', 'never',
                                       '--network', 'slirp4netns' if negative_control else 'none',
                                       '--userns', 'keep-id', '--read-only', '--cap-drop', 'all',
                                       '--security-opt', 'no-new-privileges', '--memory', '128m',
                                       '--pids-limit', '64', '--volume', directory + ':/egress:ro',
                                       '-i', image, 'python3', '-B', '-', data=source.encode())
            except ContainerFailure as error:
                if negative_control and error.code == 42 and error.output.strip() == b'DIRECT_NETWORK_AVAILABLE':
                    print('PASS: direct-network check fails when network-none protection is removed')
                    return
                raise
            if negative_control:
                raise AssertionError('Negative control did not demonstrate direct networking')
            checks = json.loads(output)['checks']
            assert len(checks) == 14
            print('PASS: 14 rootless network-none/Unix-egress checks; public TLS verified')
        finally:
            await command('rm', '--force', '--ignore', name)
            await egress.revoke()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', default='docker.io/library/python:3.12-alpine3.23')
    parser.add_argument('--negative-control', action='store_true')
    args = parser.parse_args()
    asyncio.run(verify(args.image, args.negative_control))
