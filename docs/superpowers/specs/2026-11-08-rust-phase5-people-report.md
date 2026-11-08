# Rust Phase 5: People & Context

Task JS-45, Card 523. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027).
Release note Category: N/A.

Status: **People part one: internal core and additive host prerequisites.** The coordinator
approved this smaller slice and a fresh part-two task to finish the port. People is not yet
an installable Rust package or reachable through the Rust UI. This report does not claim
full parity, database privacy, live UI or second-device verification.

## Scope and dependencies

Port People as it behaves today. Keep its existing SQL, row privacy, note-backed writes,
Settings pane, tools, job kinds and public contracts. Workshop and Food are excluded.

The branch began at Phase 0a and was advanced to merged Phase 4b main `80aa42123` before
implementation. The package specification, data/install rules, earlier reports and current
People implementation are the design inputs. The Phase 4b report explicitly does not claim
whole-app integration.

The coordinator authorized additive host changes in small commits. Responsibilities were
agreed with JS-46:

| Owner | Responsibility                                                                                                                                                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS-46 | Shared module SDK, filtered/composite-key queries, transactions spanning a guest invocation, parameterized route dispatch, module frame and shared Leptos bridge |
| JS-45 | Pure People core, public People target contracts, chosen-folder account guard, exact tool names and opt-in queue scheduling                                      |
| JS-47 | Generic linked-notes host adapter; People part two will consume its public operations                                                                            |
| JS-44 | Host sign-in, sessions, origin/Host checks and HTTPS                                                                                                             |

Consume the shared checkpoint from main when integrated. Do not copy the SDK or host
implementation into People. The shared SDK contract was first committed as `d549d8d5a` on
the sibling branch; it is not yet a dependency of this checkpoint. For local host validation,
this branch includes JS-46's additive compatibility fix `2c9f140d2`: an account-scoped module
files constructor and its five existing callers. It corrects the Root/Vaults API mismatch;
it does not change canonical account-vault access. Keep JS-46's version when integrating.

## Compatibility inventory

- **Data:** seven `app.person_context_*` tables, owned by People. Package SQL must read the
  unchanged `packages/people/sql/0128_person_context.sql`, declare `core-legacy`, and retain
  the inventory checksum and ledger identity. The current file hash matches the compiled
  Phase 4b inventory. No new table or migration is needed for the port itself.
- **Privacy:** each table enables and forces RLS with owner-only policies for both runtime
  roles. The Rust port still needs failing-first read/insert/update/delete controls for another
  account and an administrator. Static policy inspection is not that proof.
- **Screen:** People has no separate page today. Its pane is in Settings, Memory & context,
  People. Keep folder browsing, refreshing from notes, match review, rename/archive, add-person
  and the default-on Suggest note updates behavior.
- **Notes:** the canonical source is the chosen People folder inside allowed notes roots,
  not module-local storage. Keep the `people-notes-folder` preference and legacy-relative
  resolution, canonical-ID rules, duplicate/missing-note review, unused-filename selection,
  coordinated note edits, managed-section boundaries and ingest nudges.
- **Queries:** name-prefix search and ordering, identity lookup, aliases, recent links and
  composite indexing keys must work beyond the old host's capped table scan. Merges, splits,
  projections and indexing writes must retain their single-transaction behavior.
- **Tools:** retain `people.resolve`, `people.getContext`, `people.listRecent`,
  `people.acceptMatch`, `people.rejectMatch`, `people.merge` and `people.splitIdentity`.
  Preserve the current route/app-action blocks and approval behavior; listing a tool does not
  authorize bypassing those restrictions.
- **Jobs:** retain `person-index` and `sync-person-memory`, metadata-only envelopes,
  idempotency keys, batch cap of fifty and the fifteen-minute index cooldown. The current
  memory-sync worker is a stub; parity does not mean inventing a memory write.
- **Public module boundary:** expose People lookups through declared versioned APIs, including
  the existing `findPeopleByNames` semantics: at most thirty requested names, exact active
  name/alias matches ignoring case, first-created person order, one result per person and
  first nonempty summary lines capped at two hundred characters. Consumers must not query
  People tables or import its private source.

## Host/core split

Section 7 of the package specification keeps these areas in the host:

| Core area                         | Why it stays in the host                                         |
| --------------------------------- | ---------------------------------------------------------------- |
| Sign-in, accounts, settings frame | Authenticate the actor and control install/account configuration |
| Chat and agents                   | Carry turns, approvals and account agent execution               |
| Memory and embeddings             | Supply shared retrieval and indexing services                    |
| Vault                             | Confine file access and coordinate account note writes           |
| AI router                         | Select configured capabilities without module-held credentials   |
| Connectors framework              | Broker account connections without exposing tokens               |
| Notifications                     | Deliver account-scoped messages                                  |
| Job queue                         | Enforce actor envelopes, scheduling and retries                  |
| App map                           | Combine truthful core and package declarations                   |
| Workflows and structured state    | Own shared orchestration and preferences                         |
| Today shell                       | Compose module contributions in the app frame                    |

People owns its contact projection, matching and canonical-note behavior; it consumes those
host services through SDK ports. Other feature modules remain packages under the approved
module spec.

## Delivered in part one

The pure crate ports identity normalization, candidate signatures, signal grouping, note
frontmatter parsing/formatting and managed-section replacement. It now also creates canonical
note content, updates a freshly supplied note while rechecking its canonical ID, chooses
between the two legacy destination names and plans refresh projections/review candidates.
Five native tests cover these decisions, including empty-file collisions, human body retention,
changed IDs, duplicates and missing notes. They do not prove host-coordinated file writes.
Ninety-two differential fixtures come from the current TypeScript functions, including Unicode
whitespace and UTF-16 sorting. The generator is in `modules/people/tools/core-vectors.ts`.

The additive vault constructor now binds allowed notes roots to an authenticated account and
opens only an existing selected folder through the confined root API. It does not create a
folder or turn module storage into canonical notes storage. Seven tests cover owner access,
cross-account reads and writes, containment, missing folders, protected canonical vaults and
symlink selection. With the guards removed, the cross-account read/write and containment/link
tests failed; restoring them passed the vault suite (fifteen tests including the shared module
files constructor). This tests the new constructor only: the notes host adapter and database
RLS remain unproven. The existing vault component-check/open race described in its crate
documentation is unchanged. The guard is `AllowedRoots::for_account` plus
`VaultContext::at_allowed_root` in `rust-spike/vault/src/allowed_roots.rs`.

The host's lowercase-only tool-name validation rejected existing names such as
`people.getContext`. A separate tool-name helper now accepts the existing camelCase names;
module IDs and file paths keep their original validators. The standalone legacy-name test
failed under the old rule and passed after the change. The full manifest regression and host
native suite also passed after applying the shared assembly compatibility fix.

The host has an opt-in `jobs/enqueue-options` operation for delayed, idempotent jobs. Its
strict envelope preserves typed metadata validation and the host-owned actor/module fields.
The existing `enqueue` branch is unchanged. Parser tests first failed on the unsupported
operation, then passed with the extension. A real Wasm guest drove JobPorts and PostgreSQL
through verify-gate: the requested time was stored, duplicate command keys were deduplicated,
other actors/queues stayed independent, future jobs were not claimed early, and legacy
immediate enqueue still created separate runnable jobs. The envelope and invocation are in
`rust-spike/module-host/ENQUEUE_OPTIONS.md`.

Queue deduplication includes completed records. A new logical command needs a new UUID;
reusing one person/source key forever is not the legacy fifteen-minute singleton cooldown.
The package must preserve that cooldown deliberately in part two. Enqueue and module database
writes are not claimed to be atomic together.

The planned public API and consumer contract are documented in `modules/people/PUBLIC_API.md`.
This is a target contract, not a claim that package handlers exist yet. No screen, navigation,
setting or user-facing capability ships in this slice, so the current app map is unchanged.
Part two must add the package metadata in the same change as its working surfaces.

### Minor compatibility gaps from independent review

The first review found no major or blocking issue in the approved slice. Two rare pure
note-format differences remain for part two; the ninety-two vectors do not cover these cases:

- Managed text containing JavaScript replacement tokens such as `$&` or `$$` is inserted
  literally by Rust. Current TypeScript expands those tokens, which can duplicate an old
  managed section or change dollar signs. Keep this gap visible rather than claiming full
  parity or silently copying the existing note-corruption behavior. Part two must add an
  explicit regression and settle the compatibility behavior before full-parity acceptance.
- Embedded carriage returns and Unicode line/paragraph separators inside frontmatter values
  are accepted by Rust but rejected by TypeScript's line patterns. Add differential fixtures
  and narrow the Rust parser in part two. Ordinary CRLF endings are already covered.

These are below the task's must-fix review level and are deferred with the rest of complete
People parity. This slice does not expose the new note writer to users.

## Verification

From `~/Jarv1s`, the pure crate's README gives the native test, strict Clippy, formatting and
TypeScript fixture-regeneration commands. Native host tests run with
`cargo +1.95.0 test --locked --manifest-path rust-spike/module-host/Cargo.toml`;
database/live tests in that command are deliberately ignored, not counted as live proof.

The real queue test passed using the supported isolated runner:

```sh
CARGO_BUILD_JOBS=2 scripts/run-gate.sh start --gate test:module-enqueue-options
scripts/run-gate.sh wait --follow
```

The proof artifact records real failing/passing output and the final check results. Neither
pure fixtures nor the queue test is proof of People persistence or the installed application.

## Exact continuation plan for People part two

1. **Integrate public host contracts.** Consume JS-46's merged SDK, typed filtered/composite-key
   queries, guest-invocation transactions, `finish_call`, parameterized dispatch, shared frame
   and context ports. Context supplies the authenticated actor, current UTC time and UUIDs.
   Read `rust-spike/module-host/EXTENDED_HOST.md` once merged. The SDK currently supplies pure
   `Host::call` contracts; its generated Rust component-ABI guest binding is still continuation
   work. Complete that seam additively before building the People component. Keep legacy
   assembly working. Consume JS-47's linked-notes adapter instead of duplicating
   its filesystem implementation. The trusted resource is `people-notes`, mapped to the
   existing account preference `people-notes-folder`; resolve legacy relative folders against
   `notes-source-path`. Host configuration chooses per-account allowed roots, never a guest.
2. **Implement persistence and public APIs.** Use the seven existing tables and unchanged
   `0128_person_context.sql` bytes, with `core-legacy` inventory/checksum and ledger identity.
   Port projections, identities, links, match review, merge/split and composite indexing
   state through SDK ports. Preserve response shapes, ordering, limits and IDs documented in
   `PUBLIC_API.md`. Implement `findPeopleByNames` for Tasks and other consumers through the
   declared API; consumers must not import People internals or query its tables.
3. **Connect canonical note mutations.** Feed fresh note contents into this slice's decisions.
   Use the linked-notes adapter's list/read/compare-write/delete contract, bounded access,
   canonical-ID recheck, collision-safe destinations and call finalization/compensation.
   Preserve human text, missing/duplicate-note review and ingest nudges. Do not claim a
   distributed filesystem/database transaction; prove conflict and failure behavior explicitly.
4. **Implement tools and jobs.** Keep the seven exact tool names, approval rules and blocked
   chat app-actions. Port `person-index` and the existing `sync-person-memory` stub with
   metadata-only payloads, actor routing, fifty-item batch cap and fifteen-minute cooldown.
   Use `enqueue-options` command identity without turning permanent queue deduplication into
   permanent suppression. Prove retries, source versions, repeated indexing and delayed claims.
5. **Build the real module package and Settings pane.** Add its manifest, icon, changelog,
   `wasm32-wasip2` component build and installation checks using the Phase 4b host. Keep People
   under Settings → Memory & context, with the existing controls and default-on suggestion
   setting, using the shared Leptos kit/frame. Add truthful app-map navigation, settings,
   features, errors and remediations in that same change. Workshop and Food stay excluded.
6. **Prove full parity and privacy.** Extend the parity harness to compare persisted rows and
   responses with current People, including the two note-format gaps above. Through
   verify-gate, observe the same privacy tests fail
   without protection and pass with it: other-user and admin reads/inserts/updates/deletes,
   both runtime app and worker roles, default owner-only behavior. This slice's chosen-folder
   tests do not substitute for database RLS or linked-notes integration proof.
7. **Prove the assembled application.** Install the package on the running Rust app, sign in,
   exercise the real People Settings and chat paths, then exercise from a second device over
   the approved LAN/tailnet HTTPS and trusted-origin path. Coordinate with JS-44's sign-in and
   network work. Capture real UI screenshots and assertions, remove disposable data, run
   project checks, obtain independent review, publish proof and request acceptance for part two.

The next task must not close full People parity until steps one through seven are proven.

## People part two progress (JS-50)

The continuation starts from merged shared-host checkpoint `1ff33decd` (PR 4044).
Its report is `2026-11-08-rust-phase5-tasks-report.md`; there is no separate Phase 4c
report at this baseline. The generic Notes adapter was absent at that baseline. Its merged foundation from
PR 4047 is now consumed unchanged; People does not duplicate its filesystem implementation. People
preferences remain in `app.preferences`.

The frontmatter gap above now has eighteen additional differential fixtures for
embedded, leading and trailing carriage returns and Unicode line/paragraph separators.
The new fixture first failed on an embedded carriage return; the narrowed Rust parser
then passed all one hundred and ten pure differential cases. A separate regression
keeps dollar replacement tokens literal and proves that repeating a managed-note
update does not duplicate human text. This is a deliberate correction to the legacy
JavaScript replacement behavior, not a claim of byte parity for that corrupting case.

### Decision for Ben: generated guest bindings

Do not add new third-party packages without Ben's approval. No generator was installed
for this continuation. `wit-bindgen`'s Rust generator would generate canonical ABI
imports/exports, string/result ownership and component type metadata from the host WIT,
and implement the shared SDK's `Host::call` edge for a compiled Rust guest. The existing
handwritten WAT component path remains available for host verification. The later compiled
guest checkpoint below adds a handwritten ABI without installing a generator. A Wasm trampoline
calling a native test driver is not proof of a compiled People guest, package installation
or the real application. Installing a generator would not itself prove any of those.

Full People parity remains open until all seven continuation steps are demonstrated.

### Native persistence and privacy checkpoint

This checkpoint adds a partial People repository through the merged SDK's typed-query and
context ports. It includes person list/read/detail, identity-first exact resolution,
identity/link reads, email identities, projection writes, find-or-create, note-identity
removal and the unchanged composite indexing-state key. Every read and update includes
owner filtering; the host supplies insert ownership and finalizes the invocation transaction.
The legacy SQL bytes, seven-table inventory and `core-legacy` ledger identity remain unchanged.

Two additive query options preserve legacy behavior: exact lower-case text equality without
SQL wildcard expansion, and explicit null-first ordering. Existing query defaults remain
null-last. Native lists page beyond the host's thousand-row select cap. Empty optional filters
and a zero limit retain the old repository's behavior. The differential oracle found that
confidence is a decimal string on the old wire path; the Rust response and public contract
now preserve that actual value. Timestamp responses preserve JavaScript millisecond UTC form.

The isolated database check runs the actual TypeScript repository/service and native Rust
repository against the same synthetic committed rows. It compares read responses exactly,
then compares projection responses and persisted rows using the existing parity harness's
ID/time normalization. It also exercises repeated composite-state updates, forged person IDs,
rollback after a projection and a list of more than a thousand rows. The handwritten Wasm
trampoline invokes a native driver through the real shared ports and call scope. This is
native persistence evidence, **not** the complete HTTP parity harness or a compiled guest.

The separate privacy matrix runs the unchanged tables under both runtime app and worker roles.
For another user and an instance administrator it runs the same read/insert/update/delete
checks with RLS temporarily removed in the disposable gate database, observes violations,
restores forced RLS and requires no violations. Owner controls prove allowed operations and
reject owner reassignment. Events preserve their existing append-only grants: removing RLS
exposes reads/inserts, while update/delete remain denied by grants. Test mutations roll back;
synthetic users are removed. No installed application's database is used.

No app-map surface changes in this checkpoint: the installed product gains no screen,
setting, tool or package yet. Step five must add the Rust package's truthful metadata with
its actual Settings pane. Existing People declarations are not evidence of a Rust surface.

### Remaining work by continuation step

1. The repository consumes the shared query/context contracts. The compiled guest now uses
   the handwritten `Host::call` ABI described below; the required `wasm32-wasip2` build is
   still open. JS-47's merged generic linked-notes adapter is now consumed below. No generator package is authorized.
2. Native identity/link mutations, match review and merge/split now have the differential
   checkpoint below. Register them through actual handlers, complete indexing response
   mapping and prove the remaining error/edge cases. `findPeopleByNames` runs in the
   compiled guest; installed public API routing remains open. Projection upserts now use
   an atomic conflict update and a concurrent-call regression. Multi-page reads use the host's read-committed transaction;
   a stable snapshot under concurrent changes remains unproven. Register responses/errors
   through actual handlers and complete indexing response mapping.
3. The canonical-note service now consumes the merged adapter as described below. Complete
   the legacy rename/archive projection fallback, safe HTTP errors and actual ingest nudges.
   The service checkpoint does not prove crash recovery or unlimited-folder parity.
4. Connect all seven tools and both job kinds to real host dispatch. Verify approval blocks,
   metadata-only payloads, retries, source versions, cooldown, repeated indexing and delay.
5. Complete the shipping component build, installable package and shared-frame Settings pane; retain preferences
   in `app.preferences`. Update app-map navigation, settings, features and recovery metadata.
6. Extend the HTTP parity harness across all remaining behavior. The new native differential
   and failing-first database matrix cover only the bounded checkpoint described above.
7. Run the authenticated Rust app, exercise real People Settings and chat, then prove the
   HTTPS/trusted-origin path from a second device. No UI screenshot or device proof exists
   for this checkpoint. Do not request full People acceptance on its strength.

The full continuation is too large for the requested bounded session. Preserve this tested
checkpoint and continue from the list above; it is not a completed People part two delivery.

### Checkpoint verification

Observed locally on this work: the People native tests (including all one hundred and ten
TypeScript differential vectors), SDK contract tests, strict People/host clippy, Rust
formatting, root lint, Prettier, file-size check and complete project typecheck passed.
The narrowed database gate passed with its protection-removal controls and restored-policy
checks, and removed its disposable database container with exit code zero. These checks do
not replace CI or any of the missing assembled-application proof.

Reproduce database verification with `scripts/run-gate.sh start --gate
rust-spike/module-host/tools/people-gate.sh`, followed by `scripts/run-gate.sh wait --follow`.
Set `CARGO_TARGET_DIR` outside the checkout and use the pinned Rust toolchain. The recipe
proof records actual command output and the unproven areas; its files stay outside commits.

### Compiled guest checkpoint

The SDK's optional `component` feature now has handwritten canonical ABI imports, owned
string/result allocation and finalization, and an export macro. The additive host build
wrapper turns the compiled Rust core into the existing Moss WIT component using the already
declared Wasmtime and WAT crates. It rejects imports outside shared memory and Moss ports,
then validates the completed component. Legacy assembly remains available. No third-party
package or generator was installed.

The real compiled People guest handles `resolve`, `getPerson` and
`listEmailIdentityValues`. The boundary check exercises long Unicode inputs/results, missing
capabilities, invalid parameters, host errors and call completion. The disposable database
gate compares those guest responses exactly with the actual TypeScript service/repository
on the same synthetic legacy rows, including literal wildcard characters, rejected identities,
archived people and null-first recent links. Other-user and administrator reads return no
private person or email data. The separate failing-first RLS matrix remains the privacy
protection-removal proof; a passing guest read is not a substitute for that matrix.

This build uses an already available `wasm32-unknown-unknown` standard library and the
handwritten wrapper. The spec's `wasm32-wasip2` shipping build remains unproven. This is not
an installed package, route parity, Settings/chat integration or second-device proof.
The generator decision for Ben remains open: generated ownership/type metadata would replace
this manually maintained ABI; it would not supply the missing module behavior or live proof.

### Persistence mutations and public name lookup checkpoint

The compiled guest now also handles `findPeopleByNames`, compared with the current
TypeScript helper on the same committed PostgreSQL rows. Cases cover exact active
names/aliases, case folding, duplicate requests, the raw thirty-name cap, wildcard
characters, first-created ordering and summary truncation. Another account and an
administrator receive no matches. One exceptional compatibility gap remains: if the
legacy UTF-16 summary cutoff splits a surrogate pair, Rust rejects the response because
the shared JSON value model cannot represent the lone surrogate. Ordinary Unicode
summaries are covered; this is not full Unicode wire parity.

The internal repository now supports identity/link/source/candidate writes, candidate
review, merge and split. A rollback-only TypeScript oracle executes those existing
repository/service operations and records responses plus all seven tables. The native
Rust driver executes the same workflow through Wasmtime and shared transactional ports;
the existing parity harness compares generated IDs, timestamps and persisted rows.
Integral JSON floats normalize to JavaScript's integral number spelling without rounding
large integers. Mutation handlers, canonical-note coordination and HTTP parity are still open.

Typed queries gain a bounded owner-scoped conflict-update option for atomic projection,
link, candidate and composite-state upserts. The guest cannot change ownership. A pair of
concurrent host calls proves both projections succeed for the same new person ID. Active
unique email/source identities retain conflict-ignore then update because their legacy
unique index is partial. Background calls now keep the configured worker database role;
a real compiled guest read first failed under the old hardcoded app-role switch and passed
with the pool's actual runtime role. This does not change module-ledger role selection.

The current disposable database run passed compiled read/name responses, native mutation
responses and persisted rows, concurrent projections, rollback, forged IDs, paging and the
failing-first raw RLS matrix. It does not prove installed public API routing, tools/jobs,
linked-note operations, a package or a live Settings/chat/device path. No screen or setting
ships at this checkpoint, so no app-map surface has been added yet.

### Linked canonical-note service checkpoint

People now consumes the merged Notes foundation from PR 4047 through its public host
contract. Trusted composition maps `people-notes` to the unchanged `people-notes-folder`
account preference, with legacy relative folders resolved against `notes-source-path`.
Allowed roots remain trusted account configuration. No preference moved to module storage.
The guest performs no filesystem I/O.

Create, update, archive and refresh use fresh host reads, canonical-ID checks, occupied-file
checks and compare-write. Projections and note alias/email identities use the existing legacy
tables in the same invocation. Phones remain note text, matching the old service. Refresh
retains malformed-note counts, missing/duplicate-ID review and missing-canonical-note review.
Guest scans refuse more than two thousand entries or four MiB of text rather than returning
partial projections. These additional bounds remain a compatibility limit, not a claim of
unlimited-folder parity.

The first compiled-note check failed on create with the old guest. The initial follow-up
also loaded the old artifact because the component wrapper was still compiling; that result
is not a verification of the new implementation. Subsequent checks wait for build completion
and record the actual component hash. The new guest imports the generic vault port, so its
read-only fixture manifests now declare that import too; their read tests still connect no
filesystem service.

The new integration check uses the compiled guest, merged adapter, real `app.preferences`
and legacy database tables. It compares canonical create/update/archive responses and note
bytes with the actual TypeScript `PeopleNotesService` running through `VaultContext` in a
rollback-only oracle. Fault controls interleave a real external edit and force a failure
after actual file publication. A separate fault interrupts after projection and
note-identity deletion; its first test implementation incorrectly stopped before projection
and left the fault armed for refresh. The corrected run reaches the intended later failure.
The test also attempts projection using another owner's
real person ID after publication. Expected behavior is to restore unchanged originals, retain
external edits, reject the foreign projection and leave database state unchanged. These are
file compensation checks, never a distributed transaction or process-crash recovery claim.
The compiled note workflow passed in the corrected disposable database run, including
the real TypeScript response/byte comparisons and both publication and projection failures.
The merged adapter's own failing-first preference tests are included in the People gate.

Partial route entry points exercise this service; they are not installed HTTP dispatch.
The old rename/archive fallback to projection-only changes when canonical notes are
missing/unavailable, safe HTTP status/error mapping and actual ingest nudges still need
implementation. The adapter's read-only-folder limitation, external-editor races and lack of
crash reconciliation remain as documented in `modules/notes/HOST_ADAPTER.md`. Package,
Settings, tools/jobs, app-map surfaces, full HTTP parity and actual UI/device proof remain
open. **Do not mark JS-50 Ready on this checkpoint.**
