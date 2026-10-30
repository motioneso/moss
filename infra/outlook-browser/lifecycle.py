"""Crash-recoverable runtime inventory; contains opaque IDs, never account data.

Only the dedicated host service may open this directory. The Moss database owns
user authorization; this inventory prevents a late allocation from undoing removal.
"""
import fcntl
import os
import sqlite3
import stat
import uuid
from contextlib import contextmanager
from pathlib import Path


class Unavailable(Exception):
    pass


def validate_reference(runtime_id, generation):
    if (not isinstance(runtime_id, str) or str(uuid.UUID(runtime_id)) != runtime_id or
            type(generation) is not int or not 0 < generation <= 9007199254740991):
        raise ValueError('Invalid runtime reference')


class Inventory:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.directory.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or
                stat.S_IMODE(info.st_mode) != 0o700):
            raise Unavailable('Runtime directory must be owner-only')
        self.database = self.directory / 'inventory.sqlite3'
        # Never follow a preexisting symlink or open an externally readable DB.
        descriptor = os.open(self.database, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                    stat.S_IMODE(info.st_mode) != 0o600):
                raise Unavailable('Runtime inventory must be owner-only')
        finally:
            os.close(descriptor)
        with self.connect() as database:
            database.execute('''CREATE TABLE IF NOT EXISTS runtimes (
                id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('allocating', 'ready', 'removing', 'removed'))
            )''')

    @contextmanager
    def connect(self):
        database = sqlite3.connect(self.database, timeout=5)
        try:
            database.execute('PRAGMA synchronous = FULL')
            with database:
                yield database
        finally:
            database.close()

    @contextmanager
    def lock(self, runtime_id, generation):
        validate_reference(runtime_id, generation)
        descriptor = os.open(self.directory / (runtime_id + '.lock'),
                             os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Unavailable('Runtime busy') from None
            yield
        finally:
            os.close(descriptor)

    def get(self, runtime_id):
        with self.connect() as database:
            return database.execute('SELECT generation, state FROM runtimes WHERE id = ?',
                                    (runtime_id,)).fetchone()

    def pending(self):
        """Snapshot for startup recovery; tombstones never need recreation."""
        with self.connect() as database:
            return database.execute('''SELECT id, generation, state FROM runtimes
                WHERE state != 'removed' ORDER BY state = 'removing' DESC, id''').fetchall()

    def allocate(self, runtime_id, generation, create):
        """create must be bounded and idempotent for the named container/volume."""
        with self.allocating(runtime_id, generation):
            create(runtime_id)

    @contextmanager
    def allocating(self, runtime_id, generation):
        with self.lock(runtime_id, generation):
            with self.connect() as database:
                row = database.execute('SELECT generation, state FROM runtimes WHERE id = ?',
                                       (runtime_id,)).fetchone()
                if row and (row[0] != generation or row[1] in ('removing', 'removed')):
                    raise Unavailable('Runtime unavailable')
                database.execute('INSERT OR IGNORE INTO runtimes VALUES (?, ?, ?)',
                                 (runtime_id, generation, 'allocating'))
            # Commit inventory BEFORE external side effects. A crash here leaves
            # an allocating record, which can be retried or explicitly removed.
            yield
            with self.connect() as database:
                database.execute('UPDATE runtimes SET state = ? WHERE id = ?',
                                 ('ready', runtime_id))

    def remove(self, runtime_id, generation, destroy):
        """Removal tombstones are permanent, even when the profile never existed."""
        with self.removing(runtime_id, generation):
            destroy(runtime_id)

    @contextmanager
    def removing(self, runtime_id, generation):
        with self.lock(runtime_id, generation):
            with self.connect() as database:
                row = database.execute('SELECT generation FROM runtimes WHERE id = ?',
                                       (runtime_id,)).fetchone()
                if row and generation < row[0]:
                    raise Unavailable('Runtime unavailable')
                database.execute('''INSERT INTO runtimes VALUES (?, ?, 'removing')
                    ON CONFLICT(id) DO UPDATE SET generation = excluded.generation,
                    state = 'removing' ''', (runtime_id, generation))
            # A failure intentionally retains removing. No allocation can reuse
            # the ID while the database cleanup worker retries profile deletion.
            yield
            with self.connect() as database:
                database.execute('UPDATE runtimes SET state = ? WHERE id = ?',
                                 ('removed', runtime_id))
