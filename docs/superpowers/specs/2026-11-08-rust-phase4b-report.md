# Rust Phase 4b: module host and package format

Status: **implementation checkpoint; Phase 4b is not complete and is not ready for acceptance**.

Part of https://github.com/motioneso/moss/issues/4027. Card: 511. Release note Category: N/A.
The work is isolated under `rust-spike/module-host/`; it does not change the running app or the
sibling phase's crates. Workshop, Food and registry screens are excluded.

## What is implemented

- A version-two manifest and deterministic tar/zstd package writer and reader. The reader checks
  the package digest, bounded size, archive entry types, paths, ordering, zero timestamps,
  required files and declared assets. `LICENSE`, `NOTICE` and `CHANGELOG.md` are fixed-name
  exceptions to the design's lower-case rule.
- Ed25519 root, index and publisher signature verification, publisher-prefix restrictions,
  remembered index serials and immutable version digests, sticky revocations, expiry checks,
  a persisted registry-root fingerprint, dependency checks, exact version pins, folder import,
  an HTTPS registry adapter, and a byte-preserving offline mirror API.
- A real Wasmtime component host with versioned WIT interfaces, an import allowlist, no WASI
  linker, memory and fuel limits, an epoch deadline, bounded messages and a small memory cache.
  The host binds the actor; requests cannot supply a data context or database connection.
- Real account-scoped key-value and module-file adapters using `VaultContext`, a bounded HTTPS
  GET adapter, and typed database operations using the existing `DataContext` and restricted
  per-module runtime roles. Host errors returned to guests use a fixed message.
- Installer methods for stage, install, update, pin, remove, retain-data reinstall and confirmed
  purge. An active version is a PostgreSQL catalog row with compare-and-swap revisions. Read
  and write fences cover host calls and lifecycle changes, including a data-folder file lock.
- A restricted new-SQL migration path, generated owner-only forced RLS, an applied-file hash
  ledger, snapshots of module files/key-value data and database tables, and restoration when
  an upgrade hook fails. Retained tables are included in reinstall snapshots.
- Permission descriptions and update approval data, an additive module-list format and APIs,
  and a sample with feature/error/remediation metadata. There are no new screens.

The WIT interfaces use JSON request envelopes with a checked operation and resource, and one
handler export receives route/job/tool/event/install/health calls. This is a provisional ABI,
not a frozen published interface.

## What has been exercised

The tests create fresh synthetic accounts, ephemeral signing keys and real package bytes. The
sample is compiled to a WebAssembly component, signed, loaded from a signed folder registry,
installed to disk and executed by Wasmtime. Its port writes real account-scoped data.

The file lifecycle test covers pin refusal, an approved unpin/update, retained account data,
removal, reinstall and typed-name purge. It also covers cross-registry replacement refusal
before and after removal, stale catalog refusal, preserving an existing pin on list import,
and continuing updates when another installed module disappears from the index.
Database tests run only through `scripts/run-gate.sh`
and the crate's `tools/gate.sh`, against the gate's disposable PostgreSQL server. They cover an
admin-only configuration catalog, stale revision refusal, actor-scoped rows and a failed health
hook after an actual schema migration, with the previous schema, rows and active version
restored. The expanded test also covers a failed reinstall with retained tables and a successful
purge/reinstall, including purging retained data without reinstalling code first.

Removal controls change a disposable source copy and require the matching test to fail for:

1. Root, index and publisher signature verification, using well-formed forged signatures.
2. The package hash check.
3. The file/socket/database import allowlist.
4. The publisher-prefix check.
5. The private-address classification.

These controls prove those particular assertions detect their missing protections. They do not
prove every property in the design. They are recorded before the passing protected test run;
this is adversarial removal-control evidence, not a claim that every feature was developed
in a test-first sequence.

Reproduction commands and the sample source are documented in
`rust-spike/module-host/README.md`. Checkpoint results:

| Check                                                 | Result                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| Protected Rust tests                                  | 20 passed; database tests intentionally ignored here                  |
| Database tests through verify-gate                    | 2 passed; fresh server removed successfully                           |
| Disposable removal controls                           | All five matching assertions failed when their protection was removed |
| Rust formatting and Clippy with warnings refused      | Passed                                                                |
| Repository lint, type checking and file-size checks   | Passed                                                                |
| Prettier on the changed Markdown and TypeScript files | Passed                                                                |
| Full repository format check                          | Stopped before completion; not claimed as a pass                      |

A verification run exposed a shared Cargo output collision between a mutated control copy and a
protected build. That protected result was discarded. The control runner now gives every copy a
unique package identity while retaining its library import name. The passing protected run above
followed a clean of this crate's artifacts; the final database gate ran after the controls ended.
No production database or installed app was used.

An earlier upgrade fixture returned an error during both installation and health checking, so
its result did not prove health-specific rollback. That claim was withdrawn from the proof
artifact. The corrected component succeeds for installation and fails only for health; a
separate host test checks that distinction. The database gate was rerun with that component
and checks the guest-error result, restored schema, rows and active version.

## Independent review checkpoint

Claude reviewed commit `6092ad216` read-only in round one. The incomplete scope remains a major
finding and blocks acceptance. This follow-up addresses the reported cross-registry replacement,
module-list pin loss, update starvation, network-held data lock, hidden permission growth and
missing signature controls. Publisher provenance now survives retain-data removal; a foreign
registry cannot authorize replacement of the original registry's publisher. Permission data
includes operations and private-network access. Updates return per-module failures. The catalog
must match the persisted signed index before install, import or update.

The review suggested deleting snapshots immediately after purge. That suggestion conflicts with
design section 3.9, which explicitly retains purge recovery snapshots for thirty days. The
missing expiry and cleanup remain a valid major gap. Snapshot schemas revoke public access;
their lack of RLS alone does not establish that application actors can read them.

Remaining lower-severity review findings include stale version folders after failed upgrades,
removal without dependent checks, colliding table prefixes, publisher-chosen migration order,
restoration errors masking the original failure, lifted revocations leaving modules disabled,
compilation while holding the cache lock, and the local privileged PostgreSQL connection's
`NoTls` assumption. The import controls exercise installation-time validation, not every
runtime escape attempt. None of these are claimed resolved by the passing checks.

## Work still required before Phase 4b is ready

1. **Connect every general service port.** Credentials and OAuth exchange, AI, embeddings,
   jobs, events, public APIs, notifications, attachments, tools and action policy still need
   concrete host services. Missing adapters refuse requests. The HTTPS adapter currently
   supports GET only and refuses all redirects. Install-wide key-value namespaces and declared
   account-notes access are not implemented.
2. **Join the Phase 2b queue and router.** Both lifecycle implementations refuse scheduled-job
   modules. The current pause bookkeeping is not a queue fence. Add real draining, queue
   pause/resume, typed payload validation and cancellation, then exercise in-flight upgrades.
3. **Finish SQL compatibility.** Add owner-or-share table declarations and generated sharing
   rules, both legacy ledger adapters with the release's compiled inventory, and a startup audit
   of database ledger checksums. New modules currently support owner-only tables and the new
   ledger. The inventory type alone does not implement legacy execution.
4. **Harden recovery.** Make snapshots and activation recoverable across a process crash;
   cover failures between migration, catalog commit and filesystem changes. Test multi-table
   foreign keys, identity/sequence defaults, unusual constraints and purge rollback. Add snapshot
   retention, cleanup, discoverability and explicit restore APIs; the required thirty-day
   retention policy is not implemented. No production recovery claim is made here.
5. **Assemble the host.** Add authenticated route dispatch, per-account enable/disable, the
   production trusted registry configuration, host startup wiring, periodic refresh, persisted
   verified metadata for startup checks, warnings/activity records and update scheduling. The
   library accepts a trusted first-party key from its caller; a production release still needs
   the compiled trust anchors. No HTTP endpoint, sign-in or other-device path was added here.
6. **Finish registry behavior.** Apply publisher-conflict checks across all configured registries
   automatically, not only through the supplied helper. Add signed root-rotation semantics,
   install-local signing, a command interface for mirror/import/list operations, and tests for
   self-hosted HTTPS transport. Folder registries and mirrors are tested; the network transport
   has not been exercised against a live registry.
7. **Finish format and runtime checks.** Add the previous supported ABI, a persistent compiled
   cache under the cache folder, strict schemas for the remaining nested manifest metadata,
   stronger provider/model-name checks, bounded backend waits, streaming hash/download handling and broader malicious
   archive/SQL tests. Review the migration subset before freezing it for publishers.
8. **Complete independent review and delivery.** Review the completed scope with Claude, fix
   major findings, publish the final proof recipe, and only then submit one PR and mark JS-43
   ready. No push or merge is authorized from this task session.

This checkpoint follows the brief's instruction to stop at a clean committed point rather than
carry the task through repeated context compactions. It must not be merged as completed Phase 4b.
