# Rust Phase 5: People & Context

Tasks JS-45 (part one), JS-50 (part two), JS-57 (part three), JS-58 (part four),
JS-69 (part five) and subsequent continuations through JS-106 (part fourteen), Card 523.
Part of [issue 4027](https://github.com/motioneso/moss/issues/4027).
Release note Category: N/A.

Status: **Installed People package checkpoint; full parity remains open.** The latest
continuation sections below record the current verification and remaining work; earlier
sections are historical receipts. Part eight's note-edit behavior and evidence are retained.
Part nine adds the packaged-worker permission fix and broader creation/refresh comparisons.
Part ten restores manual source indexing; its qualification is recorded below.
The authenticated Rust application still needs to compose People into Settings and chat.
Full behavior parity, live UI and second-device HTTPS verification remain open. The
continuation brief permits a bounded checkpoint before a second compaction.

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

### Generated guest binding decision (superseded)

The initial checkpoint did not have approval for a generator. Ben explicitly approved
`wit-bindgen` on 2026-11-08, confined to this worktree or scratch space. The later generated
guest checkpoint records its use. `wit-bindgen`'s Rust generator supplies canonical ABI
imports/exports, string/result ownership and component type metadata from the host WIT.
A small People adapter implements the shared SDK's `Host::call` edge with those imports. The existing
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
   the handwritten `Host::call` ABI described below and the generated
   `wasm32-wasip2` path verified below. JS-47's merged generic linked-notes
   adapter is consumed unchanged. Ben has approved the pinned generator dependency.
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
4. The compiled guest now implements all seven tool execution functions, as described below.
   Connect them and both job kinds to installed host dispatch. Verify approval blocks,
   metadata-only payloads, retries, source versions, cooldown, repeated indexing and delay.
5. Package the verified component build and complete installation and the shared-frame Settings pane; retain preferences
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
At that checkpoint the generator decision remained open. Ben subsequently approved
`wit-bindgen`, as recorded below; its ownership/type metadata does not supply the missing
module behavior or live proof.

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
implementation. The adapter's limitations at that checkpoint are documented in
`modules/notes/HOST_ADAPTER.md`; the later dependency refresh below consumes its Unix
read-only-folder fix. External-editor races and crash reconciliation remain open. Package,
Settings, tools/jobs, app-map surfaces, full HTTP parity and actual UI/device proof remain
open. This checkpoint alone does not establish full People parity.

### Generated guest and tool-execution checkpoint

Ben approved `wit-bindgen` on 2026-11-08. People now declares optional, pinned version
`0.57.1`, with its normal locked transitive dependencies. Generator dependencies, the
pinned compiler's target and build outputs were kept in task-local scratch caches; no
program, package or compiler target was installed globally. The generator consumes the
shared host WIT and selects only the People database, context and linked-notes ports.
Its generated code owns canonical imports/exports, allocation and returned strings/results.
The SDK's handwritten component path is retained for comparison and compatibility.

The first generated `wasm32-wasip2` component was rejected by the unchanged host validator:
the Rust standard library brought in a WASI poll import. Trimming and abort-on-panic did not
remove that boundary. The additive build wrapper now closes WASI core function imports
with internal trap-only functions, then lifts the generator's canonical exports. It gives
no WASI service to the host linker. A normal People operation must use the declared Moss
ports; an attempted WASI call fails the invocation. Unknown foreign imports remain errors.
The note parser uses a tree map so it does not request randomized hash seeds.

The real generated People guest passed the existing canonical ABI check, including long
Unicode strings, malformed inputs, missing capabilities, redacted host errors and call
finalization. Build-wrapper fixtures separately check that a closed WASI call traps and a
foreign import is rejected. These fixtures are boundary tests, not product or privacy proof.
The trap assertion was observed failing after replacing the traps with zero-returning
functions, then passing after restoring the same source. The restored implementation is
committed; the weakened control is not shipped.
The complete generated build is reproducible through
`modules/people/tools/build-generated-component.sh`; its optional guest cache variables are
documented in the People README. No new third-party CLI is required.

All seven existing tools now have execution handlers in the compiled People guest. The
rollback-only oracle calls the actual TypeScript tool execute functions, then the Rust test
runs the same requests on their original synthetic database rows. It compares response
shapes, citation tokens, column order, match review, merge and identity split through the
existing parity normalizer. It verifies that refusing an explicit merge/split candidate
leaves that candidate pending, and exercises other-user and administrator read/mutation
attempts. The old compiled component first failed because the tool handler was unavailable.
The first new test reached all tool responses, then exposed an enum-to-text decoding error
in its own assertion. After correcting that assertion, the handwritten guest run passed.
These are execution-seam checks; installed chat, its approval policy and app-action blocks
are still unproven.

The first complete generated-guest run stopped at the canonical-note response comparison:
compilation and other suites had separated the real TypeScript and Rust operations by more
than ten minutes. Both normalizers incorrectly used the later comparison time. Each oracle
now records its own operation start, and each Rust workflow captures its start before
running. The existing ten-minute normalization window and comparison fields are unchanged.
Pre-existing synthetic rows have explicit historical timestamps, so they remain exact
shared fixtures rather than being treated as fresh writes on only one side of a long run.
This is a test-clock correction, not a People behavior change.

The complete generated-guest People gate then passed all seven suites, with eight tests
and exit code zero. It exercised the real generated ABI, public APIs against TypeScript,
canonical-note responses and bytes, conflict/compensation cases, persisted mutations,
all seven tool executors, and the failing-first legacy-table and preference privacy
matrices. Both runtime roles were checked, including other-user and administrator access.
The throwaway database container was removed. The first clock-anchor run still failed
on a pre-existing tool link's timestamp; the successful confirmation includes the fixed
historical fixture dates in `55c6503e8`.

The successful run is `20261108-055807-EpLAN0`, with input fingerprint
`sha256:4c2043d149b269adbe3a5aeba7962df6079b875eed3be600ecd9f23ffd8b8c5e`.
It began on `5ba163741` with the clock/fixture changes present; those source changes were
then committed as `55c6503e8`. Its pinned generated component digest is
`sha256:b9e8557b3e782fae4d7d2828432f5edc3c4a0196a00ebfcb9b823449adab94ff`.
These are guest/host integration receipts, not an installed package, HTTP parity, CI,
chat approval-policy or UI/device proof. One review round covered the earlier persistence
checkpoint; the remaining round must review the final partial checkpoint before Ready.
Its outcome belongs in the task's review record and proof.

Repository-wide lint passed at this checkpoint. Scoped lint and formatting for the changed
TypeScript oracles, report formatting, both pinned Rust formatting checks and
`git diff --check` passed. Repository-wide formatting and file-size checks subsequently
passed. Type checking must also pass before this partial checkpoint requests acceptance.
The final check results, including checks after the dependency refresh, belong in the
acceptance proof rather than being inferred from the earlier gate receipt.

No installed screen, setting or package ships in this checkpoint, so the existing app map
must not advertise a Rust People surface. Add the package's truthful navigation, settings,
features and recovery metadata together with its working Settings pane in step five.

The remaining work still exceeds a single bounded continuation: finish metadata-only jobs
and provider/indexing dispatch; complete HTTP routes, safe errors and projection fallbacks;
connect shared account preferences and ingest nudges; build and install the real package
and shared-frame Settings pane; extend HTTP parity; and prove signed-in UI/chat plus a second
device over the approved HTTPS path. The assembled shell at this checkpoint still uses its
stub contract; a module frame fixture is not a substitute for that final application check.
All seven steps must be demonstrated before closing full People parity. The user's later
authorization permits JS-50 to request acceptance for this partial checkpoint only.

Before that request, the consumed Notes dependency was refreshed to match the already
merged Notes part-two files on main. This includes per-invocation adapter locks, Unix
read-only-folder support and their tests; People does not maintain a duplicate adapter.
The equivalent legacy runtime-role selection also matches main, avoiding a merge conflict
with the shared-host change. A fresh gate against the final checkpoint and the final review
are recorded in the acceptance proof. No installed UI or device proof is supplied by this
internal checkpoint; those checks remain explicitly assigned to People part three.

PR CI found a shared-SDK source-compatibility regression before acceptance: adding a
required `Order` field broke Calendar's existing struct literals. A dedicated SDK test
reproduced the same compiler error. `Order` now retains its original two fields and default
wire shape. The additive `Client::query_with_nulls_first` method supplies a query-level
`nullsFirst` list; the host accepts only distinct columns already present in the ordering.
People opts into that method for its legacy descending order, while other callers keep
their original behavior. The earlier unfinished review was interrupted so the final review
and rebuilt guest/database proof cover this corrected revision.

The next implementation step is the two job kinds. The merged host deliberately permits
only UUID IDs, flags, counts and fixed choices as queue parameters; its underlying contract
explicitly excludes free text. People must retain the original source hash and optional
source version without coercing them into UUIDs or silently discarding them. Keep that
data behind an account-scoped command reference and make each new indexing cycle a new
command, while retries retain the same command identity. The current checkpoint has not
implemented that command storage/dispatch or the provider seam. In particular, a permanent
queue deduplication key must not suppress later indexing of the same source.
The existing account key-value port locks individual get/set operations but has no atomic
read-modify-write operation. A command collection cannot safely be implemented as concurrent
get/replace calls on one map; its storage seam must preserve simultaneous enqueues.

## People part three: bounded worker checkpoint

JS-57 started from merged People part two, `b854bbd05`. Completing the remaining package,
application wiring and device qualification would require more than the continuation's
allowed context budget, so this is the expressly permitted checkpoint PR. It is not full
People acceptance. No screen or installed setting is added, and the app map must not claim
an available Rust People surface before the package and Settings pane actually work.

The generated guest now executes `person-index` and `sync-person-memory`. It retains the
old worker's signal grouping, projection/identity/link/source/event writes, composite
indexing state, missing-provider no-op and no-write memory stub. A new internal enqueue
interface stores the original source hash, optional source version and reason unchanged
behind an immutable account command UUID. The queue receives only that reference. Each
new logical cycle has a fresh UUID; retries keep their original command and availability
rather than permanently deduplicating a source. Indexing still waits fifteen minutes and
batches still take only their first fifty entries. The four consumer lookup APIs and seven
tool names are unchanged.

The generic host additions are documented in
`rust-spike/module-host/COMMAND_RECORDS.md`. Immutable records use separate UUID files
through `VaultContext`, under account/module storage and a hashed collection name.
LocalPorts' existing process and disk locks span read/create, including independent port
instances. This avoids the concurrent get/replace lost-update problem of a shared map.
Records are limited to sixty-four KiB each and retained until module data purge; aggregate
quotas and completion cleanup are not implemented. They are internal work data, not
canonical notes or account preferences.

The opt-in `AfterCommitJobs` adapter buffers owned-queue publication until the outer
transaction adapter finishes successfully. A trap discards the buffer. The extended host
assembly installs it automatically and checks both deferred and downstream enqueue
capabilities before commit. Provider calls happen before the first People database query.
Memory follow-ups use deterministic child commands and publish after commit. Database
commit and queue publication are not atomic: a publication failure returns an error for
retry, and a process interruption requires queue lease recovery. Re-indexing after such a
retry can append another event, as in the existing at-least-once worker.

The worker oracle invokes the real TypeScript `registerPersonIndexWorker` against disposable
PostgreSQL. Queue delivery and the optional source provider are fixtures. Rust replays the
same sequence through the real generated component, account records, durable queue and
worker-role transaction adapter. It compares all seven table snapshots with the shared
parity normalizer, provider inputs and memory follow-up intent. Cases cover a missing
provider, grouped signals, opaque Unicode hashes/versions, a later version of the same
source and an empty batch. An injected failure after an actual event insert checks database
rollback and absence of memory publication; the queue then fails, reclaims and retries the
same durable job. A separate connection verifies committed indexing state before memory
publication. Other-user and administrator command lookup/execution are refused.

The enqueue test was first observed failing with the old compiled guest. The native enqueue
checks likewise failed before implementation. The new immutable-record privacy check was
also observed failing with the account scope deliberately replaced by install-wide scope;
restoring account scope passed. These controls are test-only changes and are not shipped.
The first new worker run exposed an invalid test assumption that the Rust queue has a
creation-time column; the corrected assertion checks its real scheduled timestamp instead.

No new global tool was installed. The already approved, pinned `wit-bindgen` dependency
remains at version `0.57.1`; this work reused task-local guest Cargo/Rustup caches and rebuilt
the generated component in scratch space. Declared JavaScript dependencies were restored
from the lockfile using the existing offline package cache. No new dependency was added.

### Remaining work at the part-three checkpoint

1. Complete the HTTP route set, response/status/error compatibility and projection fallbacks
   for missing or unavailable canonical notes. The existing compiled note routes remain
   partial and are not installed HTTP endpoints.
2. Connect the shared account folder/suggestion preferences, ingest nudges and real provider
   composition to the new job APIs. Declare versioned dependencies and queue schemas in
   the actual package. The provider fixture is not installed provider execution proof.
3. Build, sign, install and reload the downloadable package, including its SQL ownership and
   immutable legacy ledger identity. Qualify command retention/quotas for sustained indexing.
4. Port the existing Settings → Memory & context → People pane with the shared frame,
   folder picker, refresh, add/rename/archive and match review. Add truthful package app-map
   navigation, settings, errors and recovery declarations at that point.
5. Extend parity to real HTTP dispatch, complete route errors/fallbacks, installed settings
   and chat approvals/app-action blocks. Guest/tool tests alone do not prove those paths.
6. Run the installed People UI and chat through the assembled Rust application, then check
   a second physical device over HTTPS with sign-in, trusted origins and private-data rules.
   No real UI, LAN/tailnet or second-device proof is supplied by this checkpoint.

### Part-three verification receipts

The old compiled component first failed the new worker gate at `enqueueIndex` in run
`20261108-081646-EgGlaB`. After the queue-timing assertion correction, the new generated
component passed `people_jobs_database` in run `20261108-082310-24umTO` with exit code zero;
the disposable container was removed. Its component digest is
`sha256:a414e33cc1e7c33e323e69093f64ec3023514d9dc9059f357dc95133ed3891b1`.
Native People tests, strict People Clippy and the two generic host command/deferred-job
suites also passed. The final full People gate, repository static checks and independent
review receipts belong in the checkpoint acceptance proof; the selected worker run does
not substitute for those results.

## People part four: bounded route-envelope checkpoint

JS-58 consumes the merged part-three checkpoint, `f14d71e57`. Finishing the package,
Settings integration and real-device qualification would exceed the continuation's allowed
context budget. This is the explicitly permitted partial checkpoint, not full People
acceptance. No installed screen, setting or navigation path is added; the existing app map
must not advertise a Rust People surface yet. The four consumer APIs, seven tool names,
legacy SQL and job kinds remain unchanged.

The compiled guest now handles list/search/filter/limit, resolve, match candidates,
detail/links, accept/reject/suppress, merge/split and canonical-note create/rename/archive/
refresh through the shared route envelope. Unknown paths return 404. Internal failures
return the same fixed 500 body as the legacy central error handler, while refresh with an
unavailable folder returns its safe 400 response. Archive includes the legacy `archived`
flag, including when the note-backed result also contains a person and note path.

Rename/archive fall back to projection-only edits when the chosen folder is unavailable
or no canonical note can be found before publication. That update retains existing
confidence, summaries and archive metadata unless explicitly patched. Publication,
projection and finalization failures still abort the call and use the host's compensation;
they do not become projection-only success. The note integration test covers a valid folder
with a deleted canonical note, in addition to the unavailable-folder route oracle and
existing conflict/publication/projection failure cases.

`modules/people/tools/routes-gate.sh` runs the actual legacy Fastify handlers with the real
central error handler and disposable database. It records each response and all seven
People tables, resets the original synthetic rows, and replays the sequence through the
compiled guest, shared route resolver and invocation transaction adapter. The shared
parity normalizer compares responses and persisted rows. Cases include numeric-prefix,
zero, invalid, negative and repeated limits; matching and nonmatching lookup; mutations;
missing folder; and another account's and administrator's read/mutation attempts.
The route replay resolves real shared preferences with no selected folder; the separate linked-notes test
exercises real selected-folder I/O and compensation. No network response is replaced or
browser proof claimed.

Independent review found that mapping every file-port failure to folder unavailability
could silently accept a projection-only edit when a note was oversized or the folder busy.
The correction adds the optional generic `notes.status` operation, documented in
`rust-spike/module-host/LINKED_NOTES_STATUS.md`. Only a typed, confirmed folder-unavailability
result permits that fallback. Subsequent scan/read failures abort. A real oversized-note
regression and native availability/lock/provider-failure cases cover this distinction.

### Exact remaining work after part four

1. Finish folder-settings, directory-browsing and index-refresh routes. Implement and compare
   Fastify-compatible request schema validation/coercion: malformed bodies currently can
   return 500 where legacy HTTP returns 400. Broaden query and route-error coverage beyond
   the enumerated cases, then run it through installed HTTP dispatch. Known query gaps are
   limits above `u32::MAX` and repeated status/search values; the latter are currently
   dropped rather than passed through like legacy arrays.
2. Connect the shared account folder/suggestion preferences, ingest nudges and actual source
   providers to the existing job APIs. Declare versioned provider dependencies and queue
   schemas in the package. Qualify command retention/quotas for sustained indexing.
3. Build, sign, install and reload the downloadable package, including unchanged SQL ownership
   and legacy-ledger identity. No distributable People package is supplied by this checkpoint.
4. Port Settings → Memory & context → People with the shared frame, folder picker, refresh,
   add/rename/archive, match review and default-on Suggest note updates. Add truthful manifest
   navigation, settings, features, errors and recovery metadata with those working surfaces.
5. Prove installed Settings and chat approval/app-action behavior. Existing guest tool execution
   tests alone do not establish installed chat policy or UI reachability.
6. Exercise People through the real assembled Rust UI, then from a second physical device over
   HTTPS, including sign-in, trusted origins and private-data rules. No UI, phone, LAN/tailnet
   or second-device proof is supplied here. Keep full People parity open until those checks pass.

### Part-four verification

Final run receipts and independent review are recorded in the checkpoint proof artifact.
The route gate is a guest/host comparison against legacy HTTP handlers; it is not a real
HTTP-listener, signed-package, installed-chat, UI or device acceptance result.

## People part five: Settings checkpoint (JS-69)

Card 523. This task branch began at Phase 0a and was advanced to merged part-four main
`a50e901db` before changes. The work below is a bounded continuation checkpoint; full
People acceptance remains open. The authenticated Rust shell on this base has no installed
module/frame composition, so this report does not claim a working installed People page.

The People folder now supplies a Leptos Settings pane using the shared Park Press module
kit and document-bound parent bridge. It includes a folder chooser, clear/refresh, refresh
counts and guidance, match review, add, rename and archive, independent read errors and
retry, and the default-on Suggest note updates switch. Merge/split candidates offer chat
review rather than an Accept action. Loading data is never presented as an empty result.
Phone layout uses wrapping actions and flexible input columns; installed phone checks remain open.
The shared module stylesheet adds token-based document defaults so an opaque frame has
Moss typography and colours rather than browser defaults.

New host preference bindings map only trusted module/resource pairs to existing account
preferences. Folder saves use the account's allowed roots and `VaultContext`; the guest
cannot select a preference key or account. The suggestion switch reads/writes the existing
`sourceBehaviors` member `people.notes.suggest-updates`. Its SQL merge preserves sibling
members and increments the existing preference revision. These operations commit immediately,
like the existing local KV adapter; they are not part of guest invocation rollback. Keep
settings writes as single-operation routes. Linked-note I/O still uses the shared adapter.

The new manifest declares the Settings screen, account settings, recovery guidance, owned
legacy tables, typed command-reference jobs and four existing public API versions. The
package build utility checks the immutable People SQL against the host inventory and
includes the compiled guest, built screen and authored assets. Its output is unsigned;
registry signing, installation/reload and installed consumer routing remain unqualified.
No tool approval/app-action policy is asserted by this manifest checkpoint.

No tool or target was installed globally. The already approved pinned `wit-bindgen` remains
in the guest crate; this work uses existing scratch guest caches and task-local build output.
The UI adds only dependencies already declared elsewhere in this project.

### Checkpoint verification and limits

The compiled browser screen was opened at desktop width and a 390-pixel phone viewport.
Its unmodified bridge had no authenticated parent in this isolated preview: reads timed out
into separate retry states, note writes stayed disabled, the folder picker opened and
returned, and the phone document had no horizontal overflow. This is real browser rendering
proof of loading/error layout only, not a successful installed Settings workflow or another
device. The check caught a missing Wasm asset URL in startup; the loader now supplies that
URL explicitly and theme retrieval no longer delays the first render.

Independent review found a bridge response mismatch: the shared bridge returns the body
directly, whereas the initial screen expected an HTTP envelope. A regression test using the
real guest and host bridge failed with the old screen adapter and passed after correction;
it also checks rejected writes. The route gate runs this test. All three minor review
findings were addressed: browser-global qualification, shrinkable frame sizing, and
reloading the switch after a failed save. The database folder-browse assertion also caught
an invalid dot path; listing now uses the vault's empty relative root.

The UI's server-render and legacy numeric-confidence tests passed, as did the shared bridge
tests, root lint/type checking, strict host/UI Clippy, and unsigned package construction.
The Settings database test resets its fixtures for each runtime role and deliberately
removes/restores preference RLS around the same privacy assertion. The task proof recipe
records the final isolated People and route gate outcomes and exact tested component hash;
these suites cover integration seams, not complete installed HTTP parity. Broad host
`cargo fmt --check` also reports pre-existing formatting in the parity harness; the changed
Rust files pass a scoped check without rewriting that unrelated file.

### Remaining work after part five

1. Compose the actual authenticated shell with the installed module frame, preference and
   linked-notes adapters. Build/sign/install/reload through the registry, qualify public
   API consumers, chat approval/app-action rules and actual provider dependencies. The
   current shell still only serves Today/chat, without installed modules.
2. Compare folder-settings HTTP validation/coercion with Fastify. Implement legacy relative
   directory browsing and index-refresh, remaining malformed-body/query cases, ingest
   nudges, sustained command quotas/retention and actual source providers. The additive
   `note-folders` chooser is not a replacement for the legacy `notes-directories` contract.
3. Run complete HTTP parity through installed dispatch. Existing guest/host integration
   suites and the Settings adapter tests cover their stated seams only.
4. Exercise the installed screen and real chat in the authenticated Rust application at
   desktop and phone widths, then sign in from a second physical device over HTTPS with
   trusted-origin and privacy checks. No phone viewport is a second physical device.

Verification receipts and the fresh independent review belong in the task proof artifact.
Do not promote this checkpoint to complete People parity or device acceptance.

## People part six: installed-dispatch checkpoint (JS-73)

The historical part-six changes, receipts and remaining-work list are preserved in
[the part-six report](2026-11-08-rust-phase5-people-part6-report.md).

## People part seven: canonical contact-edit parity checkpoint (JS-76)

Card 523. Base: merged main `05ff17370`. This continuation is a bounded checkpoint,
not full People acceptance. The authenticated application, real chat and second-device
HTTPS check remain required before accepting the whole port.

### Canonical note behavior

The route replay now configures a real temporary People folder and drives the actual
legacy Fastify handlers through `VaultContextRunner`. The generated guest replays the
same requests through the shared note adapter. Each configured-folder case compares
canonical file bytes, response envelopes and all seven table snapshots. Rename, archive,
reactivation, ignored summary fields, list clearing and unusual contact values are included.
Rejected edits also compare the unchanged file bytes.

The legacy PATCH schema validates name/status but leaves contact lists untyped. Its
formatter accepts empty strings and objects with numeric zero length as empty lists,
and interpolates array entries into frontmatter. Rust now keeps those boundary semantics,
including the different null rendering used in frontmatter and managed-summary joins.
Invalid non-array values still fail; summaries and unknown fields remain ignored on
note-backed edits. Canonical-note discovery still precedes interpreting those fields,
so the existing projection fallback remains available when the note is missing.
The typed note-service API and the four public consumer contracts remain unchanged.

The module app map describes canonical edits and list clearing. The installed consumer
fixture now requires an owner lookup to find the active private contact before checking
that unrelated users and administrators cannot find it.

### Build and proof boundaries

Every build and gate in this continuation uses a target directory owned by this task.
An existing host cache was copied into that directory; subsequent work does not depend
on the original remaining available. The pinned, previously approved `wit-bindgen`
`=0.57.1` remains a declared guest dependency. No tool or target was installed globally.
JavaScript dependencies were restored from the repository's frozen lockfile and offline
store without install scripts. No new third-party dependency was added.

The installed replay passed after correcting old test expectations: HTML loads `boot.mjs`,
which loads the compiled screen; the installer requires its `ui/` prefix. The Settings
suite also still expected null saves to clear a folder, despite part six's intentional
legacy-compatible rejection. Its assertions now require a 400 response and an unchanged
chosen folder for both owner and unrelated-account attempts. No host product code changed.

### Part seven verification receipts

- Failing first: the generated baseline guest built before the contact-edit change returned
  500 where the real legacy handler returned 200 for a configured-folder PATCH. The gate
  ended with `rc=101`; this is the same replay's first contact-clearing regression.
- The corrected installed-package route gate ended with `rc=0`. It downloads a signed
  temporary registry package, installs unchanged legacy SQL, reopens the installer, compares
  the enumerated responses/seven-table snapshots/canonical files, routes all four consumer
  APIs, retrieves Settings and bootstrap assets, and verifies folder-save/fallback behavior.
- The complete nine-suite People gate ended with `rc=0`: linked-note preferences, guest
  ABI, guest database differential, jobs, notes, persistence, seven-table privacy, Settings
  and all seven tool execution handlers. Privacy assertions failed with RLS removed and
  passed with it restored for both app and worker roles, including administrator actors.
  This qualifies those database/adapter seams, not the real UI or chat approval policy.
- Native People tests: 14 passed. Strict People Clippy passed. Repository lint, typecheck
  and Prettier checks passed; changed Rust files pass scoped rustfmt. Whole host-crate fmt
  still reports pre-existing formatting in `rust-spike/parity/src/dbs.rs`.
- Rust app-map generation and the repository file-size check passed. The UI and generated
  guest built from declared locked dependencies. No browser or real listener was started.

Artifact identity (SHA-256):

- Baseline guest: `7c65c0868e73d30c2da856c8e0c442a1d1aaebfe7febd086f0cac7a8580adcc0`.
- Corrected generated guest: `943a2749d2a653620ccbb30a2f9e55be840f38b7a24c0d69e5ac509be3cae472`.
- Tested package: `7cc16b7c623548cfe707df1e086a4b60f146b260535fd47bd354c0391ed1b77d` (403534 bytes).

The gate receipts identify product commit `ad2df419d` plus dirty test/report inputs. The
installed replay input fingerprint begins `637dff417917`; the nine-suite gate fingerprint
begins `354c754630f6`. The latter includes both corrected Settings assertions. Subsequent
documentation-only edits are recorded in the final checkpoint commit. These are scoped
People integration receipts, not the full repository foundation gate or CI/e2e results.

## People part eight: note-backed edit checkpoint (JS-79)

Card 523. Original base `2ab3f5cd2`; current reconciliation includes main `6450d6ae4`.
The original receipts below describe the pre-merge branch. Both replay workflows and
their direct regressions are retained; the merged-code receipts follow them. This section
supersedes the earlier continuation list; it does not complete People or the authenticated
Rust application.

### Changes and review

The real Fastify oracle now configures a temporary canonical-note folder and adds
fourteen PATCH cases. The Rust replay compares each response, all seven table snapshots
and exact note bytes. Cases include mixed aliases/emails/phones, null and empty values,
unusable objects, status changes and other-user/admin attempts. The latter actors have
no configured folder: unchanged note bytes are not proof of shared-folder authorization.

Note-only PATCH members now retain JavaScript list/interpolation behavior after canonical
note discovery. Projection fallback, public API versions, job kinds and legacy SQL remain
unchanged. Literal dollar tokens retain the already documented corruption safeguard.
The module app map and public contract describe this behavior and recovery.

Review one found a major premature receipts claim; this section replaces that claim with
actual results. Its minor findings prompted quick native tests, matching preference cleanup,
shared canonical-note error text and narrower privacy wording. Fastify's rejection of
`__proto__` and constructor/prototype JSON keys remains a documented parser-boundary gap.
The installed asset test now follows the actual HTML boot module to its JS and Wasm assets.
The Settings database fixture now expects refused null saves, matching the legacy oracle
and part seven, and verifies the owner's folder survives.

### Verification receipts

- Before: frozen pre-fix component `574a7c94934f3301a762c159c8c496de2d0a6858de6dbbe5f234f90ad8b89b00`
  returned 500 for a configured-note PATCH where real Fastify returned 200. Verify-gate
  `142557-3p8cSA` ended 101; its wait returned 1.
- Installed replay `144401-MWbKq3` ended 0, wait 0: 112 responses and all seven table
  snapshots matched, including fourteen note-backed cases with exact bytes. Signed
  installation/reload, all four consumer APIs, installed HTML/boot/JS/Wasm assets and
  folder operations passed. It tested `b0c2c9c98` plus only the scoped Rust-format change,
  input fingerprint `17e83bf817a246fb4d338c976fb342a1e6c5fa4da087003e4749f39591e90a5b`.
- Nine-suite run `144509-CCqfQs` ended 0, wait 0: ten integration assertions passed across
  all nine suites, including protection-removed failures and restored privacy for both
  runtime roles. It tested clean `67157929b`, fingerprint
  `1e2aaee111d52039dd45f0c8cd7490c743db2645ad5ab6153c047d76790585dc`.
- Earlier runs `144111-uYvxG3` and `144118-2NjOW8` ended 101 at the stale asset and null-save
  assertions described above. They are not green receipts. Final-commit rerun receipts
  and the final independent review are attached to the task proof.
- All fourteen native tests, strict People Clippy, scoped Rust formatting, root lint,
  type checking, formatting and file-size checks passed. Gates used Node 22.22.2, pnpm
  10.6.2, Rust 1.95.0 and disposable PostgreSQL 17.11 through `scripts/run-gate.sh`.
- Component/package builds used task-owned scratch targets. No global tool was installed;
  approved pinned `wit-bindgen =0.57.1` used existing scratch Cargo/Rustup caches.

```text
component 5fbe294845f2bc6ecce26c0a088617f584ca4a0f546e5242d41c65f18c8fb900
package   e30709c29e7ce0a8cc1bb7411a50307a7e1defdcd31cf587aa93c248549addd7
```

### Reconciliation verification

Merge `6080e7d41` retains both note-backed replay workflows and the newer Notes/Tasks
work from main. The merged implementation uses main's typed note-edit seam; this
branch adds direct tests, managed-note fixtures and recovery wording beyond it.
The combined replay restores an active owner contact before consumer privacy checks.

Both gates tested clean `a0013c7b0`, input fingerprint
`11a4838e0b0e866f6518dd216cead34b478168aede49b3ffeb8396a7ed11d0d3`:

- Installed replay `150842-mwc2ht` ended 0, wait 0: 130 responses, all seven table
  snapshots, canonical bytes, signed installation/reload, consumer APIs and assets passed.
- Nine-suite run `150842-fbljBM` ended 0, wait 0: ten integration tests passed, including
  protection-removed/restored privacy controls under both runtime roles.
- Sixteen native tests, strict Clippy, scoped Rust formatting, repository lint/typecheck,
  formatting, file-size checks and Rust core app-map generation passed.
- Component SHA-256: `c8fe79f59c12de8c6bc6eee3bc93caa07ed96fedb7bcb92b7056342a1c5e5ab2`.
- Package SHA-256: `436c3337143605a6e3bec7e08c621c5a967396194195e08a73bb727080a63c6a`.

This receipt-only report update follows those runs. Build targets belong to this task;
no global tool was installed. The merged commit still needs independent review: both
permitted rounds were used before reconciliation, so another round must be granted.
The updated recipe proof distinguishes these checks from the open live acceptance work.

### Remaining acceptance work

1. Compose the authenticated Rust shell with the installed module frame, preference and
   linked-note adapters. Exercise real Settings writes, chat approvals, blocked app actions
   and source providers. Registry/provider fixtures and library dispatch do not establish this.
2. Finish index-refresh/cooldown and singleton scheduling, ingest nudges, real source-provider
   dependencies and sustained command quotas/retention.
3. Complete broader HTTP/parity-harness acceptance: locale-sensitive directory ordering,
   configured-folder filesystem authorization controls, parser rejection noted above, backend
   failures and remaining numeric/file edge cases. The enumerated replays are not full parity.
4. Run the actual installed UI at desktop and phone widths, then sign in from a second physical
   device over HTTPS with trusted-origin, LAN/tailnet and cross-account privacy checks.
   No browser, network-listener or physical-device proof was produced in this checkpoint.

The next continuation should prioritize working installed screens/chat after the replay
receipts, then close the remaining behavior and live-device gaps. Do not accept full People
parity from this checkpoint.

## Part nine: packaged worker permission and broader refresh replay (JS-84)

Before editing, this task fast-forwarded its own stale branch to merged main `1dd8240b2`.
That baseline contains People PR 4066 and the newer canonical-edit report from PR 4069
(commit `4338dc3f5`). No work from another worktree was copied into the source tree.

The compiled indexing worker could not finish even when no optional source provider was
configured: it reads `kv/get/person-providers`, but the shipping manifest omitted that
permission. The old worker differential used a broader fixture manifest and hid the problem.
The regression now executes enqueue and worker calls with the actual shipping manifest,
real command records, the queue and worker-role transaction adapter. The unchanged manifest
failed this regression before the fix with the generic host error. The missing grant is
inferred from the guest call and capability declarations, then confirmed by the corrected
manifest passing the same regression. The only product change adds `get` and `person-providers` to the existing KV capability.
The host permits one capability per port and represents operations/resources as a cross
product, so this also permits `get` on the existing resource names and existing operations
on the new name. Raw KV `set` and `delete` remain ungranted: command records use separate
namespace directories, and preference operations require trusted bindings. A standalone
manifest test validates the actual package grants. An initial separate KV entry was rejected
by package validation and corrected before the successful replay. The module app map
now describes the optional-provider check without claiming live provider delivery.

The real Fastify route oracle now adds successful canonical creation, search and identity
resolution for that person, nested-folder refresh, duplicate canonical IDs, missing IDs,
ordinary markdown, an ignored uppercase extension, a new canonical person, repeat refresh
and candidate listing. Directory cases include dot/trailing-slash normalization, internal
separators, missing folders and traversal. Every seeded or created note and the complete relative file inventory are compared after
each configured-folder request, alongside replies and all seven table snapshots.

Generated UUIDs differ between implementations. The replay normalizes only the first valid
frontmatter ID in a canonical note; known seeded IDs stay unchanged under the existing parity canon. Other bytes, line endings
and user text stay literal.
A candidate hash derived from a generated person ID is recognized only if it matches the
correct hash for a person in that run, then compared using the parity harness's ID label.
Wrong hashes remain literal. A separate comparator test covers these limits. Pure matching
vectors remain the independent algorithm check. The public consumer interfaces are unchanged.

Builds use task-owned host, guest, UI and native Cargo targets. A previously reused external
scratch compiler disappeared during the UI build; the retry uses a task-owned copy of the
already installed compiler and its task-local standard-library targets instead. The pinned,
previously approved `wit-bindgen =0.57.1` remains a declared guest dependency; it was compiled
inside task scratch, with no global install. JavaScript dependencies were restored from the
frozen lockfile and offline store, without install scripts. No new dependency was added.

### Initial part-nine verification (before main integration)

- Failing first: the original shipping manifest failed the compiled missing-provider worker
  regression with `rc=101`. The broader fixture alone had not exercised those grants.
- Installed-package replay: `rc=0`, **127 legacy responses** and all seven table snapshots
  matched. It checks successful canonical creation/search/resolve, two nested refreshes,
  review candidates and note bytes, then routes all four consumer APIs through an installed
  consumer. It also checks installed Settings assets, preserved folder preferences and
  unrelated-user/administrator refusals. No browser or HTTP listener is exercised.
- Complete nine-suite People gate: `rc=0`, including compiled worker/legacy row parity,
  canonical-note projections, persistence, Settings, all seven tool execution handlers and
  all seven tables' failing-first privacy controls for app/worker roles and admin actors.
  Controls fail with protection removed and pass with it restored. This is the scoped
  People integration suite, not the full HTTP parity harness or live application.
- Native People tests: 14 passed. Strict People Clippy and the pure TypeScript matching/note
  vectors passed. The new normalization test and shipping-manifest test each passed.
- Repository lint, typecheck and Prettier checks passed. Changed Rust tests pass scoped
  rustfmt; Rust app-map generation and the repository file-size check passed.

Artifact identity (SHA-256):

- Generated guest, unchanged by the manifest fix:
  `4fdfdc7f350d681a84da61148383e378bbeb520593a15b1a4228cc56325ceb2e`.
- Tested package: `b28b1ee50c55427b9d1d50959c947cc75312c144052ceec36970a4884b2bff1f`
  (404372 bytes).

The initial, pre-integration database receipts identify code commit `3c8127a99` plus the dirty manifest,
worker test and contract correction later committed as `896b826dd`; their input fingerprint
begins `e8a717e66ecb`. Logs end `155045-j56WMp` (installed replay) and `155045-CDtoCu`
(nine-suite gate). These earlier receipts were superseded after integrating newer main, as recorded below.
They do not stand in
for CI, the full foundation gate or browser e2e acceptance.

### Main integration and review dispositions

The first fresh review found a newer People part-eight merge (`7f934edde`, PR 4072) on
main. It overlapped this task's oracle and report. The task integrated main `6c26f775a`
into its own branch at `058879bfd`, retaining part eight's source fixes, historical reports
and all of its per-case seeded note-edit requests. Those run before this task's creation
and nested refresh requests, and the installed-consumer positive fixture is retained.
The package and both database gates are rebuilt and rerun on that combined source.

The review's file-inventory concern is addressed by comparing every relative filename
in addition to note contents. Its seeded-ID concern is not a normalization defect:
`Canon` preserves known IDs, so seeded note IDs already compare literally. An additional
native assertion now proves that boundary, and the wording above states it explicitly.
The generic initial worker error is recorded as such; its missing-permission cause follows
from the guest call, grants and corrected regression. Repository lint is rerun after the
combined oracle, replacing the earlier receipt's timing uncertainty.

### Final integrated verification

- Installed replay `160704-cLxwLC`: `rc=0`; **142 legacy responses**, all seven table
  snapshots, canonical note bytes and the complete relative file inventory matched.
  Both part eight's seeded edits and part nine's creation/refresh cases run. All four
  consumer APIs, owner/other/admin isolation and installed Settings assets also passed.
- Complete nine-suite People gate `160655-fmV3vo`: `rc=0`, including the shipping-manifest
  worker regression and failing-first seven-table privacy matrix for both runtime roles.
- Native People tests: 14 passed; strict People Clippy passed. The updated comparator
  assertion passed, including literal seeded IDs. Repository lint and typecheck passed
  again on the integrated source. Scoped Prettier, Rust formatting, Rust app-map generation
  and the file-size check passed. A dry-run merge with main reports no conflicts.
- Rebuilt generated guest SHA-256:
  `7a868a7b96d610e88a0bd8032c56e969f5a448cbb36775ed443bcb93825e614d`.
- Rebuilt package SHA-256:
  `5d27b731cf77cb707bc96b0de820d3f5033138084bfbd3b7535a756f69709e43`
  (404729 bytes). Its Settings assets come from the unchanged People UI source built above.
- Both database receipts identify source commit `058879bfd`, only this report dirty,
  fingerprint `be404fc55ec1`. Later changes only record these results in this report.
  These replace the initial part-nine receipts for integration qualification. CI, full
  foundation, real HTTP/UI/chat and physical-device acceptance remain unverified.

This is a bounded checkpoint. The remaining full-port work below exceeds this continuation's
single-context scope. No live listener, browser session or physical second device has been
qualified by this task; those acceptance requirements remain open.

### Remaining acceptance work

The following remain open regardless of this checkpoint's integration results:

1. Compose the installed module frame and adapters into the authenticated Rust Settings
   shell, then exercise actual reads/writes, real chat approvals, blocked app actions and
   policy behavior through that listener.
2. Finish index-refresh/cooldown, ingest nudges, actual source-provider composition, and
   command retention/quotas. The registry suite's provider remains an explicit fixture.
3. Broaden the HTTP oracle beyond its enumerated cases, including locale-sensitive
   directory ordering, backend errors, larger datasets and remaining numeric edge cases.
4. Run the installed screen at desktop and phone widths and sign in from a second physical
   device over HTTPS with trusted-origin and cross-account privacy checks. Library dispatch,
   a retrieved HTML asset and a phone viewport cannot substitute for that proof.

The completed checks above qualify only the named integration seams. Do not label this
checkpoint as the complete HTTP parity harness or live-device acceptance.

## Part ten: manual source-index refresh (JS-88)

Before editing, this task fast-forwarded its stale branch from `6d4eba749` to merged main
`0ec737720`. That baseline includes the latest People part-nine report and PR 4077.
No sibling worktree's source was copied into this tree.

The package omitted `POST /people/index/refresh`. The unchanged module returned 404 for
both new native regression tests; the corrected handler returns the legacy 202 response
with the submitted count. It applies the complete legacy body schema before sending any
jobs, including required fields, string coercion, ignored extra members and the maximum
of fifty references. Each accepted reference uses a fresh host UUID, an immutable account
command and the existing fifteen-minute delay. Queue parameters contain only the command
UUID. No SQL, ownership rule, public consumer API, chat-tool name or job kind changed.

The legacy registry declares the People queues without a special policy. Its standard
pg-boss queue does not coalesce repeated singleton keys. The new oracle creates that real
queue in the disposable gate database and compares repeated references, repeated requests,
source-version changes, fifty-item batches, empty batches, validation/coercion and all three
test actors against Rust's real queue and command records. It compares metadata as a
multiset, so random queue UUIDs and insertion order do not hide missing or duplicate work.
Every existing table snapshot and canonical-note comparison remains in the replay.

Internal command retries still deduplicate by their original UUID. Manual refresh requests
are separate cycles. A send error retains earlier sends and returns the safe legacy 500;
a native fault test checks that partial-batch behavior. The Rust handler requires the host
queue adapter and fails with 500 if it is missing. It deliberately does not copy the legacy
library's optional-boss branch, which returns 202 without sending work. The normal legacy
application supplies that dependency; this difference is documented in the public contract.

Command privacy has a test-only negative control: `JS88_PEOPLE_UNSCOPED_COMMANDS=1` declares
the command namespace install-wide during raw dispatch, deliberately removing the default
account scope. The ordinary assertions require the other account and the administrator to
read null for each queued reference. The control refuses installed-package mode and is not
a production setting. Its failing/passing receipts are recorded with verification below.

The owning manifest declares the route and its app-map behavior, including validation,
delay and partial sends on queue failure. The four public People lookup APIs remain stable.
Builds, Rust toolchain and dependency caches are task-owned. The existing compiler and
standard-library targets were copied into task scratch. The already approved, declared
`wit-bindgen =0.57.1` was fetched and compiled there, with no global installation or added
dependency. JavaScript dependencies were restored offline from the frozen lockfile without
install scripts.

### Part-ten verification

- Failing first: the unchanged module returned 404 in both new manual-refresh regression
  tests. After implementation, all nineteen native People tests pass, including a queue
  failure after the first send. Strict People Clippy also passes.
- Command-privacy negative control `165753-LEZxHS` ended with `rc=101` at
  `people_routes/refresh.rs:90`: another account read the command object where the ordinary
  assertion requires null. This is the intended failure, not a build or setup error.
  That receipt records `0083282df`, with the two new privacy-test files dirty; those exact
  test changes were subsequently committed as `a8f165968`.
- Complete nine-suite People gate `170132-iMoMNE` passed (`rc=0`, ten tests), including
  the compiled worker, canonical notes, chat-tool execution and failing-first privacy
  assertions across all seven tables for both runtime roles.
- Final installed functional replay `171650-ZtxW3N` passed (`rc=0`): all 163 route responses
  (including twenty-one new refresh cases), seven-table snapshots and canonical note bytes
  matched. The signed package was downloaded, installed with legacy SQL and reloaded. All
  four public APIs ran through an installed consumer; unrelated-user and administrator
  command reads returned null with ordinary account scoping. The Settings asset check is
  asset retrieval, not a browser or authenticated screen check.
- This installed replay explicitly configures a thirty-second call deadline. Earlier runs
  `170536-Sp1rmN` and `170915-STjRZL` failed the fifty-reference request with the host's
  default five-second deadline: Rust returned 500 rather than 202, retaining earlier queued
  references. Extending only the replay host's deadline made the unchanged package pass.
  The final harness checks route responses before queue deltas so this failure is clear.
  This proves functional behavior with the configured budget, not adequate performance
  under the default budget. Shared shipping host defaults were not changed. Real host
  composition must provide sufficient time for the batch or improve its enqueue path.
- The generated component was rebuilt with the task's source-built wrapper and matched
  the earlier task artifact byte for byte. SHA-256:
  `2d97bed65bb527ea7ed651ff0d9a0a76dc1e561a9b693576f9af5e59a95b4fca`.
- The unchanged Settings source was rebuilt and packed with that component. Package
  SHA-256: `6be4e1e8d492c62284d9fa1b4edb025c44b844c033231ba176340a89dcdb47d3`
  (402387 bytes). No checked-in binary or globally installed compiler is needed.
- Repository lint and full typecheck, scoped Prettier, Rust formatting, Rust app-map
  generation, file-size check and the unchanged pure-vector comparison passed.

The nine-suite receipt identifies `a8f165968`, with only the report and PUBLIC_API dirty,
input fingerprint `b43945859843`. The final installed receipt identifies that same commit with
six dirty files: this report, PUBLIC_API, README, app-map metadata, the installed replay
deadline and response-first assertion order, fingerprint `d684bb5f4725`. The earlier
thirty-second diagnostic run `171216-6PZ59r` also passed all 163 cases; the final run
requalifies the package after its app-map explanation changed. Later edits only record
these results in this report. The receipts qualify the named seams only; CI and the full
foundation gate have not been run here.

### Part-ten review and remaining acceptance

The first fresh Claude review found no blocker or major. Its minor optional-boss difference
is documented above; the pending evidence and report notes are resolved by the final receipts.
The second review is recorded against `2c7b2004e`. It found one major ship condition:
the default-budget fifty-reference failure. The reviewer permitted disclosure in the
CHANGELOG as an alternative to an in-scope runtime fix; the follow-up does that and says
not to expose this route until host-budget or enqueue performance is qualified. The
performance limitation itself remains unresolved. Its four minor notes are addressed by
recording request time, explicitly describing unsent records and storage growth, keeping
qualification wording out of the app map, and retaining the dirty-input receipt notes.
Both allowed rounds are used. The post-review follow-up commit needs another review
round before this task can be Ready.

This is a bounded checkpoint. Completing the remaining application and physical-device
qualification would exceed this continuation's single-context scope. The remaining work is:

1. Finish ingest nudges, real source-provider composition, and command retention/quotas.
   Qualify the fifty-reference call budget in the real host; the default five-second budget
   failed here, and this checkpoint does not resolve that performance limitation.
2. Broaden HTTP parity beyond the enumerated replay, including locale-sensitive directory
   ordering, backend failures, large datasets, extreme numbers and JSON parser rejections.
3. Compose People into the authenticated Rust Settings and chat application, then exercise
   real reads/writes, approvals, blocked actions and policy behavior through its listener.
4. Exercise desktop and phone layouts, then sign in from a second physical device over
   HTTPS with trusted-origin, LAN/tailnet and cross-account privacy checks.

No live application listener, browser interaction or physical second-device proof is claimed
by this checkpoint. Package dispatch and disposable queue rows do not prove those paths.

### Post-review follow-up

The test now measures the fifty-reference installed request itself, separately from the
whole replay. Thirty seconds remains an explicit test configuration, not a measured
minimum or a promise for other machines. The merged application constructors currently
use the five-second default; wiring People into them requires an explicit budget decision
or an enqueue improvement before this route is exposed.

A send failure leaves the current immutable command stored even when it has no queued
job. The native regression observes two stored commands and one queued job after the
second send fails. Fresh manual retries can duplicate the earlier job and add more stored
commands. Without the deferred retention and quota work, signed-in repeated requests can
grow this storage without a module-level bound. This is a ship condition to qualify,
not a storage safety claim. README, PUBLIC_API and CHANGELOG now disclose it.

Post-review installed gate `172751-ZZ7Zd3` passed (`rc=0`): all 163 responses, table
snapshots, note bytes and installed consumer checks still match. Its measured fifty-item
request returned 202 in 4577 milliseconds, with the explicit 30000-millisecond deadline.
This is one sample, not a latency guarantee or a minimum-budget measurement. Earlier
five-second failures remain relevant; the sample does not qualify that default.

The package with the revised app-map wording is SHA-256
`125804723b178505c5d26aa1b33c3016fb15e1a3a3ab989deab21d4764647b32`
(402438 bytes). The component is unchanged from the digest above. The receipt identifies
`2c7b2004e` with six dirty follow-up files, fingerprint `b1c0992033d3`; the only
changes after that receipt finish this report. The final follow-up commit is pushed but unreviewed because both allowed rounds
have been used. No Ready or full acceptance claim is made.

## Part eleven: folder reading order and the full parity run (JS-94)

Before editing, this branch was advanced from Phase 0a to merged main `1c63fa2f4`,
which contains the part-ten report. No sibling worktree source was copied.

The legacy directory listing sorts folder names with JavaScript
`localeCompare`. The Rust route sorted by raw bytes, so capitalised and
accented names landed in a different order. The route now compares base
letter first, then accent, then case, with punctuation before digits and
digits before letters. A native test pins the reference order for fourteen
names. The route oracle creates `apple`, `Banana` and `Ábc` folders whose
order differs between the two schemes, and the installed replay compares
that listing against the real legacy handlers. The first full run failed at
exactly that listing because the replay's own folder copy and expected
answer still held only the old folders. Both now match the oracle. The app
map's folder-browsing entry describes the reading order.

### Part-eleven verification

- Two review rounds drove the ordering work. The first found the first
  pass still differed from the legacy order for punctuation, special
  letters such as `ø`, `æ`, `œ` and `ß`, distinct accents, and separate
  accent marks. The second found accented letters outside the table,
  including Romanian and Vietnamese names, sorting after `z`. The
  comparator now follows the legacy collation order for punctuation,
  expands or places special letters as the legacy order does, compares
  accents by kind, treats separate accent marks as accents, and places
  the added letter groups under their base letters. Twenty-seven
  native cases pin those pairs against the legacy results. Two small
  differences remain accepted: a letter carrying two separate accent
  marks compares by its first mark, and names the legacy order calls
  equal keep a stable raw-text order. Two such names rarely coexist.
- Installed replay `201753-ccBlpP` passed (`rc=0`) on clean `ca164b565`: all 163 legacy route responses and all seven table
  snapshots matched, including the new folder order, other-user and
  administrator attempts, signed installation and reload, and all four
  consumer APIs. The fifty-reference timing remains as recorded in part
  ten; the default five-second budget stays unqualified.
- Nine-suite People gate `201951-jvQmoL` passed (`rc=0`) on the same
  clean commit: ten integration tests across all nine suites, including
  the failing-first privacy matrix for both runtime roles. Controls fail
  with protection removed and pass with it restored.
- Twenty-one native People tests pass, including both ordering tests.
  Strict People Clippy, scoped Rust formatting, repository lint, full
  typecheck, Prettier, file-size check, pure-vector comparison and Rust
  app-map generation pass.
- Component SHA-256:
  `e4092dc68a207f15a8386e5186ca707b0baf852002132724562e695e0217d513`.
- Gate-tested package SHA-256:
  `7afaf9e8dd89b86b70c8c0ab5ea11062a97f5078056448a040e599f0041deb8a`
  (406543 bytes).
- Builds and caches stayed in task-owned scratch. No global install. The
  approved pinned `wit-bindgen =0.57.1` remains a declared dependency.

### Remaining acceptance work

1. Compose People into the authenticated Rust shell. The shell still serves
   Today and chat with its stub data contract and has no installed module
   frame composition, so there is no real People screen to exercise yet.
   This blocks the live UI, chat approval and second-device HTTPS checks.
   Library dispatch and retrieved assets do not substitute for that proof.
2. Finish ingest nudges, real source-provider composition and command
   retention/quotas. Qualify the fifty-reference call budget in the real
   host before exposing manual refresh through its listener.
3. Broaden HTTP parity beyond the enumerated replay, including backend
   failures, larger datasets, extreme numbers and JSON parser rejections.

This is a bounded checkpoint. Full People parity stays open until the
assembled application and device checks above pass.

## Part twelve: numeric contact text parity (JS-100)

The takeover found two committed folder-order changes and a clean worktree. Before further
edits, merged main `698432777` was brought into this branch, including the latest part-eleven
report and its more complete folder comparator. That comparator supersedes the takeover's
duplicate implementation. The broader root-folder replay cases remain. No sibling source
was copied. The branch now contains both the earlier `4066` checkpoint and part eleven
(`4088`); those are different PRs despite the continuation brief's older reference.

Numeric contact values exposed another behavior difference. For an exact binary64 value
that JavaScript renders as `652282746268236.2`, Rust's shortest Display chooses
`652282746268236.3`. Both strings round-trip to the same number, but the legacy schema
coercion chooses the even final decimal digit when the two candidates are equally close.
This difference affects projection-only display names and note-backed name, email and
phone values. The shared People conversion now keeps the shortest digit count and uses
explicit-precision rounding, then applies JavaScript's fixed/scientific notation boundaries.
No dependency or public API changed. The module still obtains data through server host
ports, and the Settings client still uses the server API bridge.

Native regressions cover seven exact tie values, signed zero, fixed/scientific boundaries,
a large integer, the smallest subnormal, the smallest normal and the largest finite value.
The differential replay adds two projection edits and a note-backed edit exercising all
four contact fields. Those requests use the real legacy Fastify handlers as the oracle.
The app-map feature and package change notes describe the decimal spelling.

### Part-twelve verification

- Failing-first native regression: the unchanged conversion returned
  `652282746268236.3` instead of `652282746268236.2` (`rc=101`).
- Failing-first signed installed replay `204854-4LkuPQ` failed (`rc=101`)
  at the same projection-only PATCH response. The old component was rebuilt
  from the merged comparator source before the numeric fix, then packaged.
  An earlier launch `204802-7TLPXo` failed setup because packaging raced the
  component build; it provides no behavior evidence.
- All twenty-three native People tests, strict People Clippy and Rust
  formatting pass after the fix. The exact-bit tests also cover seven ties
  without depending on JSON-parser rounding.
- The Settings source and generated component were rebuilt with the
  task-owned caches. Component SHA-256:
  `0debe213d08dab948eba4b8a0e68868368ef61aea068e883c7848b3835330538`.
  Package SHA-256:
  `ff377d0057b20cce0d772555a5e84f06331df782ef668d0d6480da493b9db1e8`
  (412213 bytes).

- Final signed installed replay `210039-diEk9Z` passed (`rc=0`) on
  `0a76fd3a9`, with only this report dirty, fingerprint `4b7d9ab2373f`.
  All 166 route responses, seven-table snapshots and canonical note bytes
  matched. This includes numeric aliases, emails, phones and names, root and
  child folder ordering, other-user/admin attempts, installation/reload and
  all four public APIs through the installed consumer.
- The fifty-reference request returned 202 in 20381 milliseconds with the
  explicit 30000-millisecond replay deadline while other checks were running.
  Earlier after-fix runs `205118-DNjuB8` and `205422-pqOZ0W` also passed all
  166 cases; their samples were 7635 and 6576 milliseconds. These are samples,
  not guarantees. The shipping five-second budget remains unqualified.
- Full nine-suite People gate `205117-EpegLb` passed (`rc=0`, ten integration
  tests). The seven-table privacy controls failed with protection removed and
  passed with it restored for both runtime roles, including another account
  and an administrator. Settings privacy controls also failed then passed.
  This receipt identifies `1a7b65cc5` with six dirty files, fingerprint
  `166be18276ef`. It used the same immutable component digest above; the
  subsequent changes added tests, explicit Number-string fixtures and report
  text, without changing executable module behavior.
- Repository lint, full typecheck (including web, tests and external modules),
  full Prettier check, file-size check, Rust app-map generation, the unchanged
  pure-vector comparison, scoped formatting and final strict Clippy pass.
  CI and the full foundation gate were not run.

First independent Claude review of `a0416366d` found no blocker or major and
identified two minor test gaps: an upward-even tie and numeric aliases. Both
were addressed in `0a76fd3a9`, with native tests rerun and the final installed
replay above. See the task proof for the submitted commit's final independent
review. Only this report changed after the final installed receipt.

### Remaining acceptance

This is a bounded parity checkpoint, not full Phase 5 acceptance. The merged shell's
`moss-shell` dependency list and route composition still do not include the module host or
installed Settings frame. Its shell data adapter remains a stub. This task does not build
a substitute application or connect the module directly to a database from the app.

The remaining work is unchanged: compose People into the authenticated server's Settings
and chat paths, finish ingest nudges and real source providers, qualify command cleanup
and quotas and the fifty-reference call budget, broaden backend/large-data/parser parity,
and prove the real UI and privacy from desktop and a second physical device over HTTPS
with trusted origins. No real application UI, chat approval flow or second-device check
is claimed here. Prior package-dispatch and privacy results do not substitute for them.

All build, dependency and toolchain paths used task-owned scratch. The approved pinned
`wit-bindgen =0.57.1` dependency was reused from that scratch, without a new global install.
No migration, SQL privacy policy, provider composition or shared shell source was changed.

### Part-twelve second-review fix

The second review round found that at powers of two the binary64 rounding interval is
asymmetric, so the even-decimal choice could change the represented number (for example
at 2^-24). `dee1f6760` keeps the shortest spelling in that case. A native test checks every
finite power of two with both signs, and all twenty-four native People tests pass on that
commit. The review rounds (two of two) were used before this fix, so the fix commit has
no independent review of its own. The installed replay and nine-suite gate receipts above
predate it; the fix touches only the number spelling path.

## Part thirteen: component JSON number parsing (JS-104)

Before editing, the clean task branch was advanced from Phase 0a to merged main
`4921b55b5`, including the complete part-twelve report and its final power-of-two
correction. No sibling worktree source was copied. The brief's reference to PR 4066
predates these later checkpoints; the source report was used as the baseline.

The broader numeric comparison found a separate issue before text formatting: the default
JSON parser can round a decimal input to the wrong binary64 value. The failing native
example reads `2.3050789863520357e+299` as `2.3050789863520353e+299`. The component now
opts into `float_roundtrip` in its existing `serde_json` dependency. There is no new
package, lockfile version, public API, SQL migration or privacy policy. This applies to
all component JSON numbers, including provider confidence values, as well as numeric
contact text. The app map and package notes describe the component scope.

A deterministic JavaScript oracle records 283 decimal literals and their `String(JSON.parse(input))`
results, including underflow, subnormals, rounding boundaries, signed values and seeded
finite binary64 values. Native tests consume those literal strings rather than constructing
already-rounded Rust numbers. The route oracle adds projection-only and note-backed edits
with the parser-sensitive input and compares the replies, all seven tables and note bytes.

### Part-thirteen verification

- Native failing-first test returned `rc=101` at the large-number example above.
  All twenty-five native People tests pass after the feature change, including all 283
  parser vectors and the existing finite-power-of-two checks.
- Signed installed baseline replay `222138-QM8S4G` failed (`rc=101`) at an existing
  power-of-two PATCH case before reaching the new large-number case: it returned
  `5.960464477539064e-8` instead of the legacy `5.960464477539063e-8`.
  Its immutable component was compiled before enabling the parser feature; the test
  host itself used the corrected feature through the native test dependency.
- Corrected signed installed replay `222517-fXmYGB` passed (`rc=0`) on clean
  `d4bb7393c`, fingerprint `3e8c3dc8d0ec`. It reports **170 legacy route responses**
  and all seven table snapshots matched, including other-user/admin attempts,
  canonical note bytes, signed download/install/reload and all four public APIs through
  the installed consumer fixture. This is the actual replay count, superseding earlier
  counts in progress notes.
- The fifty-reference request returned 202 in 6349 milliseconds with the explicit
  thirty-second replay deadline. This sample does not qualify the shipping five-second
  deadline, a performance guarantee or safe retries after partial enqueue.
- Full nine-suite People gate `222214-hrQAG3` passed (`rc=0`, ten integration tests)
  on clean `c3ab8d2ac`, fingerprint `746ab0b1d073`. It used the same corrected
  immutable component as the final replay. The seven-table privacy controls failed
  with protection removed and passed with it restored for both runtime roles,
  including another account and an administrator. Settings privacy controls also
  failed then passed. The later commit narrowed documentation and a replay comment;
  it did not change executable component behavior.
- Strict People Clippy, scoped Rust formatting, regenerated core and numeric vectors,
  Rust app-map generation and final scoped ESLint/Prettier checks pass. Repository lint
  and full typecheck, full Prettier and file-size checks pass. A scratch static wrapper
  subsequently failed at a mistyped app-map script path; the correct
  `scripts/build-app-map.ts --rust` command and both vector comparisons were run
  successfully in the separate final scoped check. No full foundation gate or CI run
  is claimed.
- The Settings assets were rebuilt from this checkout. Corrected component SHA-256:
  `5e3ac6201cb863c067fe0a865fd51412a9b797442eef551f4daa1387f156440b`.
  Corrected package SHA-256:
  `a882ad6bd896150dc6cd54ff83cda4e8c39ac7b9fdac41207a9333220efe2503`
  (427040 bytes).

All Cargo, Rustup and build caches used task-owned scratch. The already approved pinned
`wit-bindgen =0.57.1` dependency was built from those copied dependency caches. Declared
JavaScript dependencies were installed from the lockfile offline in this worktree. No tool,
package or toolchain was installed globally. Build caches are removed at closeout.

### Review findings and proof boundary

The first independent Claude review correctly identified an upstream parser limitation and
over-broad package wording. The manifest, change notes and README now explicitly limit
this correction to the component. `module-host`'s `dispatch_extended` parses raw bodies
before invoking it; a normal host build does not explicitly enable `float_roundtrip`.
The replay's native `moss-people` dev-dependency unifies that feature into the **test host**.
Consequently the passing replay qualifies the installed component with that test-host
configuration, not the normal host or network listener's JSON parsing. The replay cases
are retained for that stated purpose. Upstream qualification remains required before
claiming end-to-end numeric parity; a component cannot recover an input its caller already
rounded incorrectly. No shared host source was changed in this People-owned slice.

The review's minor scope note is recorded above: the feature affects all component numbers,
not only contacts. Its minor stale-fixture receipt was regenerated from the committed
283-tuple oracle and compared byte for byte. The final commit's independent review is
recorded on the task and in its proof; this report does not pre-claim that verdict.

### Remaining acceptance work

This is a bounded behavior-parity checkpoint. Completing the following work would exceed
this task's single-context boundary, so it remains explicit rather than treating library
checks as full Phase 5 acceptance:

1. Qualify upstream JSON parsing in a normal host/listener build without the People native
   test dependency's feature unification. Preserve correct rounding before dispatching to
   the component, and exercise raw numeric request bodies through the shipping listener.
2. Compose the installed People frame and chat tools into the authenticated Rust server.
   The current shell router has shell/Today/chat routes but no module host or Settings
   frame composition. It uses stub account data unless its optional runner is configured;
   neither path currently supplies the People screen. The module remains a pure client
   of the server API; no app-side database connection was added.
3. Finish ingest nudges, real provider composition, command cleanup/quotas and the
   fifty-reference shipping budget. Broaden backend-failure, large-data and parser-error
   coverage beyond the enumerated replay.
4. Prove the installed People screen and chat approval flow through the real app, with
   sign-in, trusted origins, privacy and HTTPS from desktop and a second physical device.
   No substitute UI, browser render or physical-device result is claimed by this checkpoint.

## Part fourteen: qualify normal-host numeric dispatch

The module host now keeps numeric contact values from changing before People sees
them. The real app and phone checks still remain open.

This checkpoint starts from freshly fetched `main` at `5ab839f65`, the merged
part-thirteen report (PR 4099). The initial task branch predated the People port;
it was advanced while clean before any edits. The brief's PR 4066 reference is
older than that verified baseline. No sibling worktree source was copied.

Part thirteen identified a real test boundary: the route replay's native People
dev-dependency enabled correctly rounded JSON parsing in the test host, while the
normal host did not request it. A component cannot repair a number already rounded
by its caller. The host now explicitly enables `float_roundtrip` in its existing
`serde_json` dependency. This is the only production change outside People-owned
files. It affects JSON numbers parsed by the host generally, not only contact text.
There is no new dependency version, public API, database schema or privacy policy.
The module and its screen remain clients of the server's declared API and ports.

`modules/people/tools/host-json` is an independent downstream executable. It depends
on the normal host, omits native People and requests no JSON feature itself. It
installs a signed echo fixture through the real installer and sends 283 raw numeric
bodies through `Installer::dispatch_extended` and the component ABI. Expected values
come from the committed JavaScript oracle and are compared as binary64 bits; the
oracle's signed-zero string normalization is retained. Three additional malformed
or out-of-range bodies must be rejected. Overflow rejection is an existing Rust
parser behavior, not a claim of JavaScript overflow parity. The route gate runs this
probe before its separate installed People replay.

The echo fixture isolates the host parser. It supplies no People screen, People
repository, listener, sign-in or chat flow. Its result must not be presented as live
People application proof. The existing installed-package replay separately checks
contact-edit responses, all seven tables and note bytes. The manifest app map,
package change notes and README describe that distinction.

### Part-fourteen verification

- The final downstream probe failed with the host feature removed (`rc=1`):
  `1.00000000000000011102230246251565404236316680908203125` became
  `1.0000000000000002` instead of `1`. Its inspector uses the standard Rust float
  parser, so the failure is in the host's echoed numeric token rather than a
  second lossy JSON parse in the probe.
- With the feature restored, the identical probe passed (`rc=0`): all 283 numeric
  vectors and all three malformed/out-of-range rejection cases. Its lockfile has
  no native People package and no new third-party dependency version.
- All twenty-five native People tests pass (`rc=0`). The core and number-vector
  generators match their committed fixtures byte for byte. The frame bridge check,
  Rust app-map generation and scoped formatting pass. The generated Wasm component
  was rebuilt from this worktree with the approved pinned generator.

- The nine-suite People gate passed (`rc=0`, ten tests) through
  `scripts/run-gate.sh`; failing-first privacy controls exposed cross-user read and
  write access with protection removed and passed with protection restored for app
  and worker roles, including admin actors. Settings/folder privacy controls also
  failed first and passed restored. This is database/component evidence, not UI proof.
- The full signed installed-package route gate passed (`rc=0`): the standalone
  normal-host probe, frame bridge, 170 legacy route responses, all seven table
  snapshots and canonical note bytes. All four public APIs were routed through an
  installed consumer. Download, install, reload, folder selection and refusal without
  clearing were exercised. The fifty-reference request returned `202` in `7936 ms`
  with the replay's explicit `30000 ms` budget; this does **not** qualify the shipping
  five-second budget.
- Both gates tested code commit `0bab8729dcfbf92de672bc537105797888c1a43f`, with only
  this report dirty, input fingerprint
  `d525fc29d87dcf421d384a1c4ee5ea9eadc5258844716b74741c8ee37cb9eb75`.
  Their sentinel waits returned zero and both disposable database containers were
  removed. Receipt basenames are
  `task_106_rust_port_phase_5_people_module-20261108-235649-wAL8iF.log`
  (nine suites) and
  `task_106_rust_port_phase_5_people_module-20261109-002008-HjCXxH.log`
  (installed replay). Final report-only commits do not claim identical input hashes.
- Rebuilt component SHA-256:
  `8532551db8ee3f882913e4067fd8f335932efa468f3a29a9d0c808db8bd264c4`.
  Rebuilt package SHA-256:
  `06ef561f6e3d767034c048a8a253fd5b80138aaef7d4d3655ff6acf17ef89217`.
- Strict Clippy on the independent downstream probe passed (`-D warnings`, `rc=0`).
  The earlier interrupted Clippy run is not cited as a check result.

Root lint and type checking passed. Final formatting, file-size and independent-review
outcomes are recorded separately in the task proof. No full foundation, CI or live
application result is claimed.

### Remaining Phase 5 acceptance

Normal-host dispatch qualification narrows item one from part thirteen; it does not
complete the server listener or any other acceptance item:

1. Exercise raw numeric request bodies through the shipping authenticated listener
   after module-host composition, without earlier lossy parsing. Unusual numeric
   overflow and the broader parser/error inventory remain outside this finite oracle.
2. Compose the installed People frame and chat tools into the real Rust server.
   The current shell still composes shell/Today/chat routes, not an installed module
   frame. Keep the app a client of the local or remote server API.
3. Finish ingest nudges, real provider composition, command retention/quotas and the
   fifty-reference shipping budget. Broaden backend-failure, large-data and directory
   collation coverage beyond the existing enumerated replay.
4. Prove real installed UI and chat approvals, sign-in, trusted origins and privacy
   over HTTPS from desktop and a second physical device. The task browser initially
   failed to launch because Chrome's sandbox was unavailable. No rendered screen or
   second-device result is claimed.

All Cargo, Rustup and target caches used here belong to task scratch. The pinned
compiler and existing dependency caches were copied there; the declared Wasm standard
libraries were made available locally. Missing locked dependencies for the approved
`wit-bindgen =0.57.1` generator were fetched into that task-owned Cargo cache.
JavaScript dependencies came from the existing lockfile with an offline install.
No global tool or package was installed. No Vikunja card was changed.

## Part fifteen: canonical Unicode folder comparison

The relative People folder browser now treats canonically equivalent Unicode names
as equal when sorting. For example, `é` and `e` followed by a combining acute accent
compare equally, matching JavaScript `localeCompare`. The returned folder names and
paths keep their original spelling. Stable sorting preserves the incoming order of
equal keys; no folder or saved preference is renamed.

The task branch initially predated the People work. It was fast-forwarded while clean
to `0b8d143d7`, which contains the merged part-fourteen report (PR 4105), before edits.
The brief's PR 4066 reference describes older work.

The comparator normalizes its keys to NFC using `unicode-normalization =0.1.26`,
already declared by the repository's portability crate and present in the module-host
lockfile. The People lockfile adds that existing package and its existing `tinyvec`
dependency; no new third-party package version or global tool is introduced. The
only host changes are the People replay's folder fixture and its native dev-dependency
lock entry. The module remains a client of host ports, without database or filesystem
handles. Public APIs, SQL, privacy rules and folder settings are unchanged.

A JavaScript oracle records forty-two directional comparisons, including composed
and decomposed Latin, Greek and Hangul, canonical combining-mark reordering and case
comparisons. Native tests consume those recorded signs. Unrecognized composed letters
are decomposed into their base and accents for comparison, retaining the existing
special-letter weights. This avoids regressing decomposed Greek ordering. The installed
route replay adds decomposed `나` and composed `가` names to both real filesystem trees
and compares their order and exact returned paths against the legacy handler. These
names have distinct collation keys; equal-key comparisons are checked by native vectors
without relying on two independent filesystems to return tied names in the same order.

An initial investigation rediscovered the documented dollar-token compatibility
exception. A trial reproduction failed the existing intentional-safeguard test; all
trial edits were discarded. Literal dollar tokens continue to protect human note
text. No legacy replacement-token expansion ships in this checkpoint.

### Verification and acceptance boundary

Verification receipts for this checkpoint are recorded below after the final runs.
This is a bounded checkpoint: complete locale-sensitive ordering, authenticated server
composition and raw numeric listener qualification, ingest nudges, real provider
composition, command retention/quotas, the fifty-reference shipping budget and broader
backend-failure/large-data coverage remain open. Real UI/chat approvals, sign-in,
trusted origins, privacy and HTTPS from desktop and a second physical device still
require proof through the assembled Rust application. No standalone test or rendered
substitute is offered as that proof.

### Independent review follow-up

The first review identified a Greek ordering regression from composing a character
outside the existing accent table. The fallback decomposition and four added Greek
comparisons address it. Its major tied-directory replay concern was not reproduced
on this Linux/Node runtime: a fresh `readdir` probe returned UTF-8 byte order, matching
the host, despite scrambled creation order. The replay nevertheless now uses distinct
Hangul collation keys to avoid relying on cross-filesystem tie order. Native vectors
retain canonical equality coverage. The stale pre-manifest host build was restarted;
only final successful builds and gates may be cited as verification.
