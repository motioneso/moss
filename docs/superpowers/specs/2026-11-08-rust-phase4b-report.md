# Rust Phase 4b: module host and package format

Status: requested host integration implemented. The proof artifact records the final checks and
independent review verdict; this report does not claim whole-application parity.

Part of https://github.com/motioneso/moss/issues/4027. Card: 511. Release note Category: N/A.
The changes stay under `rust-spike/module-host/` and this report. No sibling phase source,
installed app, production database, registry screen, Workshop or Food port is changed.

## What changed

A signed sample package now installs and runs through the real Wasmtime host, with persistent
account data. The host has concrete general service adapters, joins the existing job queue and
AI router, and recovers interrupted module changes before accepting calls.

| Area             | Delivered behavior                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packages         | Deterministic tar/zstd packing; bounded reading; hashes and Ed25519 signatures; strict manifest and nested app-map declarations; declared assets; archive path/type/order checks                                                                  |
| Runtime          | Versioned WIT interfaces; only declared Moss imports; no WASI linker; fuel, memory, message and epoch limits; authenticated persistent compiled cache                                                                                             |
| Local services   | Account-scoped key-value and files; explicitly declared install-wide key-value data; declared account-notes reads; bounded HTTPS methods and approved-host redirects                                                                              |
| Other services   | Encrypted credential broker and form token exchange; AI routing and embeddings; notifications, handed attachments, events, public APIs, tools, action policy and activity data                                                                    |
| Queue            | Real Phase 2b enqueue, cancellation, cron schedules and schedule cancellation; host-created actor/hash envelopes; pause policies; account choices; compatible upgrade reconciliation; Wasm job execution                                          |
| SQL              | Restricted new migrations; owner-or-share rules with forced RLS; both historical ledgers; compiled identities for 374 migration files from 27 modules; startup hash audits; numeric forward ordering                                              |
| Existing data    | Trusted Rust versions of the frozen meeting history and minimal-projection sidecars, in the SQL transaction; downloaded scripts never execute                                                                                                     |
| Recovery         | A write-ahead operation journal; durable snapshots; repeated restore; schema, rows, sequences, generated columns, named indexes/keys, grants, policies, incoming foreign keys and ledgers retained; thirty-day expiry and explicit restore APIs   |
| Registry         | Signed identity/index/package checks; expiry and serial floors; immutable published versions; sticky revocations and root-authorized lifting; configured publisher conflicts; signed root transitions; folder/offline mirrors and self-hosted TLS |
| Installation     | Staged install/upgrade/remove/purge; retained-data reinstall; dependency checks; exact pins; per-module digest-bound list approvals; failure leaves an existing pin intact                                                                        |
| Application join | `Application::open`, authenticated declared route dispatch, worker dispatch and per-account enable/disable; permission and update information as data                                                                                             |

The four bridge manifests compile unchanged Phase 2b sources. They do not fork that
implementation or edit its workspace. The server must call the synchronous host interfaces on
a bounded blocking executor. Application migration bootstrap applies the supplied schema
constants before opening the host.

## Verification and actual failures

Tests use fresh synthetic users and signing keys. The packaged sample is compiled, signed,
read from its registry, installed to disk and executed by Wasmtime. Its host port writes real
account data. The real PostgreSQL gate also executes a Wasm job from the Phase 2b queue.

The expanded tests caught and fixed these faults:

- A PostgreSQL JSONB round trip changed manifest object order and therefore queue identity.
  Manifest hashing now canonicalizes nested object order before hashing.
- Folder registry settings could not serialize as an internally tagged newtype. Their source
  representation now round-trips and survives reopening and network outage.
- Adopting an existing module initially omitted its tables from the first snapshot. The release
  inventory now discovers existing tables before an ownership mirror has been written.
- Restoring legacy tables initially missed dependent external row policies. Recovery now saves
  and recreates those policies and incoming foreign keys after all referenced tables exist.
- A provider response could echo an encoded credential in an object key. The same real-Wasm
  test failed before the fix; response redaction now visits keys as well as values.
- Core ledger rows were captured without being reinserted on restore. Recovery now restores
  those exact rows and refuses conflicting identities.
- A schedule-only module could create a schedule but not execute its job. A real scheduler and
  Wasm regression failed before the fix and passes both before and after an upgrade. Direct
  enqueue remains refused without that separate permission.
- Upgrade data migrations silently changed no existing rows under forced row security. The
  same two-account update/delete regression failed before the fix and now passes. The host
  temporarily relaxes FORCE for the table's restricted owner inside the migration transaction,
  restores it before commit, and keeps runtime row policies enabled.
- A signed package could not predict future attachment UUIDs. The installed-package regression
  failed before the fix; the stable `attachments` resource `handed` now permits future uploads.
  The same real guest refuses other accounts, other modules, unhanded IDs and undeclared scope.
- Removal could return before recovering an interrupted install. Its regression failed with
  the recovery journal still present; removal now recovers before reading the catalog.

The database gate covers ordinary and sharing access, health-specific upgrade rollback,
serial/identity/generated columns, repeated simulated interrupted-change recovery, retained
purge/reinstall, queue pause/account disable/schedules/upgrades, original Tasks migration hashes,
legacy adoption restoration and the two frozen meeting backfills. The gate uses a fresh server
and deletes it afterward. Recovery tests simulate the persisted crash boundary; they do not
kill the host during every possible filesystem operation.

The HTTPS proof starts an actual temporary TLS registry on a devports-claimed port. System
trust rejects its test certificate; private-network access must be allowed; adding that
source's public CA permits signed metadata and package retrieval. No system CA or global tool
installation is changed.

Twelve disposable removal controls require an assertion failure after removing signature checks,
the package hash, the import allowlist, publisher-prefix checks, private-address classification,
compiled-cache authentication, credential response redaction, one-use tool approval, publisher
provenance, actor/role selection, handed attachment ownership or attachment resource permission.
The normal protected tests then pass. The import control checks refusal before guest execution;
it is not a proof against every possible runtime attack.

The service integration tests execute real Wasm and installed-module dispatch. Credential and
AI upstreams are explicit test stand-ins. They prove host binding, response handling and router
selection in those tests, not a successful call to a real credential or model provider.

Reproduction commands are in `rust-spike/module-host/README.md`. Final command results and the
precise reviewed commit are recorded in the proof artifact before acceptance.

## Scope boundaries and proof limits

- This library is ready for the sibling authenticated server to call; it does not itself open a
  public HTTP listener or replace Docker. Phone/tailnet sign-in, trusted origins and HTTPS for
  the whole Rust app belong to that server/installer work and are not proved by these tests.
- Registry screens and module-frame screens require their agreed mockups. No UI proof is
  claimed here. Module app-map data stays in the sample manifest and validated package metadata.
- Interface version one is the first real ABI. There is no released previous ABI to implement;
  when version two exists, version one must remain supported. No fictitious compatibility ABI
  was added.
- Release publishing, installer-bundled default packages, automatic startup/quiet-time timers,
  and the private local-builder workflow are later application/release joins (M7, M8 and M11).
  The application supplies trusted keys and invokes refresh/update APIs; no production root or
  install-keychain integration is invented in this library.
- Registry transfers are bounded in memory, rather than streamed to a temporary package file.
  DNS resolution uses the platform resolver. These tests do not prove a strict deadline for a
  stuck platform DNS call.
- Privileged PostgreSQL connections use the managed local database's existing `NoTls` approach.
  Remote PostgreSQL transport is not supported or proved by this adapter.
- No Windows/macOS installation run, real model/credential provider call, all-module data parity
  run, malformed legacy Unicode projection run, or exhaustive power-loss test is claimed.

## Review history

Claude reviewed `6092ad216` and `3b54c02a5`. Both rounds identified the earlier checkpoint as
incomplete. The continuation implements the service, queue, SQL, recovery, approval and pin
work that those checkpoints lacked. The third review of `46f981865` identified the schedule-only
and data-migration failures above. They were reproduced and fixed in `f44c30a85` and `94d0dcfb1`;
the minor removal-recovery finding was reproduced and fixed in `5169e8d96`. A further review of
the corrected commit `415ea990b` found the attachment permission fault above. Its failing-first
fix is implemented. The final independent verdict is recorded in the proof artifact.

Two suggestions below the must-fix threshold remain explicit: calls still reverify package
files to detect disk changes, with a cost that grows with package size; exhaustive partial-restore
failure coverage remains limited. Snapshot expiry and repeated database restore do have tests.

The earlier suggestion to delete purge snapshots immediately was rejected: design section 3.9
requires thirty-day recovery retention. Expiry and cleanup are now implemented. The PostgreSQL
transport assumption and import-proof limits remain explicit above. No push, merge or app
installation has been performed by this task agent.

The fourth review also noted minor follow-ups: purge retains account enable preferences and job
history, and the migration connection must be a trusted bootstrap connection able to read the
forced-RLS catalog. The existing API separates that connection from account runtime pools;
credential validation and preference reset on purge are not claimed. The review's suggested
app-map path collision was unconfirmed: this library validates package metadata and does not
merge it into a running UI. Namespace collision handling remains a server/UI join requirement.
