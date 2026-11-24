"""Count actual opens of the source index by the real folder registry client (Linux)."""
import ctypes
import os
from pathlib import Path
import select
import struct
import sys

folder, counter, ready = map(Path, sys.argv[1:])
libc = ctypes.CDLL(None, use_errno=True)
fd = libc.inotify_init1(os.O_NONBLOCK)
assert fd >= 0
assert libc.inotify_add_watch(fd, os.fsencode(folder), 0x20) >= 0  # IN_OPEN
count = 0
counter.write_text('0')
ready.touch()
while True:
    select.select([fd], [], [])
    data = os.read(fd, 65536)
    offset = 0
    while offset < len(data):
        _, mask, _, length = struct.unpack_from('iIII', data, offset)
        name = data[offset + 16:offset + 16 + length].rstrip(b'\0')
        if mask & 0x20 and name == b'index.json':
            count += 1
            temporary = counter.with_suffix('.tmp')
            temporary.write_text(str(count))
            temporary.replace(counter)
        offset += 16 + length
