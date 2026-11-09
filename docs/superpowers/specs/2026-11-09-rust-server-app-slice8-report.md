# Rust server and app slice 8 checkpoint

Part of https://github.com/motioneso/moss/issues/4027. Category: N/A.

## Built in this checkpoint

This starts the first item in slice 7's remaining-work list. It adds a Windows directory and
state-file boundary to the existing portability crate, without new dependencies. It does not
assemble or enable Windows server creation or Stop.

- `windows_private::directory::PrivateDirectory` opens existing ancestors from a local fixed
  drive root down, checking each opened handle for directory type and reparse points before
  resolving the next component. Ancestor handles deny write and delete sharing; the final
  private directory uses slice 7's exact owner/protected-DACL policy. Missing ancestors and
  existing roots passed to create are refused. Existing ACLs are never repaired.
- The trust policy trusts Windows, administrators, SYSTEM and processes running as the current
  user. Shared ancestors are allowed while pinned. UNC, device/verbatim paths, dot components,
  alternate streams, reserved device names and trailing-dot/space aliases are refused. Drives
  must be local and fixed; network and removable volumes are outside this boundary.
- Child directory values retain their entire pinned ancestor chain even if their parent value
  is dropped. Child names must be a single unambiguous component. Raw file handles and paths
  passed to other code still require the directory value to remain alive during path operations.
- State replacement validates an existing destination with slice 7's file policy, writes and
  flushes an exclusively created private temporary in the same pinned directory, then renames
  it over the named state. An open reader can refuse the rename; failure preserves old state.
  Writers must use the supervisor/startup lock; this API does not acquire it. A crash may leave private temporary files; failed post-creation validation may leave an empty
  temporary. Neither is ever adopted as state. Power-loss durability of the
  directory rename is not claimed.
- Native test sources cover spaces/Unicode, ancestor lifetime, junctions at multiple depths,
  conflicting write/delete handles (including after parent values drop), alias/escape rejection, state replacement and failure, and stale
  temporary files. The standard-user Windows harness includes these tests. Negative controls
  remove ancestor write/delete-sharing refusal, parent retention, reparse rejection, child-name checking and destination
  validation, and require their corresponding tests to fail. Configured tests are not passing
  runtime evidence until the current workflow completes.

This is internal groundwork. No new screen, setting, user-visible error or remediation is added.
The app-map entries keeping Windows setup/Stop unavailable remain accurate. The canonical Phase 1
provisioner, migrations and credential paths remain unchanged. Workshop and Food are not ported;
no platform-verifier dependency was added.

## Verification boundary

The checkpoint PR and proof artifact record actual current-run commands and native CI outcomes.
A Linux regression pass and Windows target check alone do not prove Windows runtime behavior.
Even native directory tests do not qualify a complete Windows database layout, provisioner,
Postgres supervisor, app or installer. No full desktop or separate-device HTTPS proof is claimed.

## Left to full section 13 parity

1. Integrate this boundary into the canonical Phase 1 layout, including its data/run/secrets/log
   directories and private credentials. Wire the Windows child boundary and existing startup
   locks into that supervisor. Implement orderly `pg_ctl kill INT`, Stop transport, process
   identity/recovery, authenticated runner handshake and crash-report qualification. Exercise
   interrupted setup, multiple independent instances, crashes and Stop/start races with real
   Windows Postgres under a standard account before enabling app creation/Stop.
2. Background notification delivery after quitting/disconnecting, saved-server routing, durable
   acknowledgements and the actual server/module-worker reminder scheduler remain unbuilt.
3. Linux runtime library/OpenSSL/certificate closure and uninstall preserving instances remain.
   Signing and updates are still Phase 7 work.
4. Real app remote-add, fingerprint comparison, sign-in and Today proof from another machine or
   network namespace remains. Same-host clients do not satisfy this requirement.
5. Full native macOS/Windows app builds and desktop/certificate qualification remain.
6. Operating-system public-certificate trust remains unbuilt; its verifier dependency is not
   approved. Existing pin/fingerprint paths remain the available route.

Section 13 is not at full parity. The next checkpoint is canonical Windows layout integration,
then supervisor/Stop assembly; another provisioner must not be introduced.
