"""Real lifecycle broker, disclosed metadata-only runtime stand-in; no engine/DB."""
import asyncio
import json
import os
from pathlib import Path
import signal
import sys

from broker import Broker


class RuntimeFixture:
    def __init__(self, record):
        self.record = record

    async def operation(self, operation, runtime_id, generation):
        with self.record.open('a') as target:
            target.write(json.dumps([operation, runtime_id, generation]) + '\n')

    async def allocate(self, runtime_id, generation):
        await self.operation('allocate', runtime_id, generation)

    async def remove(self, runtime_id, generation):
        await self.operation('remove', runtime_id, generation)

    async def close(self):
        pass


async def main():
    path = Path(sys.argv[1])
    runtime = RuntimeFixture(path.parent / 'operations.jsonl')
    broker = Broker(runtime, allowed_uid=int(sys.argv[2]), socket_gid=os.getgid())
    stopped = asyncio.Event()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stopped.set)
    try:
        await broker.listen(path)
        print('READY', flush=True)
        await stopped.wait()
    finally:
        await broker.close()


asyncio.run(main())
