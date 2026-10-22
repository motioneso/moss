"""Host-owned infrastructure denial, refreshed independently of browser requests.

Interface addresses cannot discover NAT or reverse proxies: the trusted config
must name every public host/app ingress or deny its addresses explicitly.
"""
import asyncio
import ipaddress
import json
import socket
import weakref

from egress import Denied, HOST


def validate_hosts(hosts):
    if type(hosts) is not list or not 1 <= len(hosts) <= 32:
        raise ValueError('Infrastructure hostnames required')
    for host in hosts:
        if (type(host) is not str or not HOST.fullmatch(host) or
                any(not label or len(label) > 63 or label.startswith('-') or
                    label.endswith('-') for label in host.split('.'))):
            raise ValueError('Invalid infrastructure hostname')


async def interface_addresses():
    # Fixed host tool, never a browser-supplied command or PATH override.
    process = await asyncio.create_subprocess_exec(
        '/usr/sbin/ip', '-json', 'address', 'show',
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        async with asyncio.timeout(5):
            data = bytearray()
            while chunk := await process.stdout.read(16384):
                data.extend(chunk)
                if len(data) > 131072:
                    raise ValueError('Interface discovery too large')
            if await process.wait() != 0:
                raise ValueError('Interface discovery unavailable')
        interfaces = json.loads(data)
        if type(interfaces) is not list or not 1 <= len(interfaces) <= 256:
            raise ValueError('Invalid interface discovery')
        addresses = set()
        for interface in interfaces:
            for entry in interface['addr_info']:
                if entry['family'] in ('inet', 'inet6'):
                    addresses.add(str(ipaddress.ip_address(entry['local'])))
        if not addresses or len(addresses) > 4096:
            raise ValueError('Invalid interface addresses')
        return addresses
    finally:
        if process.returncode is None:
            process.kill()
        await process.wait()


async def infrastructure_addresses(hosts):
    async def resolve(host):
        answers = await asyncio.get_running_loop().getaddrinfo(
            host, 443, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
        if not answers or len(answers) > 64:
            raise ValueError('Infrastructure DNS unavailable')
        return {str(ipaddress.ip_address(row[4][0])) for row in answers}

    async with asyncio.timeout(10), asyncio.TaskGroup() as group:
        interfaces = group.create_task(interface_addresses())
        resolutions = [group.create_task(resolve(host)) for host in hosts]
    return set().union(interfaces.result(), *(task.result() for task in resolutions))


class InfrastructurePolicy:
    """Event-loop-local policy; no await between publication and tunnel closure.

    Old discovered addresses remain denied until service restart. A bounded
    history avoids reopening old ingress on DNS rotation; exhaustion fails shut.
    """

    def __init__(self, denied_networks, hosts):
        validate_hosts(hosts)
        self.hosts = tuple(host.lower() for host in hosts)
        self.networks = frozenset(ipaddress.ip_network(n) for n in denied_networks)
        self.generation = 0
        self.deadline = 0
        self.proxies = weakref.WeakSet()
        self.expiry = None

    def snapshot(self, host=None):
        if host in self.hosts:
            raise Denied()
        if asyncio.get_running_loop().time() >= self.deadline:
            raise Denied()
        return self.generation, self.networks

    def check(self, generation):
        current, _ = self.snapshot()
        if generation != current:
            raise Denied()

    def invalidate(self):
        self.deadline = 0
        self.generation += 1
        if self.expiry:
            self.expiry.cancel()
            self.expiry = None
        for proxy in tuple(self.proxies):
            proxy.close_connections()

    async def refresh(self):
        try:
            addresses = await infrastructure_addresses(self.hosts)
            networks = self.networks | frozenset(ipaddress.ip_network(a) for a in addresses)
            if len(networks) > 4096:
                raise ValueError('Infrastructure address history exhausted')
        except Exception:
            self.invalidate()
            return False
        loop = asyncio.get_running_loop()
        if networks != self.networks or loop.time() >= self.deadline:
            self.invalidate()
        self.networks = networks
        self.deadline = loop.time() + 60
        if self.expiry:
            self.expiry.cancel()
        self.expiry = loop.call_at(self.deadline, self.invalidate)
        return True

    async def run(self):
        try:
            while True:
                await asyncio.sleep(30)
                await self.refresh()
        finally:
            self.invalidate()
