# Rust server and app slice 5 checkpoint

Part of https://github.com/motioneso/moss/issues/4027. Category: N/A.

This is a prerequisite checkpoint for the Windows supervisor port, after merged slice 4
(#4106). It does **not** complete slice 5's first priority or section 13 parity. Workshop and
Food are not ported. No third-party package or platform verifier was added.

## Built

- One file-lock implementation in the existing portability crate, used by app setup, app
  start/Stop serialization and the canonical Phase 1 database supervisor. Unix continues to
  use `flock`; Windows uses synchronous `LockFileEx`, retaining ownership with the file handle.
- Windows locks a reserved byte beyond the file contents. This matters because Windows byte
  locks otherwise prevent another handle from reading the supervisor PID while it is locked.
  Setup waits for its lock; start and supervisor status use nonblocking exclusive/shared locks.
- Real lock errors in app start are reported as start failures rather than mistaken for an
  app that is already starting the server. Interrupted Unix lock calls retry.
- Local server executable discovery includes the platform suffix (`moss-shell.exe` on Windows).
- Subprocess tests exercise exclusive/shared contention, PID readability while locked,
  release after the owner exits, and a blocked waiter waking after its owner is killed.
  App tests cover independent start handles, lock errors and executable naming.
- A dedicated Linux/macOS/Windows CI job runs the actual portable lock tests with task-owned
  Cargo, rustup and target directories. A configured job is not evidence it has passed.

This is internal lifecycle work: no new screen, setting or app-map capability is declared.
The existing app map remains truthful: Windows local setup and Stop are unavailable.

## Verification

Current-run command output, independent review and check results are attached to the proof
artifact and checkpoint PR. Linux results do not establish native Windows lock semantics,
ACL enforcement or supervisor lifecycle. No second-device HTTPS result is claimed here.

## Left to full section 13 parity

1. **Windows supervisor and app setup/Stop are still incomplete.** Locks are now portable, but
   the supervisor remains Unix-only. Port its private filesystem layout to protected user/SYSTEM
   ACLs; refuse elevated launch or use the designed restricted token; launch initdb/Postgres
   suspended and windowless in a kill-on-close Job Object; use PostgreSQL's own signal pipe via
   `pg_ctl kill INT` for orderly shutdown; implement process identity/recovery, transport and
   supervisor shutdown requests. Keep setup disabled until these pieces work together. Reuse
   the existing migration runner and credentials path, not a second provisioner. Qualify paths
   containing spaces/non-ASCII, independent installs, interrupted setup, crashes and Stop/start
   races on a real standard Windows account. The Phase 1 report also leaves the authenticated
   Windows runner handshake and crash-report qualification outstanding.
2. **Background notifications are still unbuilt.** Slice 4 delivers notices only through the
   selected open server's web profile. Delivery after quit/disconnect, other saved servers,
   click-to-open routing, durable delivery acknowledgement and the reminder scheduler remain.
   Porting the reminder scheduler requires its actual server/module-worker path; extra desktop
   polling alone does not supply it. Connected chat still uses the existing shell thread.
3. **Linux installer staging is still incomplete.** Slice 4 stages built binaries, web/schema
   and an existing PostgreSQL bundle; it does not package the full runtime library closure,
   OpenSSL/certificate dependency or an end-user uninstall path. An uninstall must distinguish
   installed program files from all user instances and preserve data by default. Signing and
   updates belong to Phase 7 and were not attempted.
4. **Separate-device HTTPS proof remains.** No second physical device or separate network
   namespace was exercised in this checkpoint. Slice 4's two apps on one host do not meet this
   requirement. Run the real app's remote connection, certificate comparison, account sign-in
   and Today path against a second device, or explicitly disclose a network-namespace substitute.
5. **Native macOS/Windows qualification remains.** Tray lifetime, start at login, notification
   permission/bundle identity, web-view pins, public-certificate paths and full native linked
   builds still need platform runtime evidence. The new lock matrix qualifies only its lock
   protocol when those CI jobs actually pass.
6. **Operating-system public-certificate trust remains unbuilt.** The unapproved
   `rustls-platform-verifier` dependency was not added. Pins and fingerprint comparison remain
   the current path. This is implementation work, not merely missing native proof or signing.

**More than native Windows/macOS proof and Phase 7 remains:** Windows implementation,
background notification delivery and scheduling, Linux runtime/uninstall packaging,
separate-device proof, and OS public-certificate trust. Section 13 is not at full parity.

## Next checkpoint

Continue priority 1 with the canonical supervisor's Windows ACL/process/transport port. The
lock tests can run independently of its Unix-only binary, so Windows CI can reject lock
regressions before that port is enabled. Keep the same one-install/multiple-instances model.
