"""Private lifecycle protocol. Moss must authenticate/authorize before calling.

Only the configured app/worker UID can connect. Runtime references are not user
credentials. No browser control or generic engine/URL/file operation is exposed.
One bounded JSON line per connection; responses never echo requests or exceptions.
"""
import asyncio
import json
import os
import socket
import stat
import struct

from lifecycle import Unavailable, validate_reference


class Broker:
    def __init__(self, runtime, *, allowed_uid, socket_gid):
        self.runtime = runtime
        self.allowed_uid = allowed_uid
        self.socket_gid = socket_gid
        self.server = None
        self.clients = set()
        self.path = None
        self.closing = False

    async def recover(self):
        # Try removals before restoration. One failed runtime remains pending
        # with egress closed, without taking other owners' profiles offline.
        failures = 0
        for key, generation, state in self.runtime.inventory.pending():
            operation = self.runtime.remove if state == 'removing' else self.runtime.allocate
            try:
                await operation(key, generation)
            except Exception:
                failures += 1
        return failures

    async def listen(self, path):
        info = path.parent.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or
                info.st_gid != self.socket_gid or stat.S_IMODE(info.st_mode) != 0o750):
            raise Unavailable('Private broker socket directory required')
        try:
            existing = path.lstat()
        except FileNotFoundError:
            existing = None
        if existing:
            if not stat.S_ISSOCK(existing.st_mode) or existing.st_uid != os.getuid():
                raise Unavailable('Invalid broker socket')
            path.unlink()
        self.path = path
        self.server = await asyncio.start_unix_server(self.handle, path=str(path), limit=1024)
        os.chown(path, -1, self.socket_gid)
        os.chmod(path, 0o660)

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        if self.closing or len(self.clients) >= 32:
            writer.close()
            await writer.wait_closed()
            return
        self.clients.add(task)
        try:
            response = await self.dispatch(reader, writer)
            writer.write(response)
            await asyncio.wait_for(writer.drain(), 5)
        except (ConnectionError, TimeoutError):
            pass
        finally:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), 5)
            except (ConnectionError, TimeoutError):
                pass
            self.clients.discard(task)

    async def dispatch(self, reader, writer):
        try:
            peer = writer.get_extra_info('socket').getsockopt(
                socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
            _, uid, _ = struct.unpack('3i', peer)
            if uid != self.allowed_uid:
                raise Unavailable('Caller denied')
            line = await asyncio.wait_for(reader.readline(), 5)
            if not line.endswith(b'\n') or len(line) > 1024:
                raise ValueError('Invalid request')
            request = json.loads(line)
            if (type(request) is not dict or
                    set(request) != {'operation', 'runtimeId', 'generation'}):
                raise ValueError('Invalid request')
            validate_reference(request['runtimeId'], request['generation'])
            operations = {'allocate': self.runtime.allocate, 'remove': self.runtime.remove}
            operation = operations.get(request['operation'])
            if operation is None:
                raise ValueError('Invalid operation')
            await operation(request['runtimeId'], request['generation'])
            return b'{"ok":true}\n'
        except asyncio.CancelledError:
            raise
        except Exception:
            # No client-supplied strings, account data or engine diagnostics.
            return b'{"ok":false}\n'

    async def close(self):
        self.closing = True
        if self.server:
            self.server.close()
        clients = tuple(self.clients)
        for task in clients:
            task.cancel()
        await asyncio.gather(*clients, return_exceptions=True)
        await self.runtime.close()
        if self.server:
            await self.server.wait_closed()
        if self.path:
            self.path.unlink(missing_ok=True)
            self.path = None
