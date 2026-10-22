import asyncio
import os
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock

from lifecycle import Inventory, Unavailable
from runtime import Runtime


class RuntimeComposition(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='moss-runtime-test-')
        self.root = Path(self.directory.name)
        self.transport = self.root / 'transport'
        self.transport.mkdir(mode=0o700)
        self.inventory = Inventory(self.root / 'inventory')
        self.engine = Mock()
        self.runtime = Runtime(inventory=self.inventory, engine=self.engine,
                               transport_root=self.transport, denied_networks=())
        self.key = str(uuid.uuid4())

    async def asyncTearDown(self):
        await self.runtime.close()
        self.directory.cleanup()

    async def test_removal_is_durable_before_engine_and_closes_egress(self):
        await self.runtime.allocate(self.key, 1)
        socket_path = self.transport / self.key / 'connect.sock'
        self.assertEqual(os.stat(socket_path).st_mode & 0o777, 0o600)
        proxy = self.runtime.proxies[self.key]
        def remove(key):
            self.assertEqual(self.inventory.get(key), (2, 'removing'))
            self.assertTrue(proxy.revoked)
        self.engine.remove.side_effect = remove
        await self.runtime.remove(self.key, 2)
        self.assertEqual(self.inventory.get(self.key), (2, 'removed'))
        self.assertFalse(socket_path.parent.exists())
        with self.assertRaises(Unavailable):
            await self.runtime.allocate(self.key, 3)
        self.engine.create.assert_called_once_with(self.key)

    async def test_failed_cleanup_cannot_reopen_network_and_retries(self):
        await self.runtime.allocate(self.key, 1)
        proxy = self.runtime.proxies[self.key]
        self.engine.remove.side_effect = OSError('fixture failure')
        with self.assertRaises(OSError):
            await self.runtime.remove(self.key, 2)
        self.assertTrue(proxy.revoked)
        self.assertEqual(self.inventory.get(self.key), (2, 'removing'))
        with self.assertRaises(Unavailable):
            await self.runtime.allocate(self.key, 2)
        self.engine.remove.side_effect = None
        await self.runtime.remove(self.key, 2)
        self.assertEqual(self.inventory.get(self.key), (2, 'removed'))

    async def test_shutdown_preserves_profile_and_restart_reopens_socket(self):
        await self.runtime.allocate(self.key, 1)
        await self.runtime.close()
        self.engine.remove.assert_not_called()
        self.assertEqual(self.inventory.get(self.key), (1, 'ready'))
        with self.assertRaises(Unavailable):
            await self.runtime.allocate(self.key, 1)
        self.runtime = Runtime(inventory=self.inventory, engine=self.engine,
                               transport_root=self.transport, denied_networks=())
        await self.runtime.allocate(self.key, 1)
        reader, writer = await asyncio.open_unix_connection(
            str(self.transport / self.key / 'connect.sock'))
        writer.write(b'CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n')
        await writer.drain()
        self.assertIn(b'403 Forbidden', await reader.read())
        writer.close()
        await writer.wait_closed()

    async def test_cancelled_allocate_cannot_finish_after_cleanup_ack(self):
        started, release, created = threading.Event(), threading.Event(), threading.Event()
        def create(_):
            started.set()
            if not release.wait(2):
                raise TimeoutError()
            created.set()
        def remove(_):
            self.assertTrue(created.is_set())
        self.engine.create.side_effect = create
        self.engine.remove.side_effect = remove
        allocating = asyncio.create_task(self.runtime.allocate(self.key, 1))
        removing = None
        try:
            self.assertTrue(await asyncio.to_thread(started.wait, 2))
            allocating.cancel()
            removing = asyncio.create_task(self.runtime.remove(self.key, 2))
            done, _ = await asyncio.wait((allocating, removing), timeout=0.05,
                                         return_when=asyncio.FIRST_COMPLETED)
            self.assertEqual(done, set())
            self.engine.remove.assert_not_called()
        finally:
            release.set()
            results = await asyncio.wait_for(asyncio.gather(
                allocating, *([removing] if removing else []), return_exceptions=True), 2)
        self.assertIsInstance(results[0], asyncio.CancelledError)
        self.assertEqual(self.inventory.get(self.key), (2, 'removed'))


if __name__ == '__main__':
    unittest.main()
