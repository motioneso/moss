# JS-136 / Card 546: pinned Windows supervisor lock checkpoint

Part of https://github.com/motioneso/moss/issues/4027. Category: N/A.

Work stays in the task's checkout of `~/Jarv1s`, updated to the merged slice 9 base.
The existing Windows boundary already pins shared ancestors and replaces private state.
Its trust policy remains OS, administrators, SYSTEM and same-user processes; shared
ancestors are pinned for the lifetime of the layout, not claimed to be private.

1. Extract the canonical supervisor lock from the Unix cluster module into the shared
   bundled-db library; keep the Unix entry point and behavior.
2. Open/create the Windows lock through the pinned root and exact private-file policy.
   Retain Layout in the lock guard so the ancestor pins outlive the caller's Layout.
   Expose Windows state writes through that guard; do not add another provisioner.
3. Exercise contention across handles/processes, readable PID, release after process death,
   independent instances, private lock rejection and retained pins. Extend standard-user
   Windows CI and negative controls. Use task-owned Rust homes and target output.
4. Run scoped regressions, independent read-only review and publish a checkpoint PR with
   real command evidence and explicit native-runtime gaps.

This is library groundwork, not an assembled Windows supervisor. The child runner handshake,
startup locks, process identity/recovery, initdb and log I/O, orderly Postgres shutdown,
Stop transport and real bundled Windows Postgres qualification remain. Windows app creation
and Stop stay disabled. Background delivery/scheduler, Linux closure/uninstall,
second-device HTTPS, native desktop and OS public-certificate trust remain unbuilt.
No dependency, screen, setting or app-map behavior is introduced.
