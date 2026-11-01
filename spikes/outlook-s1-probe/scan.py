"""Hourly probe run. Usage: scan.py RELAY_PORT [learn].

Opens a loopback DevTools endpoint (HTTP discovery plus WebSocket) that relays to the
browser's pipe socket, runs the merged collector against it, then closes the endpoint.
Records only time, pass/fail and error code.
"""
import asyncio
import json
import os
from pathlib import Path
import sys
import time

from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from common import CTL, REPO, STATE, Cdp, record

EXPIRES = STATE / 'expires'
ACCOUNT = STATE / 'account'
PATH = '/devtools/browser/probe'


def respond(body):
    raw = json.dumps(body).encode()
    return Response(200, 'OK', Headers([('Content-Type', 'application/json'),
                                        ('Content-Length', str(len(raw))),
                                        ('Connection', 'close')]), raw)


async def relay_handler(ws):
    reader, writer = await asyncio.open_unix_connection(str(CTL / 'cdp.sock'), limit=1 << 26)

    sessions = set()

    async def down():
        try:
            while True:
                raw = await reader.readuntil(b'\0')
                if b'"Target.attachedToTarget"' in raw:
                    found = json.loads(raw[:-1]).get('params', {}).get('sessionId')
                    if found:
                        sessions.add(found)
                await ws.send(raw[:-1].decode())
        except (asyncio.IncompleteReadError, ConnectionError):
            await ws.close()

    task = asyncio.create_task(down())
    try:
        async for message in ws:
            writer.write((message if isinstance(message, str) else message.decode()).encode() + b'\0')
            await writer.drain()
    finally:
        # The browser has one DevTools connection for its whole life, so each client
        # must leave no auto-attach or page sessions behind for the next one.
        cleanup = [{'id': 900000, 'method': 'Target.setAutoAttach',
                    'params': {'autoAttach': False, 'waitForDebuggerOnStart': False,
                               'flatten': True}}]
        cleanup += [{'id': 900001 + i, 'method': 'Target.detachFromTarget',
                     'params': {'sessionId': sid}} for i, sid in enumerate(sessions)]
        for command in cleanup:
            writer.write(json.dumps(command).encode() + b'\0')
        await writer.drain()
        await asyncio.sleep(0.5)
        task.cancel()
        writer.close()


async def wake_pages():
    # A hidden tab can hang, so reload the calendar page before each run.
    c = Cdp()
    try:
        await c.open()
        for t in (await c.call('Target.getTargets'))['targetInfos']:
            if t['type'] != 'page':
                continue
            sid = (await c.call('Target.attachToTarget',
                                {'targetId': t['targetId'], 'flatten': True}))['sessionId']
            await c.call('Page.navigate', {'url': 'https://outlook.office.com/calendar/view/week'},
                         session=sid, timeout=15)
            await c.call('Target.detachFromTarget', {'sessionId': sid})
        await asyncio.sleep(12)
    except Exception:
        pass
    finally:
        c.close()


async def main():
    port = int(sys.argv[1])
    MODE = sys.argv[2] if len(sys.argv) > 2 else 'scan'
    learn = MODE == 'learn'
    if not learn:
        if EXPIRES.exists() and time.time() > float(EXPIRES.read_text()):
            record('probe window ended, scan skipped')
            return
        lock = STATE / 'viewer.lock'
        if lock.exists():
            try:
                os.kill(int(lock.read_text()), 0)
                record('scan skipped: viewer open')
                return
            except (OSError, ValueError):
                lock.unlink(missing_ok=True)
        if not (CTL / 'cdp.sock').exists():
            record('scan fail code=no-browser-socket')
            return

    async def process_request(connection, request):
        if request.path.rstrip('/') == '/json/version':
            return respond({'Browser': 'Chrome', 'Protocol-Version': '1.3',
                            'webSocketDebuggerUrl': f'ws://127.0.0.1:{port}{PATH}'})
        if request.path == PATH:
            return None
        return Response(404, 'Not Found', Headers(), b'')

    async with serve(relay_handler, '127.0.0.1', port, process_request=process_request,
                     max_size=None):
        for mode in MODE.split(','):
            for attempt in (1, 2):
                if not learn:
                    await wake_pages()
                line = await run_mode(mode, port)
                if learn or line.startswith('ok'):
                    break
            record(mode + ' ' + line + (' (retry)' if attempt == 2 else ''))
            print(mode, line)


async def run_mode(mode, port):
    process = await asyncio.create_subprocess_exec(
        str(REPO / 'node_modules/.bin/tsx'),
        str(REPO / 'packages/connectors/probe-s1/scan.ts'),
        mode, f'http://127.0.0.1:{port}', str(ACCOUNT),
        cwd=str(REPO / 'packages/connectors'),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(process.communicate(), 240)
        line = out.decode().strip().splitlines()[-1] if out.strip() else 'fail code=no-output'
        if os.environ.get('S1_DEBUG') and err:
            print(err.decode()[-1500:])
        return line
    except asyncio.TimeoutError:
        process.kill()
        return 'fail code=timeout'


asyncio.run(main())
