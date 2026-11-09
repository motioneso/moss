# Rust server and app slice 6 checkpoint

Part of https://github.com/motioneso/moss/issues/4027. Category: N/A.

This continues slice 5's Windows supervisor prerequisites. It does **not** finish Windows
creation/Stop or section 13 parity. Workshop and Food are not ported. No third-party package
or platform certificate verifier was added.

## Built

- A Windows child-process ownership boundary in the existing portability crate, intended for
  the canonical Phase 1 supervisor. It uses Win32 directly, without another crate.
- The launch path refuses an elevated process token. It creates an unnamed, non-inheritable
  kill-on-close Job Object, creates the executable suspended and without a console, assigns
  it to that job, then resumes its primary thread. Assignment failure attempts termination and
  a bounded reap of the suspended process, reporting cleanup failure with the child's identity
  if Windows refuses it. Job assignment/resume errors never return a usable child.
- The child owns its job and process handles. Dropping the child closes the job; explicit
  force termination acts on that job. Waiting reports the root process's actual exit code.
  This is a backstop, **not** orderly Postgres shutdown: `pg_ctl kill INT` remains to be wired.
  The supervisor must serialize all process starts, including starts through `std::Command`:
  a concurrent blanket-inheritance launch could inherit temporary log/NUL handle duplicates.
- Launch passes an explicit executable path and working directory, quotes CRT arguments,
  supplies NUL input and duplicate output handles through an explicit inheritance list,
  and removes case-insensitive `PG*` environment variables. Only absolute program and working
  directory paths are accepted. No shell is involved.
- Native tests cover root/descendant termination on drop and forced owner exit, independent
  jobs, a real executable path with spaces/non-ASCII, arguments with quotes/backslashes/empty
  strings, output routing, exit codes, launch errors, unrelated inheritable handles, PG
  environment removal and absence of a console. An explicit elevated-run test checks refusal.
- The lifecycle CI workflow builds the suite on Windows and runs it as a disposable standard
  local account rather than weakening the elevation policy for the elevated hosted runner.
  Mutation controls remove kill-on-close, the inheritance list, PG environment filtering, the
  console flag and elevation refusal, requiring the corresponding tests to fail. The harness
  requires the full positive test count and refuses execution outside disposable Windows CI.
  A configured workflow alone is not evidence that those tests passed.

This is internal groundwork. The module is **not yet called by `moss-db`**, which still refuses
Windows builds, and the app still refuses Windows local setup and Stop. There is no new screen,
setting, error or remediation; the app map's existing unavailable-on-Windows declarations remain
truthful. This checkpoint does not add a second provisioner or change migration/credentials paths.

## Verification boundary

The checkpoint PR and proof artifact carry current-run command output and independent review.
Linux portability tests and a Windows-target cross-check do not establish native process behavior.
Native results, when green, establish this child API's test cases, **not** a working Windows
Postgres bundle, supervisor, installer or app. No full Windows/macOS app runtime or separate-device
HTTPS result is claimed by this slice. No browser surface changed.
Job-assignment failure and refusal of its attempted cleanup have not been exercised at runtime.

## Left to full section 13 parity

1. **Windows supervisor and app setup/Stop remain incomplete.** Reuse this child boundary for
   `initdb`/Postgres and the canonical Phase 1 migration runner. Implement protected user/SYSTEM
   filesystem ACLs, private layout and state validation; `pg_ctl` signal-pipe shutdown; supervisor
   Stop requests; process identity/recovery; transport; and crash-report qualification. Keep
   Windows setup disabled until these work together. Qualify interrupted setup, actual Postgres
   paths with spaces/non-ASCII, independent instances, crashes and Stop/start races on a standard
   Windows account. The authenticated Windows runner handshake also remains from Phase 1.
2. **Background notifications remain incomplete.** Current delivery covers the selected open
   server's web profile. Delivery after quit/disconnect, other saved servers, click-to-open
   routing, durable acknowledgement and the real server/module-worker reminder scheduler remain.
   More desktop polling would not implement that scheduler. Connected chat still uses the
   existing shell thread.
3. **Linux installer runtime/uninstall packaging remains incomplete.** Existing unsigned staging
   includes built programs, assets/schema and an existing PostgreSQL bundle. It does not package
   the full runtime library closure or OpenSSL/certificate dependency. An end-user uninstall must
   remove installed program files while preserving all user instances by default. Signing and
   updates belong to Phase 7.
4. **Separate-device HTTPS proof remains.** Run the real app's remote add-server, certificate
   comparison, sign-in and Today path against another machine or a separate network namespace;
   disclose the namespace substitute if used. Two apps on the same host do not meet this gate.
5. **Native macOS/Windows app qualification remains.** Full linked builds, tray lifetime, login
   startup, notification permission/bundle identity, web-view pins and public-certificate paths
   still need native runtime evidence. Portable locks and child-process tests cover their own
   protocols only.
6. **Operating-system trust for public certificates remains unbuilt.** The unapproved
   `rustls-platform-verifier` was not added. Pins and fingerprint comparison remain the path;
   this is implementation work, not just a missing proof or signing step.

**No: more than Windows/macOS native proof and Phase 7 remains.** Windows supervisor integration,
background delivery/scheduling, Linux runtime/uninstall packaging, separate-device proof and OS
public-certificate trust are still open. Section 13 is not at full parity.

## Next checkpoint

Finish Windows private filesystem layout/ACLs and port the canonical supervisor onto this child
boundary, its existing lock protocol and migration runner. Add orderly Postgres shutdown and
supervisor Stop transport before enabling creation/Stop in the app. Preserve one install with
multiple local instances and remote connections.
