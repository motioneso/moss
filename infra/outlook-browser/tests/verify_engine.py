"""Real Podman inventory/volume proof with a sleeping Python fixture, no browser."""
import asyncio
import tempfile
import uuid
from pathlib import Path

from lifecycle import Inventory, Unavailable
from podman import Podman
from runtime import Runtime
from service_lock import ServiceLock
from verify_network import command


BASE = ('docker.io/library/python@sha256:'
        '884d3f3d9b4ef25b050f984ca8781efd6b0f49312721d2c321536b7cecf1c224')


async def verify():
    tag = 'localhost/moss-outlook-engine-test:' + uuid.uuid4().hex
    image = None
    with tempfile.TemporaryDirectory(prefix='moss-outlook-engine-') as directory:
        root = Path(directory)
        transport = root / 'transport'
        transport.mkdir(mode=0o700)
        inventory = Inventory(root / 'state')
        service_lock = ServiceLock(inventory.directory)
        runtime_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        engine = None
        runtime = None
        try:
            await command('build', '--pull=never', '--tag', tag, '-f', '-', str(root),
                          data=(f'FROM {BASE}\nRUN mkdir /profile && chown 1000:1000 /profile\n'
                                'USER 1000:1000\nCMD ["python3", "-c", '
                                '"import time; time.sleep(3600)"]\n').encode())
            image = (await command('image', 'inspect', '--format', '{{.Id}}', tag)).decode().strip()
            image = 'sha256:' + image.removeprefix('sha256:')
            engine = await asyncio.to_thread(Podman, image=image,
                                             seccomp='/usr/share/containers/seccomp.json',
                                             transport_root=transport, service_lock=service_lock)
            runtime = Runtime(inventory=inventory, engine=engine, transport_root=transport,
                              denied_networks=())
            for runtime_id in runtime_ids:
                await runtime.allocate(runtime_id, 1)
            for index, runtime_id in enumerate(runtime_ids):
                name, _ = engine.names(runtime_id)
                await command('exec', name, 'python3', '-B', '-c',
                              f'from pathlib import Path; '
                              f'Path("/profile/marker").write_text("fixture-{index}")')
            for index, runtime_id in enumerate(runtime_ids):
                name, _ = engine.names(runtime_id)
                # Repeated allocation must restart/reuse this profile, not replace it.
                await runtime.allocate(runtime_id, 1)
                marker = await command('exec', name, 'cat', '/profile/marker')
                assert marker.decode() == f'fixture-{index}'
                assert (await command('inspect', '--format', '{{.HostConfig.NetworkMode}}',
                                      name)).strip() == b'none'
                assert (await command('inspect', '--format', '{{.HostConfig.ReadonlyRootfs}}',
                                      name)).strip() == b'true'
                assert (await command('inspect', '--format', '{{.HostConfig.LogConfig.Type}}',
                                      name)).strip() == b'none'
            first, second = runtime_ids
            await runtime.remove(first, 2)
            name, volume = engine.names(first)
            assert not engine.owned('container', name, first)
            assert not engine.owned('volume', volume, first)
            await runtime.close()
            # Podman must not leave the broker descriptor in a long-lived
            # detached monitor after its CLI has finished.
            service_lock.close()
            service_lock = ServiceLock(inventory.directory)
            engine.service_lock = service_lock
            restarted = Runtime(inventory=Inventory(root / 'state'), engine=engine,
                                transport_root=transport, denied_networks=())
            try:
                await restarted.allocate(first, 3)
            except Unavailable:
                pass
            else:
                raise AssertionError('Removed runtime recreated')
            name, _ = engine.names(second)
            assert (await command('exec', name, 'cat', '/profile/marker')) == b'fixture-1'
            print('PASS: real per-runtime profiles, idempotent allocation, container/profile '
                  'removal and restart tombstone; second runtime unaffected')
        finally:
            if engine:
                engine.service_lock = None
            for runtime_id in runtime_ids:
                if runtime:
                    await runtime.remove(runtime_id, 2)
            if image:
                await command('image', 'rm', tag)
            service_lock.close()


if __name__ == '__main__':
    asyncio.run(verify())
