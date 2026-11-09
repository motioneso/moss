# Rust server and app slice 9 checkpoint

Part of https://github.com/motioneso/moss/issues/4027. Category: N/A. Task JS-130 / Card 545.

## Built

The canonical Phase 1 `bundled-db` library now has a Windows layout using slice 8's
`PrivateDirectory`; no second database provisioner is introduced. The supervisor CLI and
process/migration modules remain Unix-only. Windows app creation and Stop stay disabled.

- `Layout::create` creates or resumes `db`, `run`, `secrets` and `logs` below a private root.
  Existing objects must pass the existing exact protected-DACL policy; ACLs are never repaired.
  Missing ancestors are refused. `Layout::open` validates a complete layout without creating it.
- Root and child directory pins live in a shared value retained by every Layout clone. The raw
  caller path is validated without canonicalizing away junctions. Paths handed to future
  Postgres code require the Layout to remain alive. Windows uses `<root>/run`, with no Unix
  socket-path fallback. `moss-db.lock` keeps its canonical name but is not acquired by Layout.
- The inherited trust policy is explicit: Windows, administrators, SYSTEM and same-user
  processes are trusted; shared ancestors are accepted while pinned. This is not protection
  from malicious same-user processes. Only local fixed drives and unambiguous paths qualify.
- Canonical credential functions now use Layout for I/O. Windows uses validated file handles
  and exclusive private creation. The accepted names include all runtime roles, the bootstrap
  superuser, session-signing-secret and connector-key. Credential reads are capped at 256 bytes.
  Unix retains its prior filesystem policy; this does not retrofit Windows ACL rules on Unix.
- Canonical state I/O now goes through Layout. Windows uses slice 8's private replacement;
  readers holding no-delete-sharing handles can refuse replacement and preserve the old state.
  Reads validate the file before content is read and cap UTF-8 state at 64 KiB. Writers still
  require the future supervisor/startup lock. No power-loss durability claim is made.
- Eight native Windows test sources cover layout reuse, two instances, interrupted directory
  setup, missing ancestors, nonprivate children, clone lifetime, state replacement, planted state
  and credentials, bounds, credential routing and junction rejection. Three negative-control
  sources are configured to target credential placement, state validation and credential
  validation, requiring each intended assertion message as well as one failed test. This is
  test configuration, not a claim that the controls passed. Their actual effectiveness must be
  established by a successful current workflow, linked from the PR and proof artifact.

Internal groundwork only: there is no new screen, setting, error or remediation exposed in the
app. Existing app-map entries describing Windows creation/Stop as unavailable remain truthful.
No third-party dependency was added. Workshop and Food are not ported.

## Verification boundary

The checkpoint PR and proof artifact record current-run command outcomes. Linux unit tests and
Windows cross-checks do not prove native Windows operation. The workflow runs native tests and
negative controls under a separate standard Windows account; its actual result must be checked
before making runtime claims. Even passing these tests does not qualify the assembled Windows
Postgres supervisor or an installed desktop app.

## Left to full section 13 parity

1. Wire this canonical layout into the Windows child boundary and startup/supervisor locks,
   including authenticated runner handshake, process identity/recovery, orderly `pg_ctl kill INT`,
   Stop transport and crash-report qualification. Exercise real bundled Windows Postgres under a
   standard account: interrupted initialization, multiple instances, crashes and Stop/start races.
   Port initdb password-file creation, state deletion, lock and log handles through the pinned
   boundary; these existing Unix-only supervisor operations are not ported here. Qualify initdb
   and Postgres access while directory pins are retained. Only then enable Windows
   app creation and Stop. Credential creation still needs the supervisor's serialization.
2. Background notification delivery after disconnect/quit, saved-server routing, durable
   acknowledgements and the actual server/module-worker reminder scheduler remain unbuilt.
3. Linux runtime library/OpenSSL/certificate closure and uninstall preserving instances remain.
   Signing and updates remain Phase 7 work.
4. Real second-device or separate-network-namespace HTTPS app proof, including remote-add,
   fingerprint comparison, sign-in and Today, remains. Same-host clients are insufficient.
5. Native macOS/Windows app builds and desktop/certificate qualification remain.
6. OS public-certificate trust remains unbuilt. `rustls-platform-verifier` is not approved and
   was not added; existing pin/fingerprint paths remain available.

Section 13 is incomplete. This is a clean implementation checkpoint for the canonical layout,
not a Windows server creation/Stop release or proof of the full app lifecycle.
