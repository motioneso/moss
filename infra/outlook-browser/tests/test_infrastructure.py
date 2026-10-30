import asyncio
import ipaddress
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from egress import Denied, Egress, public_address
from infrastructure import InfrastructurePolicy, infrastructure_addresses


class Discovery(unittest.IsolatedAsyncioTestCase):
    async def test_interfaces_and_every_ingress_answer_are_included(self):
        loop = asyncio.get_running_loop()
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443)),
                   (socket.AF_INET6, socket.SOCK_STREAM, 6, '', ('2606:4700::1111', 443, 0, 0))]
        with patch('infrastructure.interface_addresses', AsyncMock(return_value={'8.8.8.8'})), \
                patch.object(loop, 'getaddrinfo', AsyncMock(return_value=answers)) as lookup:
            self.assertEqual(await infrastructure_addresses(('host.example.test', 'app.example.test')),
                             {'8.8.8.8', '93.184.216.34', '2606:4700::1111'})
            self.assertEqual({call.args[0] for call in lookup.await_args_list},
                             {'host.example.test', 'app.example.test'})

    async def test_partial_or_oversized_dns_failure_never_publishes(self):
        policy = InfrastructurePolicy((), ['app.example.test'])
        self.addCleanup(policy.invalidate)
        loop = asyncio.get_running_loop()
        for answers in ([], [(socket.AF_INET, 1, 6, '', ('8.8.8.8', 443))] * 65):
            with patch('infrastructure.interface_addresses', AsyncMock(return_value={'8.8.8.8'})), \
                    patch.object(loop, 'getaddrinfo', AsyncMock(return_value=answers)):
                self.assertFalse(await policy.refresh())
                with self.assertRaises(Denied):
                    policy.snapshot()


class Policy(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.policy = InfrastructurePolicy(('93.184.217.0/24',), ['app.example.test'])

    async def asyncTearDown(self):
        self.policy.invalidate()

    async def refresh(self, addresses):
        with patch('infrastructure.infrastructure_addresses', AsyncMock(return_value=addresses)):
            self.assertTrue(await self.policy.refresh())

    async def test_new_policy_and_expired_policy_are_unavailable(self):
        with self.assertRaises(Denied):
            self.policy.snapshot()
        await self.refresh({'93.184.216.34'})
        self.policy.deadline = asyncio.get_running_loop().time() - 1
        with self.assertRaises(Denied):
            self.policy.snapshot()

    async def test_rotating_dns_retains_old_addresses_and_static_networks(self):
        await self.refresh({'93.184.216.34', '2606:4700::1111'})
        generation, _ = self.policy.snapshot()
        await self.refresh({'8.8.8.8'})
        with self.assertRaises(Denied):
            self.policy.check(generation)
        _, networks = self.policy.snapshot()
        for address in ('93.184.216.34', '2606:4700::1111', '8.8.8.8', '93.184.217.1'):
            with self.subTest(address=address), self.assertRaises(Denied):
                public_address(address, networks)
        self.assertEqual(str(public_address('1.1.1.1', networks)), '1.1.1.1')

    async def test_failure_blocks_until_a_complete_refresh_recovers(self):
        await self.refresh({'93.184.216.34'})
        with patch('infrastructure.infrastructure_addresses', AsyncMock(side_effect=OSError())):
            self.assertFalse(await self.policy.refresh())
        with self.assertRaises(Denied):
            self.policy.snapshot()
        await self.refresh({'8.8.8.8'})
        self.policy.snapshot()

    async def test_address_history_exhaustion_fails_closed(self):
        addresses = {str(ipaddress.IPv4Address(int(ipaddress.IPv4Address('11.0.0.0')) + i))
                     for i in range(4097)}
        with patch('infrastructure.infrastructure_addresses', AsyncMock(return_value=addresses)):
            self.assertFalse(await self.policy.refresh())
        with self.assertRaises(Denied):
            self.policy.snapshot()

    async def test_background_loop_refreshes_and_invalidates_on_exit(self):
        await self.refresh({'93.184.216.34'})
        refreshed = asyncio.Event()
        real_refresh = self.policy.refresh
        async def refresh():
            result = await real_refresh()
            refreshed.set()
            return result
        # Keep the real scheduling loop, replacing only its 30-second wait.
        sleeps = AsyncMock(side_effect=[None, asyncio.CancelledError()])
        with patch('infrastructure.asyncio.sleep', sleeps), \
                patch('infrastructure.infrastructure_addresses', AsyncMock(return_value={'8.8.8.8'})), \
                patch.object(self.policy, 'refresh', side_effect=refresh):
            with self.assertRaises(asyncio.CancelledError):
                await self.policy.run()
        self.assertTrue(refreshed.is_set())
        sleeps.assert_any_await(30)
        with self.assertRaises(Denied):
            self.policy.snapshot()


class LiveTunnels(unittest.IsolatedAsyncioTestCase):
    """Real Unix proxy and echo sockets; DNS and the external TCP dial are fixtures."""

    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='moss-infrastructure-')
        root = Path(self.directory.name)
        self.policy = InfrastructurePolicy((), ['app.example.test'])
        self.proxy = Egress((), infrastructure=self.policy)
        self.path = str(root / 'connect.sock')
        self.echo_path = str(root / 'echo.sock')
        self.echo_writers = set()
        async def echo(reader, writer):
            self.echo_writers.add(writer)
            try:
                while data := await reader.read(65536):
                    writer.write(data)
                    await writer.drain()
            finally:
                writer.close()
                self.echo_writers.discard(writer)
        self.server = await asyncio.start_unix_server(echo, self.echo_path)
        await self.proxy.listen(self.path)
        self.clients = []
        await self.refresh({'8.8.8.8'})

    async def asyncTearDown(self):
        self.policy.invalidate()
        await self.proxy.revoke()
        for writer in self.clients:
            writer.close()
            await writer.wait_closed()
        for writer in tuple(self.echo_writers):
            writer.close()
            await writer.wait_closed()
        self.server.close()
        await self.server.wait_closed()
        self.directory.cleanup()

    async def refresh(self, addresses):
        with patch('infrastructure.infrastructure_addresses', AsyncMock(return_value=addresses)):
            self.assertTrue(await self.policy.refresh())

    async def request(self, host='federated.example.test'):
        reader, writer = await asyncio.open_unix_connection(self.path)
        self.clients.append(writer)
        writer.write(f'CONNECT {host}:443 HTTP/1.1\r\n\r\n'.encode())
        await writer.drain()
        return reader, writer

    async def dial(self, *args, **kwargs):
        return await asyncio.open_unix_connection(self.echo_path)

    def lookup(self):
        return patch.object(asyncio.get_running_loop(), 'getaddrinfo', AsyncMock(return_value=[
            (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))]))

    async def open_tunnel(self):
        reader, writer = await self.request()
        self.assertIn(b'200 Connection Established', await asyncio.wait_for(
            reader.readuntil(b'\r\n\r\n'), 2))
        writer.write(b'probe')
        await writer.drain()
        self.assertEqual(await asyncio.wait_for(reader.readexactly(5), 2), b'probe')
        return reader

    async def assert_closed(self, reader):
        # Bound closure observation so guard-removal controls fail by assertion.
        reading = asyncio.create_task(reader.read())
        done, _ = await asyncio.wait((reading,), timeout=0.15)
        if not done:
            reading.cancel()
            await asyncio.gather(reading, return_exceptions=True)
        self.assertTrue(done, 'Existing tunnel survived infrastructure invalidation')
        self.assertEqual(reading.result(), b'')

    async def test_refresh_denies_new_address_and_closes_existing_tunnel(self):
        with self.lookup(), patch('egress.asyncio.open_connection', side_effect=self.dial) as dial:
            reader = await self.open_tunnel()
            await self.refresh({'93.184.216.34'})
            await self.assert_closed(reader)
            dial.reset_mock()
            reader, _ = await self.request()
            self.assertIn(b'403 Forbidden', await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 2))
            dial.assert_not_awaited()

    async def test_configured_hostname_denied_between_dns_refreshes(self):
        with self.lookup(), patch('egress.asyncio.open_connection', side_effect=self.dial) as dial:
            reader, _ = await self.request('APP.EXAMPLE.TEST')
            self.assertIn(b'403 Forbidden', await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 2))
            dial.assert_not_awaited()

    async def test_public_ipv6_ingress_literal_denied_before_dial(self):
        await self.refresh({'2606:4700::1111'})
        with patch('egress.asyncio.open_connection', AsyncMock(side_effect=OSError())) as dial:
            reader, _ = await self.request('[2606:4700::1111]')
            self.assertIn(b'403 Forbidden', await asyncio.wait_for(reader.read(), 2))
            dial.assert_not_awaited()

    async def test_failed_refresh_closes_tunnel_and_refuses_new_connections(self):
        with self.lookup(), patch('egress.asyncio.open_connection', side_effect=self.dial) as dial:
            reader = await self.open_tunnel()
            with patch('infrastructure.infrastructure_addresses', AsyncMock(side_effect=OSError())):
                self.assertFalse(await self.policy.refresh())
            await self.assert_closed(reader)
            dial.reset_mock()
            reader, _ = await self.request()
            self.assertIn(b'403 Forbidden', await asyncio.wait_for(reader.read(), 2))
            dial.assert_not_awaited()

    async def test_expiry_timer_closes_existing_tunnel_without_new_request(self):
        with self.lookup(), patch('egress.asyncio.open_connection', side_effect=self.dial):
            reader = await self.open_tunnel()
            # Advance only the clock observed by a real refresh. call_at then
            # schedules the actual 60-second expiry into the real loop's past.
            loop = asyncio.get_running_loop()
            now = loop.time()
            with patch.object(loop, 'time', return_value=now - 61):
                await self.refresh({'8.8.8.8'})
            await self.assert_closed(reader)
            with self.assertRaises(Denied):
                self.policy.snapshot()

    async def test_unchanged_refresh_preserves_tunnel(self):
        with self.lookup(), patch('egress.asyncio.open_connection', side_effect=self.dial):
            reader = await self.open_tunnel()
            generation, _ = self.policy.snapshot()
            await self.refresh({'8.8.8.8'})
            self.policy.check(generation)
            writer = self.clients[-1]
            writer.write(b'again')
            await writer.drain()
            self.assertEqual(await asyncio.wait_for(reader.readexactly(5), 2), b'again')

    async def test_refresh_during_dns_cannot_dial_a_newly_denied_address(self):
        async def resolve(*args):
            await self.refresh({'93.184.216.34'})
            return ('93.184.216.34',)
        # Suppress proactive closure to independently exercise the generation
        # barrier. Other tests require actual cancellation and socket closure.
        with patch('egress.resolve_public', side_effect=resolve), \
                patch.object(self.proxy, 'close_connections'), \
                patch('egress.asyncio.open_connection', side_effect=self.dial) as dial:
            reader, _ = await self.request()
            await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 2)
            dial.assert_not_awaited()

    async def test_refresh_during_dial_cannot_acknowledge_stale_connection(self):
        async def dial(*args, **kwargs):
            result = await self.dial()
            await self.refresh({'93.184.216.34'})
            return result
        with self.lookup(), patch.object(self.proxy, 'close_connections'), \
                patch('egress.asyncio.open_connection', side_effect=dial) as opened:
            reader, _ = await self.request()
            response = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 2)
            self.assertNotIn(b'200 Connection Established', response)
            opened.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
