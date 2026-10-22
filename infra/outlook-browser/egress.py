"""Private per-runtime CONNECT transport. No TLS interception or request logging.

The browser must run in a network-none namespace, with only this runtime's Unix
socket mounted. This module alone does not isolate a network-enabled browser.
"""
import asyncio
import ipaddress
import re
import socket
from contextlib import suppress


class Denied(Exception):
    pass


# Be explicit rather than inheriting version-dependent ipaddress.is_global data.
SPECIAL_V4 = tuple(ipaddress.ip_network(value) for value in (
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
    '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
    '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15',
    '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3',
))
GLOBAL_V6 = ipaddress.ip_network('2000::/3')
SPECIAL_V6 = tuple(ipaddress.ip_network(value) for value in (
    '2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20',
))
HOST = re.compile(r'(?=.{1,253}\Z)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\Z')


def public_address(value, denied_networks):
    address = ipaddress.ip_address(value)
    if address.version == 4:
        allowed = not any(address in network for network in SPECIAL_V4)
    else:
        allowed = address in GLOBAL_V6 and not any(address in n for n in SPECIAL_V6)
    if not allowed or any(address in network for network in denied_networks):
        raise Denied()
    return address


def connect_host(header):
    """Accept only a bounded HTTP CONNECT authority, never an arbitrary URL."""
    try:
        lines = header.decode('ascii').split('\r\n')
        method, authority, version = lines[0].split(' ')
        if method != 'CONNECT' or version != 'HTTP/1.1':
            raise Denied()
        if authority.startswith('['):
            match = re.fullmatch(r'\[([0-9a-fA-F:]+)\]:443', authority)
            if not match:
                raise Denied()
            host = str(ipaddress.IPv6Address(match[1]))
        else:
            host, port = authority.split(':')
            if port != '443' or not HOST.fullmatch(host):
                raise Denied()
            if any(not label or len(label) > 63 or label.startswith('-') or
                   label.endswith('-') for label in host.split('.')):
                raise Denied()
        seen = set()
        for line in lines[1:-2]:
            name, value = line.split(':', 1)
            name = name.lower()
            if not re.fullmatch(r'[a-z-]+', name) or name in seen:
                raise Denied()
            seen.add(name)
            if name not in ('host', 'user-agent', 'proxy-connection', 'connection',
                            'content-length') or any(ord(c) < 32 for c in value):
                raise Denied()
            if name == 'content-length' and value.strip() != '0':
                raise Denied()
            if name == 'host' and value.strip().lower() != authority.lower():
                raise Denied()
        return host.lower()
    except (ValueError, UnicodeError):
        raise Denied() from None


async def resolve_public(host, denied_networks):
    loop = asyncio.get_running_loop()
    answers = await asyncio.wait_for(loop.getaddrinfo(
        host, 443, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP), 5)
    if not answers or len(answers) > 64:
        raise Denied()
    # Reject mixed public/private answers. Connect to one validated literal below;
    # the destination hostname must never undergo a second DNS lookup.
    return tuple(dict.fromkeys(str(public_address(row[4][0], denied_networks))
                               for row in answers))


class Egress:
    """One instance/socket per runtime; revoke() closes existing tunnels too."""

    def __init__(self, denied_networks, *, infrastructure=None, max_connections=64):
        self.denied_networks = tuple(ipaddress.ip_network(n) for n in denied_networks)
        self.infrastructure = infrastructure
        if infrastructure is not None:
            infrastructure.proxies.add(self)
        self.max_connections = max_connections
        self.tasks = set()
        self.writers = set()
        self.revoked = False
        self.server = None

    async def listen(self, path):
        if self.revoked or self.server:
            raise Denied()
        # Parent directory and socket mode are set/checked by the host runtime.
        self.server = await asyncio.start_unix_server(self.handle, path, limit=8192)

    def close_connections(self):
        for writer in tuple(self.writers):
            writer.close()
        for task in tuple(self.tasks):
            task.cancel()

    async def revoke(self):
        self.revoked = True
        if self.infrastructure is not None:
            self.infrastructure.proxies.discard(self)
        if self.server:
            self.server.close()
        pending = tuple(self.tasks)
        self.close_connections()
        await asyncio.gather(*pending, return_exceptions=True)
        if self.server:
            await self.server.wait_closed()

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        if self.revoked or len(self.tasks) >= self.max_connections:
            writer.close()
            return
        self.tasks.add(task)
        self.writers.add(writer)
        upstream = None
        connected = False
        try:
            header = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 5)
            if len(header) > 8192:
                raise Denied()
            host = connect_host(header)
            generation, networks = (self.infrastructure.snapshot(host) if self.infrastructure
                                    else (None, self.denied_networks))
            addresses = await resolve_public(host, networks)
            if self.revoked:
                raise Denied()
            # Numeric address, no hostname lookup in open_connection. This is the
            # enforcement point for redirects, IP literals and DNS rebinding.
            address = addresses[0]
            async with asyncio.timeout(10):
                if self.infrastructure:
                    self.infrastructure.check(generation)
                source, upstream = await asyncio.open_connection(
                    address, 443, family=socket.AF_INET6 if ':' in address else socket.AF_INET)
            self.writers.add(upstream)
            if self.infrastructure:
                self.infrastructure.check(generation)
            if self.revoked:
                raise Denied()
            writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            await writer.drain()
            connected = True
            async with asyncio.TaskGroup() as group:
                group.create_task(self.pipe(reader, upstream))
                group.create_task(self.pipe(source, writer))
        except (Denied, OSError, ValueError, TimeoutError, asyncio.IncompleteReadError,
                asyncio.LimitOverrunError, ExceptionGroup):
            if not connected:
                writer.write(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n'
                             b'Connection: close\r\n\r\n')
                with suppress(OSError):
                    await writer.drain()
        finally:
            if upstream:
                upstream.close()
                self.writers.discard(upstream)
            writer.close()
            with suppress(OSError):
                await writer.wait_closed()
            self.tasks.discard(task)
            self.writers.discard(writer)

    @staticmethod
    async def pipe(reader, writer):
        # A bounded connection lifetime makes stalled tunnels reclaimable even if
        # the browser never closes them. Chromium can open a fresh CONNECT.
        async with asyncio.timeout(300):
            while True:
                data = await asyncio.wait_for(reader.read(65536), 60)
                if not data:
                    if writer.can_write_eof():
                        writer.write_eof()
                    return
                writer.write(data)
                await writer.drain()
