"""Host lifecycle service entrypoint; trusted installation configuration only.

Not an installer or a complete browser service. Viewer/collector and maintained
browser image remain separate release requirements. No config/request logging.
"""
import argparse
import asyncio
import ipaddress
import json
import os
import signal
import stat
from pathlib import Path

from broker import Broker
from lifecycle import Inventory, Unavailable
from podman import Podman
from runtime import Runtime
from service_lock import ServiceLock


def configuration(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid()) or
                info.st_mode & 0o022 or info.st_size > 8192):
            raise Unavailable('Trusted service configuration required')
        with os.fdopen(descriptor, closefd=False) as source:
            config = json.load(source)
    finally:
        os.close(descriptor)
    required = {'state', 'transport', 'socket', 'image', 'seccomp',
                'allowed_uid', 'socket_gid', 'denied_networks'}
    if type(config) is not dict or set(config) != required:
        raise ValueError('Invalid service configuration')
    for key in ('state', 'transport', 'socket', 'seccomp'):
        if type(config[key]) is not str or not Path(config[key]).is_absolute():
            raise ValueError('Absolute installation path required')
    for key in ('allowed_uid', 'socket_gid'):
        if type(config[key]) is not int or config[key] < 0:
            raise ValueError('Invalid service identity')
    if (type(config['denied_networks']) is not list or not config['denied_networks'] or
            any(type(network) is not str for network in config['denied_networks'])):
        raise ValueError('Infrastructure network denial configuration required')
    for network in config['denied_networks']:
        ipaddress.ip_network(network)
    return config


async def serve(config):
    os.umask(0o077)
    inventory = Inventory(config['state'])
    lock = ServiceLock(inventory.directory)
    broker = None
    try:
        transport = Path(config['transport'])
        transport.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = transport.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or
                stat.S_IMODE(info.st_mode) != 0o700):
            raise Unavailable('Private transport directory required')
        engine = Podman(image=config['image'], seccomp=config['seccomp'],
                        transport_root=transport, service_lock=lock)
        runtime = Runtime(inventory=inventory, engine=engine, transport_root=transport,
                          denied_networks=config['denied_networks'])
        broker = Broker(runtime, allowed_uid=config['allowed_uid'], socket_gid=config['socket_gid'])
        stopped = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stopped.set)
        await broker.recover()
        if not stopped.is_set():
            await broker.listen(Path(config['socket']))
            await stopped.wait()
    finally:
        if broker:
            await broker.close()
        lock.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, type=Path)
    arguments = parser.parse_args()
    try:
        asyncio.run(serve(configuration(arguments.config)))
    except Exception:
        raise SystemExit('Outlook lifecycle service unavailable') from None
