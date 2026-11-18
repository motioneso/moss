"""Stand-in for another user's server on a Unix socket.

It asks every client for a plain-text password, then refuses the login. It records only the
password's length and whether it equals the install's superuser password, never the password.

Usage: fake-pg-server.py SOCKET SECRET_FILE LOG
"""

import os
import socket
import struct
import sys

SSL_REQUEST = 80877103
CLEARTEXT_PASSWORD = 3

path, secret_file, log = sys.argv[1:4]
with open(secret_file) as f:
    secret = f.read().strip().encode()


def exactly(conn, n):
    data = b""
    while len(data) < n:
        chunk = conn.recv(n - len(data))
        if not chunk:
            raise EOFError
        data += chunk
    return data


def record(line):
    with open(log, "a") as out:
        out.write(line + "\n")


def serve(conn):
    length, code = struct.unpack("!II", exactly(conn, 8))
    if code == SSL_REQUEST:
        conn.sendall(b"N")
        length, code = struct.unpack("!II", exactly(conn, 8))
    parts = exactly(conn, length - 8).split(b"\0")
    params = dict(zip(parts[0::2], parts[1::2]))
    role = params.get(b"user", b"?").decode()

    conn.sendall(b"R" + struct.pack("!II", 8, CLEARTEXT_PASSWORD))
    kind = exactly(conn, 1)
    (length,) = struct.unpack("!I", exactly(conn, 4))
    password = exactly(conn, length - 4).rstrip(b"\0")
    same = "yes" if password == secret else "no"
    record(
        f"a password arrived for role {role} (message {kind.decode()!r}): "
        f"{len(password)} characters, equal to the install's superuser password: {same}"
    )

    error = b"SFATAL\0C28P01\0Mrefused by the fake server\0\0"
    conn.sendall(b"E" + struct.pack("!I", len(error) + 4) + error)


if os.path.exists(path):
    os.unlink(path)
server = socket.socket(socket.AF_UNIX)
server.bind(path)
server.listen(5)
while True:
    conn, _ = server.accept()
    try:
        serve(conn)
    except EOFError:
        record("a client connected and sent no password")
    finally:
        conn.close()
