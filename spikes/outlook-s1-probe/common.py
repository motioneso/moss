"""Shared paths and a minimal DevTools-over-pipe client for the S1 probe."""
import asyncio
import json
import os
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'infra' / 'outlook-browser'))

STATE = Path(os.environ.get('S1_STATE', Path.home() / '.local/share/moss-outlook-s1'))
TRANSPORT = STATE / 'transport'
CTL = STATE / 'ctl'
LOG = STATE / 'results.log'
NAME = 'moss-outlook-s1'
VOLUME = NAME + '-profile'
IMAGE = 'localhost/moss-outlook-s1:probe'


def record(line):
    """Append a content-free line: time, pass/fail, error code."""
    from datetime import datetime, timezone
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(LOG, 'a') as handle:
        handle.write(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ ') + line + '\n')


class Cdp:
    """Browser-level DevTools over the container's Unix socket. NUL-delimited JSON."""

    def __init__(self):
        self.next_id = 0
        self.waiting = {}

    async def open(self):
        self.reader, self.writer = await asyncio.open_unix_connection(
            str(CTL / 'cdp.sock'), limit=1 << 26)
        self.task = asyncio.create_task(self.read())

    async def read(self):
        try:
            while True:
                raw = await self.reader.readuntil(b'\0')
                message = json.loads(raw[:-1])
                future = self.waiting.pop(message.get('id'), None)
                if future and not future.done():
                    future.set_result(message)
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        for future in self.waiting.values():
            if not future.done():
                future.set_exception(ConnectionError('closed'))

    async def call(self, method, params=None, session=None, timeout=20):
        self.next_id += 1
        message = {'id': self.next_id, 'method': method, 'params': params or {}}
        if session:
            message['sessionId'] = session
        future = asyncio.get_running_loop().create_future()
        self.waiting[self.next_id] = future
        self.writer.write(json.dumps(message).encode() + b'\0')
        await self.writer.drain()
        result = await asyncio.wait_for(future, timeout)
        if 'error' in result:
            raise RuntimeError(result['error'].get('message', 'cdp error'))
        return result['result']

    async def page_session(self):
        targets = (await self.call('Target.getTargets'))['targetInfos']
        page = next(t for t in targets if t['type'] == 'page')
        attached = await self.call('Target.attachToTarget',
                                   {'targetId': page['targetId'], 'flatten': True})
        return page['targetId'], attached['sessionId']

    def close(self):
        self.task.cancel()
        self.writer.close()
