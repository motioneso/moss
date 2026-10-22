"""Retain the broker lock while one fixed engine command finishes.

Podman can pass inherited descriptors into its detached monitor. Keep the lock
in this supervisor instead, and close all extra descriptors in the actual engine.
This entrypoint is internal: arguments come only from Podman.run, never clients.
"""
import os
import signal
import subprocess
import sys


def run(parent_pid, lock_descriptor, arguments):
    os.fstat(lock_descriptor)
    parent = None
    # Bind timeout signaling to the actual parent, without a PID-reuse race or
    # accidentally signaling the reaper if the broker died before we started.
    if os.getppid() == parent_pid:
        try:
            parent = os.pidfd_open(parent_pid)
            if os.getppid() != parent_pid:
                os.close(parent)
                parent = None
        except ProcessLookupError:
            pass
    try:
        process = subprocess.Popen(['podman', *arguments], stdin=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, close_fds=True)
        try:
            return process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            # Do not kill an engine command and then acknowledge cleanup while
            # its side effects are uncertain. Stop the broker; retain its lock
            # until the command exits or systemd kills the old service cgroup.
            if parent is not None:
                try:
                    signal.pidfd_send_signal(parent, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            process.wait()
            # Podman's exists subcommands use 1 for ordinary absence. A timeout
            # must never be mistaken for permission to create a missing resource.
            return 70
    finally:
        if parent is not None:
            os.close(parent)


if __name__ == '__main__':
    raise SystemExit(run(int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]))
