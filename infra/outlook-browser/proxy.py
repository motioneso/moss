"""Container loopback-to-Unix byte relay; the host enforces destination policy."""
import asyncio
from contextlib import suppress

CONNECT_SOCKET = '/egress/connect.sock'


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    finally:
        writer.close()


async def handle(reader, writer):
    upstream = None
    try:
        source, upstream = await asyncio.open_unix_connection(CONNECT_SOCKET)
        async with asyncio.TaskGroup() as group:
            group.create_task(pipe(reader, upstream))
            group.create_task(pipe(source, writer))
    except (OSError, ExceptionGroup):
        pass
    finally:
        if upstream:
            upstream.close()
        writer.close()
        with suppress(OSError):
            await writer.wait_closed()


async def main():
    server = await asyncio.start_server(handle, '127.0.0.1', 8080, limit=8192)
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    asyncio.run(main())
