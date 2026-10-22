"""Host-side composition of durable inventory, per-runtime egress and Podman.

No viewer/collector is exposed here yet. The service transport/authentication and
browser image are separate delivery requirements before enabling managed setup.
"""
import asyncio
import os
import stat
from pathlib import Path

from egress import Egress
from lifecycle import Unavailable, validate_reference


async def complete_engine(operation, runtime_id):
    # Cancelling a to_thread await does not stop Podman. Retain the inventory
    # lock until the external operation finishes, including cancelled requests.
    task = asyncio.create_task(asyncio.to_thread(operation, runtime_id))
    cancelled = None
    while True:
        try:
            result = await asyncio.shield(task)
            break
        except asyncio.CancelledError as error:
            if task.done():
                raise
            cancelled = error
    if cancelled:
        raise cancelled
    return result


class Runtime:
    def __init__(self, *, inventory, engine, transport_root, denied_networks, infrastructure=None):
        self.inventory = inventory
        self.engine = engine
        self.transport_root = Path(transport_root)
        self.denied_networks = tuple(denied_networks)
        self.infrastructure = infrastructure
        self.proxies = {}
        self.locks = {}
        self.closed = False

    def lock(self, runtime_id, generation):
        validate_reference(runtime_id, generation)
        return self.locks.setdefault(runtime_id, asyncio.Lock())

    async def allocate(self, runtime_id, generation):
        if self.closed:
            raise Unavailable('Runtime stopping')
        async with self.lock(runtime_id, generation):
            if self.closed:
                raise Unavailable('Runtime stopping')
            with self.inventory.allocating(runtime_id, generation):
                if runtime_id not in self.proxies:
                    folder = self.transport_root / runtime_id
                    folder.mkdir(mode=0o700, exist_ok=True)
                    info = folder.lstat()
                    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or
                            stat.S_IMODE(info.st_mode) != 0o700):
                        raise Unavailable('Private runtime transport required')
                    path = folder / 'connect.sock'
                    if path.exists():
                        if not stat.S_ISSOCK(path.lstat().st_mode):
                            raise Unavailable('Invalid runtime transport')
                        path.unlink()
                    proxy = Egress(self.denied_networks, infrastructure=self.infrastructure)
                    await proxy.listen(str(path))
                    os.chmod(path, 0o600)
                    self.proxies[runtime_id] = proxy
                try:
                    await complete_engine(self.engine.create, runtime_id)
                except BaseException:
                    failed_proxy = self.proxies.pop(runtime_id, None)
                    if failed_proxy:
                        await failed_proxy.revoke()
                    raise

    async def remove(self, runtime_id, generation):
        async with self.lock(runtime_id, generation):
            # Persist revocation before closing the socket or touching Podman.
            # A crash from this point leaves a tombstone that blocks allocation.
            with self.inventory.removing(runtime_id, generation):
                proxy = self.proxies.pop(runtime_id, None)
                if proxy:
                    await proxy.revoke()
                await complete_engine(self.engine.remove, runtime_id)
                folder = self.transport_root / runtime_id
                if folder.exists():
                    path = folder / 'connect.sock'
                    if path.exists():
                        path.unlink()
                    folder.rmdir()

    async def close(self):
        # Graceful host-service shutdown closes tunnels but preserves profiles.
        # Only remove() may acknowledge profile deletion to the database worker.
        self.closed = True
        async def close_one(key, lock):
            async with lock:
                proxy = self.proxies.pop(key, None)
                if proxy:
                    await proxy.revoke()
        await asyncio.gather(*(close_one(key, lock) for key, lock in tuple(self.locks.items())))
