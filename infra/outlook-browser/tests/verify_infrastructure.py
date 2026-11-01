"""Account-free host policy proof with real discovery, DNS, Unix CONNECT and TLS.

www.microsoft.com is a disclosed stand-in for a public application ingress: first
ordinary allowed HTTPS, then deliberately classified as infrastructure. No Moss
deployment, browser, account or host TCP listener is used.
"""
import asyncio
import ipaddress
import ssl
import tempfile
from pathlib import Path

from egress import Denied, Egress, public_address
from infrastructure import InfrastructurePolicy, interface_addresses


async def tunnel(path, host):
    reader, writer = await asyncio.open_unix_connection(str(path))
    try:
        authority = f'[{host}]:443' if ':' in host else host + ':443'
        writer.write(f'CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n'.encode())
        await writer.drain()
        header = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 15)
        return header, reader, writer
    except BaseException:
        writer.close()
        await writer.wait_closed()
        raise


def require_denied(header):
    assert header.startswith(b'HTTP/1.1 403 '), 'Infrastructure destination was accepted'


async def verify():
    policy = InfrastructurePolicy(('192.0.2.0/24',), ['localhost'])
    proxy = Egress((), infrastructure=policy)
    control = Egress(())
    clients = []
    with tempfile.TemporaryDirectory(prefix='moss-infrastructure-proof-') as directory:
        path = Path(directory) / 'connect.sock'
        control_path = Path(directory) / 'control.sock'
        try:
            assert await policy.refresh(), 'Initial infrastructure discovery failed'
            _, networks = policy.snapshot()
            addresses = await interface_addresses()
            assert all(any(ipaddress.ip_address(address) in n for n in networks)
                       for address in addresses), 'Host interface address missing from denial'
            await proxy.listen(str(path))
            header, reader, writer = await tunnel(path, 'www.microsoft.com')
            clients.append(writer)
            assert header.startswith(b'HTTP/1.1 200 '), 'Ordinary HTTPS unavailable'
            await writer.start_tls(ssl.create_default_context(), server_hostname='www.microsoft.com',
                                   ssl_handshake_timeout=10)
            writer.write(b'HEAD / HTTP/1.1\r\nHost: www.microsoft.com\r\nConnection: close\r\n\r\n')
            await writer.drain()
            assert (await asyncio.wait_for(reader.read(1024), 10)).startswith(b'HTTP/1.1 ')
            writer.close()
            await writer.wait_closed()
            print('PASS: actual host interfaces discovered; ordinary public TLS certificate verified')

            header, reader, writer = await tunnel(path, 'www.microsoft.com')
            clients.append(writer)
            assert header.startswith(b'HTTP/1.1 200 '), 'Live CONNECT unavailable'
            # Trusted test-side reclassification only. Production hosts are fixed
            # by config and every refresh resolves all of them together.
            policy.hosts = ('localhost', 'www.microsoft.com')
            assert await policy.refresh(), 'Public infrastructure discovery failed'
            assert await asyncio.wait_for(reader.read(), 2) == b'', 'Old tunnel remained open'
            _, networks = policy.snapshot()
            public = []
            for network in networks:
                try:
                    public.append(str(public_address(str(network.network_address), ())))
                except Denied:
                    continue
            assert public, 'Public ingress fixture had no public address'
            for host in ('www.microsoft.com', *public):
                header, _, writer = await tunnel(path, host)
                clients.append(writer)
                require_denied(header)
                writer.close()
                await writer.wait_closed()
            families = {version: sum(ipaddress.ip_address(a).version == version for a in public)
                        for version in (4, 6)}
            print('PASS: actual public ingress DNS/literals denied (' + str(families[4]) +
                  ' IPv4, ' + str(families[6]) + ' IPv6); existing CONNECT closed on refresh')

            # The same assertion must fail on the same reachable public endpoint
            # when the host policy is omitted. No TLS interception or DNS fixture.
            await control.listen(str(control_path))
            header, _, writer = await tunnel(control_path, 'www.microsoft.com')
            clients.append(writer)
            try:
                require_denied(header)
            except AssertionError:
                assert header.startswith(b'HTTP/1.1 200 '), 'Control failed for another reason'
            else:
                raise AssertionError('Negative control did not fail the denial assertion')
            print('PASS: removing infrastructure policy fails the same live denial assertion')
        finally:
            policy.invalidate()
            await proxy.revoke()
            await control.revoke()
            for writer in clients:
                writer.close()
                await writer.wait_closed()


if __name__ == '__main__':
    asyncio.run(verify())
