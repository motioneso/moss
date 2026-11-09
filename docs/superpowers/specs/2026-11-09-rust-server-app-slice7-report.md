# Rust server and app slice 7 checkpoint

Part of https://github.com/motioneso/moss/issues/4027. Category: N/A.

## Built in this checkpoint

This continues the Windows supervisor prerequisites from slice 6. The existing portability
crate now provides private filesystem object primitives using Win32 directly, without new
packages. It does **not** enable Windows local server creation or Stop.

- New files and directories receive an explicit protected DACL during creation, with full
  control for the current process user and SYSTEM. Creation refuses existing objects rather
  than truncating them or repairing their ACLs. Elevated callers are refused through slice 6's
  standard-user check.
- Open validates the actual handle's owner, protected/non-null DACL, exact two access entries,
  object type and absence of final-component reparse points. Files with multiple hard links
  are refused. Handles do not share deletion, preventing rename/delete while they are held.
- These are object primitives, **not a safe path resolver**. The caller still needs to establish
  a trusted parent and ancestor chain, retain directory handles while accessing children, and
  define state-file replacement/recovery. Intermediate components can still follow junctions.
  Do not use these APIs alone as a complete private database layout.
- Native test sources cover Unicode/spaces, persistence, rename refusal, existing-file
  preservation, broader/missing/duplicate/inherited ACLs, hard links, wrong types, junctions,
  and invalid paths. A disposable Windows CI harness runs the suite as a standard user and
  uses a second standard account to check actual read/write/traversal denial for both a file
  within a private directory and a private file directly within a shared parent.
- Negative controls remove ACL comparison and hard-link rejection and require the matching
  native rejection tests to fail. A configured workflow is not evidence of a completed run.

This is internal groundwork with no new screen, setting, error or remediation. Existing app-map
entries saying Windows local setup/Stop are unavailable remain accurate. The canonical Phase 1
provisioner, migration runner and credential paths are unchanged; there is no second provisioner.
Workshop and Food are not ported. The unapproved platform certificate library was not added.

## Verification boundary

The checkpoint PR and proof artifact record current-run commands, native CI results when
available, and independent review. Linux tests and a Windows target check establish regression
and compilation evidence only. The two-account native fixture tests cover these object APIs;
they do not establish a complete Windows private layout, Postgres lifecycle, app or installer.
No full Windows/macOS app or separate-device HTTPS proof is claimed by this checkpoint.

## Left to full section 13 parity

1. **Windows creation and Stop remain incomplete.** Integrate these object primitives into a
   validated private layout with a trusted ancestor policy and private state replacement.
   Wire the canonical Phase 1 supervisor to slice 6's child boundary and existing startup
   locks; add orderly `pg_ctl kill INT` shutdown, supervisor Stop transport, identity/recovery,
   authenticated runner handshake and crash-report qualification. Keep app creation/Stop
   disabled until the assembled path works. Native standard-account Postgres qualification
   still needs interrupted setup, spaces/Unicode paths, independent instances, crashes and
   Stop/start races.
2. **Background notifications/scheduling remain incomplete.** Delivery after quitting or
   disconnecting, other saved servers, click-to-open routing, durable acknowledgement and
   the real server/module-worker reminder scheduler remain. More desktop polling alone is
   not that scheduler.
3. **Linux runtime/uninstall packaging remains incomplete.** Unsigned staging still lacks the
   complete runtime library closure and OpenSSL/certificate dependency. Uninstall must remove
   program files while preserving user instances by default. Signing/updates belong to Phase 7.
4. **Separate-device HTTPS proof remains.** Exercise the real app's remote add-server,
   certificate comparison, sign-in and Today path from a different machine or network namespace,
   disclosing the namespace substitute. Same-host apps alone do not meet the gate.
5. **Native macOS/Windows app qualification remains.** Full linked builds, tray lifetime,
   login startup, notification permission/bundle identity, web-view pins and public-certificate
   paths still need native evidence; filesystem/child tests qualify only their own boundaries.
6. **OS trust for public certificates remains unbuilt.** The platform verifier dependency is
   unapproved and was not added. Pins/fingerprint comparison remain the path. This is still
   implementation work, not merely missing proof or signing.

**No: more than Windows/macOS native proof and Phase 7 remains.** The list above includes Windows
supervisor integration, background delivery/scheduling, Linux packaging, separate-device proof,
and operating-system certificate trust. Section 13 is not at full parity.

## Next checkpoint

Build the Windows private layout/ancestor and state-replacement policy on these object primitives,
then port the canonical supervisor onto it and the existing owned child/lock boundaries. Add Stop
transport and orderly shutdown before enabling the app's creation/Stop controls.
