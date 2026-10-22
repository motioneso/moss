import asyncio
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from lifecycle import Unavailable
from service import configuration, serve


class TrustedConfiguration(unittest.TestCase):
    def test_config_requires_trusted_file_absolute_paths_and_network_policy(self):
        with tempfile.TemporaryDirectory(prefix='moss-config-test-') as directory:
            root = Path(directory)
            config = {'state': str(root / 'state'), 'transport': str(root / 'transport'),
                      'socket': str(root / 'socket'), 'seccomp': str(root / 'seccomp'),
                      'allowed_uid': os.getuid(), 'socket_gid': os.getgid(),
                      'image': 'sha256:' + 'a' * 64, 'denied_networks': ['192.0.2.0/24'],
                      'infrastructure_hosts': ['localhost']}
            path = root / 'config.json'
            path.write_text(json.dumps(config))
            path.chmod(0o600)
            self.assertEqual(configuration(path), config)
            path.chmod(0o666)
            with self.assertRaises(Unavailable):
                configuration(path)
            path.chmod(0o600)
            for change in ({'socket': 'relative'}, {'denied_networks': []},
                           {'denied_networks': ['invalid']}, {'allowed_uid': True},
                           {'infrastructure_hosts': []}, {'infrastructure_hosts': ['bad..test']},
                           {'infrastructure_hosts': ['https://ingress.example.test']},
                           {'arbitrary': 'command'}):
                path.write_text(json.dumps({**config, **change}))
                with self.assertRaises(ValueError):
                    configuration(path)
            link = root / 'link.json'
            link.symlink_to(path)
            with self.assertRaises(OSError):
                configuration(link)


class ServicePolicy(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.previous_umask = os.umask(0o077)
        self.directory = tempfile.TemporaryDirectory(prefix='moss-service-policy-')
        self.root = Path(self.directory.name)
        self.config = {'state': str(self.root / 'state'), 'transport': str(self.root / 'transport'),
                       'socket': str(self.root / 'broker.sock'), 'image': 'sha256:' + 'a' * 64,
                       'seccomp': str(self.root / 'seccomp.json'), 'allowed_uid': os.getuid(),
                       'socket_gid': os.getgid(), 'denied_networks': ['192.0.2.0/24'],
                       'infrastructure_hosts': ['app.example.test']}

    async def asyncTearDown(self):
        os.umask(self.previous_umask)
        self.directory.cleanup()

    async def test_failed_initial_discovery_precedes_engine_and_broker(self):
        with patch('service.InfrastructurePolicy.refresh', AsyncMock(return_value=False)), \
                patch('service.Podman', side_effect=AssertionError('Engine reached before discovery')) as engine, \
                patch('service.Broker') as broker:
            with self.assertRaises(Unavailable):
                await serve(self.config)
            engine.assert_not_called()
            broker.assert_not_called()

    async def test_service_binds_discovered_policy_through_runtime_to_proxy(self):
        loop = asyncio.get_running_loop()
        engine = Mock()
        runtime_id = str(uuid.uuid4())
        broker = Mock(recover=AsyncMock(), close=AsyncMock())
        real_umask = os.umask(0o077)
        try:
            with patch.object(loop, 'add_signal_handler') as signals, \
                    patch('service.InfrastructurePolicy.run', AsyncMock()) as refreshing, \
                    patch('service.Podman', return_value=engine), \
                    patch('infrastructure.infrastructure_addresses',
                          AsyncMock(return_value={'93.184.216.34'})), \
                    patch('egress.asyncio.open_connection', AsyncMock(side_effect=OSError())) as dial:
                def build(runtime, **kwargs):
                    async def listen(path):
                        try:
                            await runtime.allocate(runtime_id, 1)
                            reader, writer = await asyncio.open_unix_connection(
                                str(self.root / 'transport' / runtime_id / 'connect.sock'))
                            try:
                                writer.write(b'CONNECT 93.184.216.34:443 HTTP/1.1\r\n\r\n')
                                await writer.drain()
                                self.assertIn(b'403 Forbidden', await asyncio.wait_for(reader.read(), 2))
                                dial.assert_not_awaited()
                            finally:
                                writer.close()
                                await writer.wait_closed()
                        finally:
                            await runtime.close()
                            signals.call_args.args[1]()
                    broker.listen = AsyncMock(side_effect=listen)
                    return broker
                with patch('service.Broker', side_effect=build):
                    await serve(self.config)
                broker.recover.assert_awaited_once()
                broker.close.assert_awaited_once()
                refreshing.assert_awaited_once()
                engine.create.assert_called_once_with(runtime_id)
        finally:
            os.umask(real_umask)


if __name__ == '__main__':
    unittest.main()
