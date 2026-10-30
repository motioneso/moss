"""One host broker, including engine commands surviving broker death.

The lock file is permanent. Unlinking it would allow two different locked inodes.
Engine command supervisors inherit the descriptor; a replacement broker waits.
The systemd unit also terminates the old service cgroup before restarting it.
"""
import fcntl
import os
import stat

from lifecycle import Unavailable


class ServiceLock:
    def __init__(self, directory):
        self.descriptor = os.open(directory / 'service.lock',
                                  os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(self.descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                    stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
                raise Unavailable('Private service lock required')
            fcntl.flock(self.descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            self.close()
            raise

    def close(self):
        # Do not LOCK_UN: a surviving engine command holds the same open file
        # description and must retain the lock until its own descriptor closes.
        if self.descriptor is not None:
            os.close(self.descriptor)
            self.descriptor = None
