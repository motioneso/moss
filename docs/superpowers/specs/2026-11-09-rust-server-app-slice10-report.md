# Rust server and app slice 10 checkpoint

Part of https://github.com/motioneso/moss/issues/4027. Category: N/A. Task JS-136 / Card 546.

## Built

The canonical Phase 1 supervisor lock is now a cross-platform library module. The Unix
supervisor still calls `cluster::lock`, which re-exports the shared implementation.
Windows supervision itself is not enabled.

- Windows opens or exclusively creates `moss-db.lock` through the existing pinned private
  root, validating its existing exact user/SYSTEM file policy. The creation-race retry
  reopens with validation, but that branch is not deterministically exercised here.
  Contention never truncates the holder's PID. A redirected public lock
  path is refused. No ACL is repaired and no second provisioner is introduced.
- `InstallLock` retains a Layout clone, keeping its directory pins alive for the guard's
  lifetime. The existing shared-ancestor trust policy is unchanged: OS, administrators,
  SYSTEM and same-user processes are trusted, and shared ancestors are pinned while in use.
- External Windows state writers now use `InstallLock::write_state`; the underlying Layout
  write is crate-private. The guard writes through its own pinned layout and existing
  private replacement. Readers remain available without taking the supervisor lock.
- Common tests cover independent handles/processes, readable PID without contention
  truncation, independent instances and release after process death. Windows test sources
  also cover retained pins/state writes, planted nonprivate locks, redirected paths and
  deletion/rename refusal while held. The standard-user Windows workflow runs seven tests
  and three negative controls for in-process contention, planted lock validation and
  redirected paths, each checking its intended assertion. Guard pin retention and state
  writes have native test sources but no dedicated mutation controls in this checkpoint.

Internal groundwork only: Windows app creation and Stop remain disabled. No new screen,
setting, error or remediation reaches the app, so its app map remains unchanged and truthful.
No dependency was added. Workshop and Food are not ported.

## Verification boundary

The checkpoint's PR and proof artifact contain actual command outcomes from this run.
Linux regressions and cross-compilation do not qualify Windows runtime behavior. Native
standard-user Windows tests and their negative controls require the current workflow result;
test sources or a configured job alone are not proof. The Linux lock negative control was
observed failing at the intended contention assertion, with the source restored afterward.

## Left to full section 13 parity

1. Assemble the Windows supervisor with the child boundary, authenticated runner handshake,
   startup locks, process identity/recovery, initdb password and log I/O, state deletion,
   orderly Postgres shutdown and Stop transport. Qualify real bundled Windows Postgres under
   a standard account, including initialization interruptions, multiple instances, crashes
   and Stop/start races, before enabling Windows app creation or Stop.
2. Background notification delivery after disconnect/quit, saved-server routing, durable
   acknowledgements and the real server/module-worker reminder scheduler.
3. Linux runtime library/OpenSSL/certificate closure and uninstall preserving user instances;
   signing and updates remain Phase 7 work.
4. Real second-device or separate-network-namespace HTTPS app proof, including remote-add,
   fingerprint comparison, sign-in and Today. Same-host clients do not satisfy this.
5. Native macOS/Windows app builds and desktop/certificate qualification.
6. OS public-certificate trust. `rustls-platform-verifier` remains unapproved and was not added.

Section 13 is incomplete. This is a supervisor-lock library checkpoint, not a Windows local
server or Stop release, and it does not claim the full app's live-path proof.
