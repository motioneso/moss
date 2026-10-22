import asyncio
import ipaddress
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from egress import Denied, Egress, connect_host, public_address, resolve_public


class AddressPolicy(unittest.TestCase):
    def test_special_addresses(self):
        for address in ('0.0.0.0', '10.1.2.3', '100.100.100.200', '127.0.0.1',
                        '169.254.169.254', '172.17.0.1', '192.168.1.1', '192.0.0.9',
                        '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1',
                        '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1',
                        '64:ff9b::7f00:1', '2002:7f00:1::', '2001::1', '2001:db8::1',
                        '3fff::1'):
            with self.subTest(address=address), self.assertRaises(Denied):
                public_address(address, ())

    def test_public_infrastructure_explicitly_denied(self):
        denied = tuple(map(ipaddress.ip_network, ('93.184.216.0/24', '2606:4700::/32')))
        for address in ('93.184.216.34', '2606:4700:4700::1111'):
            with self.subTest(address=address), self.assertRaises(Denied):
                public_address(address, denied)

    def test_ordinary_public_addresses(self):
        for address in ('93.184.216.34', '2606:4700:4700::1111'):
            self.assertEqual(str(public_address(address, ())), address)

    def test_connect_parser(self):
        self.assertEqual(connect_host(b'CONNECT login.example.test:443 HTTP/1.1\r\n'
                                      b'Host: login.example.test:443\r\n\r\n'),
                         'login.example.test')
        self.assertEqual(connect_host(b'CONNECT [2606:4700::1111]:443 HTTP/1.1\r\n\r\n'),
                         '2606:4700::1111')
        for authority in ('https://example.test:443/', 'example.test:80', 'x:443@evil',
                          'user@example.test:443', '[fe80::1%eth0]:443', 'x%00:443',
                          'example.test.:443', '-bad.test:443', 'x..test:443'):
            with self.subTest(authority=authority), self.assertRaises(Denied):
                connect_host(f'CONNECT {authority} HTTP/1.1\r\n\r\n'.encode())
        for extra in ('Transfer-Encoding: chunked', 'Content-Length: 1',
                      'Host: other.test:443', 'Cookie: private', 'X-Header: x',
                      'Host: x:443\r\nHost: x:443', '\tHost: x:443'):
            with self.subTest(extra=extra), self.assertRaises(Denied):
                connect_host(f'CONNECT x:443 HTTP/1.1\r\n{extra}\r\n\r\n'.encode())


class UnixTransport(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='moss-egress-test-')
        self.path = str(Path(self.directory.name) / 'connect.sock')
        self.egress = Egress(('93.184.217.0/24',))
        await self.egress.listen(self.path)
        self.clients = []

    async def asyncTearDown(self):
        await self.egress.revoke()
        for writer in self.clients:
            writer.close()
            await writer.wait_closed()
        self.directory.cleanup()

    async def request(self, host):
        reader, writer = await asyncio.open_unix_connection(self.path)
        self.clients.append(writer)
        writer.write(f'CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\n\r\n'.encode())
        await writer.drain()
        return reader, writer

    async def test_private_literal_never_dials(self):
        with patch('egress.asyncio.open_connection', new_callable=AsyncMock) as dial:
            reader, _ = await self.request('127.0.0.1')
            self.assertIn(b'403 Forbidden', await reader.read())
            dial.assert_not_called()

    async def test_mixed_dns_rejected_before_dial(self):
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (a, 443))
                   for a in ('93.184.216.34', '10.0.0.1')]
        loop = asyncio.get_running_loop()
        with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=answers)), \
                patch('egress.asyncio.open_connection', new_callable=AsyncMock) as dial:
            reader, _ = await self.request('mixed.example.test')
            self.assertIn(b'403 Forbidden', await reader.read())
            dial.assert_not_called()

    async def test_dns_pin_and_bidirectional_tunnel(self):
        # An explicitly disclosed upstream stand-in: real Unix echo transport in
        # place of the external TLS server. Inspect the actual dial arguments.
        async def echo(reader, writer):
            try:
                while data := await reader.read(65536):
                    writer.write(data)
                    await writer.drain()
            finally:
                writer.close()

        echo_path = str(Path(self.directory.name) / 'upstream.sock')
        server = await asyncio.start_unix_server(echo, echo_path)
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))]
        async def dial(*args, **kwargs):
            return await asyncio.open_unix_connection(echo_path)
        loop = asyncio.get_running_loop()
        try:
            with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=answers)) as lookup, \
                    patch('egress.asyncio.open_connection', side_effect=dial) as opened:
                reader, writer = await self.request('federated.example.test')
                self.assertIn(b'200 Connection Established',
                              await reader.readuntil(b'\r\n\r\n'))
                writer.write(b'synthetic TLS bytes')
                await writer.drain()
                self.assertEqual(await reader.readexactly(19), b'synthetic TLS bytes')
                opened.assert_awaited_once_with('93.184.216.34', 443, family=socket.AF_INET)
                lookup.assert_awaited_once()
                await asyncio.wait_for(self.egress.revoke(), 2)
                self.assertEqual(await asyncio.wait_for(reader.read(), 2), b'')
        finally:
            await self.egress.revoke()
            server.close()
            await server.wait_closed()

    async def test_dns_rebinding_next_tunnel_revalidated(self):
        loop = asyncio.get_running_loop()
        public = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))]
        rebound = [(socket.AF_INET6, socket.SOCK_STREAM, 6, '', ('::1', 443, 0, 0))]
        with patch.object(loop, 'getaddrinfo', AsyncMock(side_effect=[public, rebound])):
            self.assertEqual(await resolve_public('rebind.example.test', ()),
                             ('93.184.216.34',))
            with self.assertRaises(Denied):
                await resolve_public('rebind.example.test', ())

    async def test_oversized_header_and_non_connect(self):
        for data in (b'GET https://example.test/ HTTP/1.1\r\n\r\n',
                     b'CONNECT ' + b'a' * 9000 + b':443 HTTP/1.1\r\n\r\n'):
            reader, writer = await asyncio.open_unix_connection(self.path)
            self.clients.append(writer)
            writer.write(data)
            await writer.drain()
            self.assertIn(b'403 Forbidden', await reader.read())


if __name__ == '__main__':
    unittest.main()
