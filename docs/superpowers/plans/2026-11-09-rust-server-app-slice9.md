# JS-130 / Card 545: canonical Windows layout checkpoint

Part of https://github.com/motioneso/moss/issues/4027. Category: N/A.

Build the first portion of slice 8's remaining work in the existing Phase 1 crate:

1. Add Windows `Layout::create/open`, retaining slice 8's directory pins across clones. Use
   `db`, `run`, `secrets`, `logs` and `moss-db.lock`; do not introduce another provisioner.
2. Resume private partial layouts; refuse missing ancestors, junctions and nonprivate existing
   objects. Preserve slice 8's trust policy (OS, administrators, SYSTEM and same-user processes;
   shared ancestors are pinned, not treated as private).
3. Route canonical state and credential I/O through Layout. Windows uses validated handles and
   private replacement; Unix retains its existing filesystem policy. Limit reads and accept
   only the canonical credential names, including session-signing-secret and connector-key.
4. Add standard-user Windows integration tests and negative controls to the existing lifecycle
   workflow. Run local Linux regressions and Windows target checks with task-owned Rust homes.
5. Commit, obtain independent read-only review, push a checkpoint PR and publish actual evidence
   with explicit gaps. Keep Windows app creation and Stop disabled.

This checkpoint does not assemble the Windows supervisor, process identity/recovery, runner
handshake, orderly Postgres shutdown or Stop transport. These and real Windows Postgres/runtime
qualification precede enabling the controls. Background delivery/scheduler, Linux closure and
uninstall, second-device HTTPS, native desktop qualification and OS public-certificate trust
remain unbuilt. No new dependency, screen, setting or app-map behavior is introduced.
