import asyncio
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, Mock

from broker import Broker
from lifecycle import Inventory, Unavailable
from runtime import Runtime


class LifecycleProtocol(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='moss-broker-test-')
        self.root = Path(self.directory.name)
        self.folder = self.root / 'socket'
        self.folder.mkdir(mode=0o750)
        self.path = self.folder / 'broker.sock'
        self.runtime = Mock(allocate=AsyncMock(), remove=AsyncMock(), close=AsyncMock())
        self.broker = Broker(self.runtime, allowed_uid=os.getuid(), socket_gid=os.getgid())
        await self.broker.listen(self.path)
        self.key = str(uuid.uuid4())

    async def asyncTearDown(self):
        await self.broker.close()
        self.directory.cleanup()

    async def request(self, request):
        reader, writer = await asyncio.open_unix_connection(str(self.path))
        try:
            writer.write(request)
            await writer.drain()
            try:
                return await asyncio.wait_for(reader.readline(), 2)
            except ConnectionResetError:
                return b''
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except ConnectionResetError:
                pass

    async def test_fixed_operations_and_private_socket(self):
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o660)
        for operation in ('allocate', 'remove'):
            request = {'operation': operation, 'runtimeId': self.key, 'generation': 2}
            self.assertEqual(await self.request(json.dumps(request).encode() + b'\n'),
                             b'{"ok":true}\n')
            getattr(self.runtime, operation).assert_awaited_once_with(self.key, 2)

    async def test_peer_uid_denied_before_runtime_access(self):
        self.broker.allowed_uid = os.getuid() + 1
        request = {'operation': 'allocate', 'runtimeId': self.key, 'generation': 1}
        self.assertIn(await self.request(json.dumps(request).encode() + b'\n'),
                      (b'{"ok":false}\n', b''))
        self.runtime.allocate.assert_not_awaited()

    async def test_malformed_oversized_or_arbitrary_operations_are_rejected(self):
        requests = [b'{}\n', b'[]\n', b'x' * 2048 + b'\n']
        valid = {'operation': 'allocate', 'runtimeId': self.key, 'generation': 1}
        for changed in ({'operation': 'shell'}, {'generation': True},
                        {'runtimeId': '../../profile'}, {'url': 'https://example.com'},
                        {'operation': ['allocate']}):
            requests.append(json.dumps({**valid, **changed}).encode() + b'\n')
        for request in requests:
            self.assertEqual(await self.request(request), b'{"ok":false}\n')
        self.runtime.allocate.assert_not_awaited()
        self.runtime.remove.assert_not_awaited()

    async def test_engine_errors_are_not_returned(self):
        self.runtime.allocate.side_effect = RuntimeError('private fixture diagnostic')
        request = {'operation': 'allocate', 'runtimeId': self.key, 'generation': 1}
        self.assertEqual(await self.request(json.dumps(request).encode() + b'\n'),
                         b'{"ok":false}\n')

    async def test_unsafe_socket_directory_and_symlink_are_rejected(self):
        await self.broker.close()
        self.folder.chmod(0o770)
        with self.assertRaises(Unavailable):
            await self.broker.listen(self.path)
        self.folder.chmod(0o750)
        self.path.symlink_to(self.root / 'elsewhere')
        with self.assertRaises(Unavailable):
            await self.broker.listen(self.path)
        self.path.unlink()


class StartupRecovery(unittest.IsolatedAsyncioTestCase):
    async def test_one_failed_cleanup_or_restore_does_not_block_other_runtimes(self):
        with tempfile.TemporaryDirectory(prefix='moss-recovery-test-') as directory:
            root = Path(directory)
            inventory = Inventory(root / 'inventory')
            transport = root / 'transport'
            transport.mkdir(mode=0o700)
            ready, failed, removing = [str(uuid.uuid4()) for _ in range(3)]
            inventory.allocate(ready, 1, lambda _: None)
            inventory.allocate(failed, 1, lambda _: None)
            with self.assertRaises(RuntimeError):
                with inventory.removing(removing, 2):
                    raise RuntimeError('simulated interruption')
            engine = Mock()
            def create(key):
                if key == failed:
                    raise OSError('fixture image unavailable')
            engine.create.side_effect = create
            engine.remove.side_effect = OSError('fixture cleanup unavailable')
            runtime = Runtime(inventory=inventory, engine=engine, transport_root=transport,
                              denied_networks=())
            broker = Broker(runtime, allowed_uid=os.getuid(), socket_gid=os.getgid())
            try:
                self.assertEqual(await broker.recover(), 2)
                self.assertEqual(set(runtime.proxies), {ready})
                self.assertEqual(inventory.get(removing), (2, 'removing'))
                with self.assertRaises(Unavailable):
                    await runtime.allocate(removing, 2)
                engine.create.side_effect = None
                engine.remove.side_effect = None
                self.assertEqual(await broker.recover(), 0)
                self.assertEqual(set(runtime.proxies), {ready, failed})
                self.assertEqual(inventory.get(removing), (2, 'removed'))
            finally:
                await broker.close()

    async def test_pending_removal_precedes_profile_recovery_and_preserves_tombstone(self):
        with tempfile.TemporaryDirectory(prefix='moss-recovery-test-') as directory:
            root = Path(directory)
            inventory = Inventory(root / 'inventory')
            transport = root / 'transport'
            transport.mkdir(mode=0o700)
            ready, allocating, removing, removed = [str(uuid.uuid4()) for _ in range(4)]
            inventory.allocate(ready, 1, lambda _: None)
            for key, context in ((allocating, inventory.allocating), (removing, inventory.removing)):
                with self.assertRaises(RuntimeError):
                    with context(key, 2):
                        raise RuntimeError('simulated interruption')
            inventory.remove(removed, 3, lambda _: None)
            operations = []
            engine = Mock()
            engine.create.side_effect = lambda key: operations.append(('create', key))
            engine.remove.side_effect = lambda key: operations.append(('remove', key))
            runtime = Runtime(inventory=inventory, engine=engine, transport_root=transport,
                              denied_networks=())
            broker = Broker(runtime, allowed_uid=os.getuid(), socket_gid=os.getgid())
            try:
                await broker.recover()
                self.assertEqual(operations[0], ('remove', removing))
                self.assertEqual(set(operations[1:]), {('create', ready), ('create', allocating)})
                self.assertEqual(inventory.get(removing), (2, 'removed'))
                self.assertEqual(inventory.get(removed), (3, 'removed'))
                with self.assertRaises(Unavailable):
                    await runtime.allocate(removing, 4)
            finally:
                await broker.close()


if __name__ == '__main__':
    unittest.main()
