import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import proxy
from egress import Egress


class ContainerRelay(unittest.IsolatedAsyncioTestCase):
    async def test_loopback_relay_handler_forwards_to_host_policy(self):
        # Exercise the container handler through a Unix frontend so this unit
        # test needs no TCP port. The installed runner's TCP listener is pending.
        with tempfile.TemporaryDirectory(prefix='moss-relay-test-') as directory:
            backend = str(Path(directory) / 'host.sock')
            frontend = str(Path(directory) / 'container.sock')
            policy = Egress(())
            await policy.listen(backend)
            server = await asyncio.start_unix_server(proxy.handle, frontend)
            writer = None
            try:
                with patch.object(proxy, 'CONNECT_SOCKET', backend):
                    reader, writer = await asyncio.open_unix_connection(frontend)
                    writer.write(b'CONNECT 169.254.169.254:443 HTTP/1.1\r\n\r\n')
                    await writer.drain()
                    self.assertIn(b'403 Forbidden', await asyncio.wait_for(reader.read(), 2))
            finally:
                if writer:
                    writer.close()
                    await writer.wait_closed()
                await policy.revoke()
                server.close()
                await server.wait_closed()


if __name__ == '__main__':
    unittest.main()
