# Meetings reversible filing — Phase 2b/2c implementation refinement

Part of #3777. Refines the [merged implementation plan](2026-10-26-meetings-any-recording.md)
for the [approved design](../specs/2026-10-26-meetings-any-recording-design.md).
All six [mockups](../specs/mockups/meetings-any-recording/index.html) remain approved.
Work stays in `~/Jarv1s/.claude/worktrees/meetings-build`.
Merge this plan-only PR and Phase 2a product PR #3790 before filing implementation.

## Entry, delivery and exit

Require Phase 2a's ordinary-chat live proof and merge. Preserve its owner configuration,
retained type identity, type-aware single-call summary and exact approval disclosures.
Merge this amendment through a plan-only PR before building. Ship reversible Notes/Memory
primitives with their owning boundaries, then the assembled filing coordinator and approved
What Moss took screen; no change to the approved scope. Audio and Calendar remain Phase 3.
Each product PR includes app-map declarations, release note, isolated gate and live proof.

## Current verified seams and gaps

| Capability                                             | Source                                                      | Decision                                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Immutable private Notes export                         | `packages/notes/src/private-note-export.ts:95`              | Keep existing export unchanged; add source contribution API.                                         |
| Meetings private-copy port                             | `packages/meetings/src/export-port.ts:12`                   | Add separate filing port; immutable exports are not mutable source contributions.                    |
| Host availability/index adapter                        | `packages/module-registry/src/meeting-export-runtime.ts:33` | Host composes public owning services and active-module checks before receipt transactions.           |
| Scoped linked roots                                    | `packages/vault/src/vault-context.ts:63`                    | Resolve Notes sources through their owning configuration and VaultContextAt.                         |
| Vault writes lack revision comparison                  | `packages/vault/src/vault-ops.ts:62`                        | Vault owns coordinated read/transform/publish; no caller-computed stale content.                     |
| Existing Notes lock is process-local                   | `packages/notes/src/write-tools.ts:190`                     | Replace for relevant mutations with a canonical-path transaction lock shared by API and worker.      |
| People rewrites topic notes                            | `packages/people/src/notes-service.ts:285`                  | Coordinate its read/transform/write through the same Vault mutation API.                             |
| Graph facts and search document                        | `packages/memory/src/graph-repository.ts:258`               | Write current graph, not legacy chat-facts store.                                                    |
| Correction creates a replacement                       | `packages/memory/src/graph-repository.ts:675`               | Preserve side/source association through correction; do not resurrect superseded or forgotten facts. |
| Reminder arrivals validate stored provenance           | `packages/chat/src/reminders/live-arrival.ts:66`            | Separate validated module-notice admission; retain reminder origin checks.                           |
| Account deletion cascades before private-vault cleanup | `scripts/delete-user-data.ts:134`                           | Inject owning cleanup capability before cascade; never import registry into this library.            |
| Runtime actor context does not fence deletion          | `packages/db/src/data-context.ts:54`                        | Durable deletion fence must be consulted by worker and service mutations.                            |

The concrete composition contracts below cite the current writer/deletion/job seams. Revalidate
those citations before each build task if the owning code changed. New contracts below are work
to implement, never claims that those services already exist. Do not treat missing dynamic graph
callers as proof of dead code. The builder owns remaining implementation choices.

## Owning public contracts

Use shared source identity `(sourceModuleId, sourceId, sourceVersion, itemKey)` and fixed side
`personal | work`. Every service receives AccessContext and opens actor DataContext; the model
cannot supply an owner, side, absolute path, access grant or executable operation.

Notes adds `RecordingContributionService` in `packages/notes/src/recording-contributions.ts`:

- `inventory(access, limits)` returns owner-accessible roots/folders/topic candidates with opaque
  candidate IDs, binding state and revisions. Bound item count, path bytes, excerpt bytes and total
  serialized response. Resolve executable destinations only inside Notes.
- `prepare(access, input)` returns source-keyed current/proposed diff, effective side, candidate
  revision and proposed destination; it never relabels unrelated existing content.
- `apply(access, input)`, `inspect(access, source)`, `change(access, input)`, `undo(access, input)`
  and `restore(access, input)` return durable receipt and explicit applied/unchanged/undone/conflict
  state. Exact public types live in `packages/shared/src/note-contribution-api.ts`.
- All application uses revision-checked source-owned Markdown blocks. Receipt keys and markers
  are deterministic; escape proposed text so marker syntax cannot terminate the source block.
  Missing, duplicated or externally changed markers are conflicts. Never replace a whole note
  snapshot on undo. Unrelated note edits survive both undo and restore.
- Fallback destinations are segregated generated private notes by side. Linked destinations
  require confirmed source/path side binding; conflicting side binding is rejected. An existing
  unlabelled nonempty note needs explicit before/after binding consent, even if discovery names it.
- Binding is keyed by canonical destination, preventing two source aliases from assigning
  opposite sides to one physical note. Owner authorization remains separate from allowed roots.

Vault adds a focused `vault-mutation.ts` operation requiring branded VaultContext and DataContextDb.
It canonicalizes the validated target, takes a transaction advisory lock on the canonical path,
reads current bytes inside that lock, invokes a bounded transform, compares expected revision,
then publishes atomically. Relevant Notes create/overwrite/edit/delete and People topic writers
participate. A lock only around publication does not prevent stale read/modify/write loss.
Coordinate aliases and multiple actors against the same physical destination.

External-editor boundary: serialize participating Moss writers; detect an external edit completed
before final comparison and never expose a partially written file. A comparison followed by atomic
publication is not compare-and-swap against arbitrary editors. State this limit in API/docs; do
not claim external filesystem CAS or roll back whole-note snapshots after a race.

Memory adds `RecordingMemoryService` in `packages/memory/src/recording-facts.ts`, exposing source
apply/inspect/change/undo/restore and side reconciliation through shared contracts. Extend current
graph fact provenance with fixed side and source association; legacy unlabelled facts remain so.
A source receipt identifies the created fact revision and any subsequent user correction/forgetting.
Replay cannot resurrect edited, superseded or forgotten facts. Restore is explicit and revision
checked. Update search-document activation together with graph state. Existing correction paths
carry the source/side forward instead of silently dropping the isolation label.

Chat adds `ModuleNoticeService` in `packages/chat/src/module-notices.ts`: durable owner/Main
admission, unique source/version/kind deduplication, stored deterministic assistant message,
explicit module-notice provenance and declared public action references. A PostgreSQL notification
carries IDs only; listener reloads the message and validates owner/thread/role/status/provenance
before live publication. History recovers deliveries after reconnect. Modules never inject turns,
choose arbitrary message IDs or write Chat tables through their own repositories.

Meetings adds `MeetingFilingPort` in `packages/meetings/src/filing-port.ts`, implemented solely by
`packages/module-registry/src/meeting-filing-runtime.ts` using public Notes/Memory/Chat services.
Availability checks happen before opening receipt transactions to avoid nested pool acquisition.
The port provides bounded discovery, source contribution/fact operations and durable notices.

## Ordered build tasks and ownership

Keep these tasks in this one worktree; each commit uses explicit paths. Prefer internal owning
primitives first, then the complete assembled product. A primitive-only PR cannot claim that the
filing feature is shipped; every exposed user behavior still needs the required real-model UI proof.

1. **Vault mutation and admission.** Own new `packages/db/src/managed-source-admission.ts`,
   `packages/vault/src/vault-mutation.ts` and public barrels. Migrate the named Notes, daily
   archive and People mutable writers to coordinated read/transform/publish. Add cross-process
   canonical-alias/disjoint-edit tests in `tests/integration/vault-managed-mutations.test.ts`.
   Observe the lost-update test fail with locking removed. Do not change unrelated binary exports.
2. **Notes contributions, bindings and snapshots.** Own new shared
   `note-contribution-api.ts`, Notes `recording-contributions.ts`,
   `managed-source-lifecycle.ts`, `managed-note-snapshots.ts`, owning SQL and catalog declarations.
   Inventory returns at most 200 destinations, 512 UTF-8 bytes per display path, 2048 bytes per
   excerpt and 256 KiB total; overflow is explicit, never unbounded model input. Bound each
   contribution to 16 KiB and each recording to 20 note items. Implement deterministic escaped
   blocks, idempotent receipts, exact undo/restore and side binding. Update both index producers
   through host-injected public snapshot ports, with stale embedding/continuation tests in
   `tests/integration/recording-note-contributions.test.ts`.
3. **Current Memory graph facts and lineage.** Own new shared `recording-memory-api.ts`,
   Memory `recording-facts.ts`, graph/repository/search types, owning SQL and public barrel.
   Bound proposed facts to 20 per output and 2048 UTF-8 bytes of fact text. Preserve all source
   associations through correction, split only the moving association when needed, and update
   episodes/search activation with each receipt operation. Add
   `tests/integration/recording-memory-lineage.test.ts`, including forgotten/superseded facts,
   unchanged-text side changes and killed late publishers. Leave unrelated legacy data unlabelled.
4. **Deletion composition.** Own root `managed-deletion-runtime.ts`, the deletion library/CLI,
   Settings dependencies/schemas, Meetings deletion service and relevant app maps. Implement
   exact pre-cascade cleanup and pending/conflict responses below. Test all three account
   entrypoints and record DELETE in `tests/integration/recording-managed-deletion.test.ts`.
   Re-run the existing topology/account export-delete regressions. No whole-note rollback.
5. **Durable Main notices and actions.** Own shared module-notice contracts, Chat
   `module-notices.ts`, stored provenance/live listener admission, public exports and declarations.
   Root adapters alone compose it with Meetings. Declare mapping confirmation, migration offer,
   side correction and item changes through ordinary action presentations. Add
   `tests/integration/recording-module-notices.test.ts`: reconnect/history recovery, duplicate
   admission, absent Main, wrong-owner/thread/provenance and current-source revision checks.
6. **Assembled filing and approved screen.** Own Meetings `filing-port.ts`, `filing-service.ts`,
   `filing-repository.ts`, `filing-jobs.ts`, `filing-routes.ts`, new shared
   `meeting-filing-api.ts`, root `meeting-filing-runtime.ts`, owning declarations and
   `web/what-moss-took.tsx`. Extend the existing output schema/inference and commit its intent
   atomically with current output. Wire bounded discovery/confirmation, fallback/topic filing,
   item change/undo/all/restore, source side provenance, flip reconciliation and terminal attempt
   recovery. Model fields cannot supply executable paths. Add the named real-model filing UAT;
   its passed assertions, full gate, CI and app-map/release note are exit criteria for the product.

Every owning schema migration adds export/deletion coverage in that same commit. Extract focused
helpers instead of pushing any existing source file beyond 1000 lines. Internal APIs are not an
excuse to bypass the full assembled acceptance before exposing filing controls.

## Persistence and ordering decisions

Choose new globally unused migration numbers when implementing; never edit applied migrations.
Own SQL in each module; declare every migration/table in manifest, catalog, export and deletion.
Force owner RLS and explicitly test both runtime roles; no admin private-data bypass.

- Notes: canonical destination bindings, source contribution receipts and current operation state.
  Retain expected/source block hashes, target references and source content needed for restore.
- Memory: fixed-side/source association and source-operation receipts referencing graph facts.
- Chat: notice admission deduplication plus ordinary stored message ID and delivery metadata.
- Meetings: filing intents, bounded proposals, discovery revisions/mapping confirmations, per-item
  receipt ledger, source side provenance and pending side-flip reconciliation.
- Account lifecycle: persisted deletion fence and cleanup intents survive retries before account
  cascade. Root composition injects cleanup; no private text is returned to the admin.

New generated output schedules filing intent atomically with its current effective identity.
Worker payload is actor/source/operation IDs only. Before application re-read source output,
recording/config revisions and deletion fence. A stale output never changes Notes or Memory.
Keep operation reservations short; provider calls and arbitrary filesystem waiting happen outside
unrelated DB row locks. Lock order and per-item commit boundaries must be explicit in tests.

A crash between filesystem publication and receipt commit is recovered by deterministic source
markers and current bytes, not by blind repeat append. Account/source deletion fences new work,
resolves or cancels reservations, cleans exact contributions through owner services, then cascades
receipt authority. Changed source blocks produce an actionable conflict, never silent data loss.

## Discovery, side decisions and reconciliation

The existing summary inference proposes bounded durable facts and filing content from evidence.
It inherits the recording's effective side for all items. Folder discovery is the second and only
additional model job: bounded inventory IDs -> proposed mapping/topic match. Schema descriptions,
a worked example and owning validators guard model-authored values. Added guidance stays below
150 words. UI feedback always comes from persisted records and receipts.

Cache side-specific methodology facts; do not leak work paths into personal-labelled knowledge.
Always ask for mapping confirmation in Main. Before confirmation, file in side-separated fallback
notes and explicitly offer migration. A confirmed mapping does not bind an existing unlabelled
note without its separate disclosed consent. Missing destinations trigger fresh bounded discovery;
never reorganize the folder tree.

Classification confidence below 0.8 produces a deduplicated notice naming the selected side,
reason and recording link. Declared chat reply actions offer explicit side correction. Persist
user side provenance so regeneration cannot overwrite an accepted correction.

Flip is a revisioned durable operation with old side, requested side and per-item progress.
Fence competing filing and flips. Prepare/validate new destinations, remove exact old blocks,
move contributions and reconcile fact sides. Do not show the flip complete while any surviving
item retains the old label. Crash/failure remains resumable and visibly pending/conflicted.
No cross-side content is written to an already incompatible destination, even during retry.

## Approved screen and acceptance

`What Moss took` follows the approved mockup, using Card, Badge, Button, Dialog and Field from
@moss/ui. Rows come from persisted receipts, with complete before/after review, change, per-item
undo, undo-all, explicit restore and useful pending/conflict/error states. Counts and saved text
never come from model claims. Keep shared layout, phone keyboard and focus restoration contracts.

Add `tests/uat/specs/3777-recording-filing-real.uat.spec.ts`: sign in, configure real model through
Settings, create recordings on both sides, observe actual notes/facts and Main notice, confirm
mapping, inspect diffs, edit one item, undo/restore, flip, reload and encounter a concurrent-note
conflict. Use synthetic source content through actual product/service paths; no network stubs,
screenshots or traces. Assert actual Notes/Memory state through public APIs and source content.

Integration checks must discriminate: missing locks loses a disjoint edit; absent side check
admits wrong-side filing; absent CAS overwrites a newer mapping; absent receipt uniqueness
duplicates after crash; absent user provenance permits regeneration to reverse a flip; absent
fence allows a worker to recreate deleted content. Observe relevant negative controls fail.
Include source/account deletion, linked root cleanup, alias destinations, both runtime roles,
corrected/forgotten facts, external block edits and cross-process writer interleavings.

Full checks only through verify-gate. Expected exit0 for start/follow terminal verdict. Claim
`devports claim meetings-build` for own instance, record exact clean commit and configured-model
UI assertions on PR, then `gh pr merge --squash --auto` after all required checks pass.

Kill gate owned by builder: stop and repair if replay duplicates an item, undo removes unrelated
edits, a cross-side write succeeds, side flips report completion before reconciliation, or the
assembled real-model flow cannot reach persisted receipts. Product scope decisions remain Ben's.

## Rejected forks

Whole-note snapshots simplify undo but erase later edits; source-owned blocks preserve them.
Per-process path mutexes cannot serialize API/worker or canonical aliases; use owning path locks.
Separate contribution files protect existing note bytes but change approved matching-topic-note
behavior; do not substitute them silently. Legacy ChatMemoryFactsRepository bypasses the current
graph/search state. Arbitrary Chat injection bypasses durable provenance and Main-only routing.

These are implementation decisions, not execution proof. SQL numbers are selected immediately
before implementation from the then-current catalog. The independent seam review below covers
the concrete composition decisions; it does not establish implementation correctness.

## Independent seam review and resolved decisions (2026-10-27)

Review found three gaps in the draft: indexed copies lacked side/lifecycle handling, corrected
Memory facts lacked explicit flip ownership, and deletion consultation was vulnerable to a
check/publish race. These are required work before this amendment is ready, not deferred claims.

### Managed source snapshots and indexed derivatives

Private-vault ingestion (`packages/memory/src/ingest.ts:31`) and linked Notes ingestion
(`packages/notes/src/jobs.ts:154`) independently publish complete note content into Memory.
Current unchanged checks compare content/model only (`ingest.ts:48`, `jobs.ts:181`).
Add an owning Notes snapshot contract containing opaque canonical destination identity, content
hash, binding revision, effective side and deletion generation. Memory receives the snapshot
through a public host-composed port, never by querying Notes tables. A label-only change must
invalidate the index even when Markdown bytes are unchanged. Retain side/source provenance on
chunks, index records and related documents; legacy unrelated data stays unlabelled.

Embedding can run outside locks, but publication must reacquire source shared admission and
compare snapshot identity, content/binding revisions and deletion generation. Pending nudge,
sweep and partial-file continuation jobs discard stale work. Flip, undo and source/account
cleanup invalidate derived rows and schedule only the authoritative current snapshot. Explicit
negative tests release a paused embedding job after a flip/delete and prove it cannot restore
old-side/deleted content. This is labelled derivative lifecycle, not a new global recall mode.

### Corrected fact lineage

Current correction creates a replacement from only the first source (`graph-repository.ts:684`)
and supersedes the original. Add durable source-association lineage connecting the recording
receipt, fact revisions, episode and search-document derivatives. Preserve user correction text
and keep its recording association/side explicit. Flip reconciles association/label across the
surviving lineage without regenerating or overwriting corrected text. If another actor operation
makes that lineage ambiguous, the flip remains conflicted; it cannot report complete. Undo/restore
must never revive the superseded original or a forgotten replacement. A user may explicitly
resolve the surviving contribution through its current before/after review.

### Atomic lifecycle admission, scoped to managed operations

Do not add a deletion check to every generic DataContext transaction. Introduce a focused owning
admission helper used by managed filing, source mutation, derivative publication and cleanup.
Shared actor/source admission spans the final publication and receipt transaction; deletion takes
exclusive admission on the same keys, persists a monotonic fence, drains/cancels admitted work,
and cleans exact source-owned blocks and Memory derivatives before authority is cascaded.
Locks are actor then source then canonical destination, with deterministic ordering for multiple
destinations. Provider calls and embedding run outside admission; completion reacquires/checks it.

Both self/admin Settings delete callers and the maintenance CLI inject the same public owning
cleanup capability into `scripts/delete-user-data.ts`, before the user DELETE. No registry import
in that library, no admin return of private paths or content. Cleanup authority and current fence
survive interrupted requests while the user/source row still exists. A changed source-owned block
records an actionable cleanup conflict and prevents the final cascade; unrelated external edits
are never removed. Owner-authenticated resolution is permitted while managed filing remains
fenced. Failure is reported explicitly; no response claims successful deletion before cleanup.

The concrete admission, deletion response and retry contracts below complete this decision.
They require an independent seam review before plan merge. No platform-wide lifecycle rewrite
is authorized by this decision.

### Participating filesystem writers and lock identity

Cover Notes create/overwrite/edit/delete (`write-tools.ts:232`, `:277`, `:320`), daily archive
publication (`daily-archive-writer.ts:39`), People create/update/archive (`notes-service.ts:240`,
`:285`, `:337`), and the new contribution operations. Existing immutable private exports use
exclusive creation; they still consult the managed source admission when creating filing targets.
Do not serialize unrelated attachment/export binaries through recording-specific policies.
Canonical identity is the resolved parent plus basename for absent targets and resolved pathname
for existing targets. Recheck identity after lock acquisition; aliases, delete/recreate and
future rename operations must acquire compatible keys before reading old content. A future
writer cannot bypass this documented owning mutation API for mutable topic destinations.

Retain the external-editor limitation: atomic publication and participating-writer locks do not
provide filesystem CAS against arbitrary editors. Detect completed edits at final comparison;
never promise protection from a simultaneous hostile ancestor change or uncooperative writer.

## Concrete lifecycle and composition contracts

This section supersedes the earlier draft's unspecified deletion-consultation and retry wording.
No generic DataContext behavior changes. New code is explicit, owning service work.

### Admission without a connection held across model work

Add `packages/db/src/managed-source-admission.ts`, exported from the DB public barrel. It owns
only transaction advisory lock keys, not module data or a general workflow engine. Public contract:

- `lockManagedActor(db: DataContextDb, actorUserId: string, mode: "shared" | "exclusive"): Promise<void>`.
- `lockManagedSources(db: DataContextDb, sources: readonly ManagedSourceKey[], mode: "shared" | "exclusive"): Promise<void>`.
- `ManagedSourceKey = { ownerUserId: string; sourceModuleId: string; sourceId: string }`.

Validate UUID owners/source IDs and bounded module IDs before deriving domain-separated 64-bit
lock keys. Sort/deduplicate source keys. All callers acquire actor, then sources, then canonical
filesystem destinations, then receipt rows. No caller opens a fresh service transaction while
holding a lock that transaction must acquire. Add scoped service operations alongside the public
AccessContext facades where one caller must commit several owning changes together; never forge
a DataContextDb or grant modules another module's repositories.

Notes owns `managed-source-lifecycle.ts` and new owner-RLS actor/source fence tables. Its public
service acquires the relevant locks before checking current fence/generation and returns a
branded admission usable only within that DataContext callback. Source IDs are recording IDs;
indexing a shared topic note additionally locks every managed source represented by its snapshot.
The actor fence covers account deletion; a source fence covers recording deletion. A missing
user/source authority is rejection, never a fresh generation. Ordinary actor transactions which
do not touch managed contributions, facts, files or derivatives do not participate.

Normal final publication holds shared actor/source locks through both filesystem publication and
its receipt transaction. Setting a deletion fence takes exclusive locks on the same keys, waits
for admitted publishers, increments a monotonic generation and commits `deleting`. After that
commit, no normal publisher can enter, even after the fencing transaction releases its locks.
Cleanup transactions are explicitly tied to the persisted deletion operation ID/generation;
they may enter a deleting fence, but cannot generate new content or bypass owner RLS. Conflicting
cleanup attempts serialize through the operation/receipt rows. Completed per-item cleanup stays
committed across a failed request. Cleanup rechecks the exact block revision before removal.

For a flip, acquire exclusive source admission, persist a new reconciliation generation and
invalidate the old derived snapshot before releasing it. Each short item transaction checks that
generation. Both source deletion and account deletion supersede pending flip/filing generations.
Provider calls and embedding run outside these locks. All late completions reacquire admission
and compare the complete source snapshot; stale completions become a no-op, never a retry which
writes an obsolete label. Source-block text must not be re-extracted from an old snapshot after
its contribution was undone.

### Account deletion stays an explicitly requested operation

Existing deletion entrypoints are `packages/settings/src/me-account-routes.ts:176`,
`packages/settings/src/routes.ts:673` and `scripts/delete-user-data-cli.ts:63`. The route
composition point is `packages/module-registry/src/index.ts:1831`; self-service dependencies
are forwarded at `packages/settings/src/routes.ts:274`. Existing last-admin authority is in
`scripts/delete-user-data.ts:172`, before the account DELETE at `:231`.

Extend DeleteUserDataOptions with an injected `prepareManagedDeletion` capability taking
`{ userId, requestId }` and returning an opaque completed generation or a typed pending/conflict
outcome. The library never imports module-registry. The callback's absence must fail closed when
managed contributions exist: the library checks only the installed lifecycle table's presence
and whether target-owned receipt/fence rows exist, without reading private content. Old tests and
installs with no managed rows keep their existing behavior. Production root/CLI always inject it.
No caller-supplied option may skip it for an account with managed rows.

The callback is invoked after the existing authoritative last-admin recheck, while that bootstrap
transaction still holds `jarv1s:last-active-admin`, and before DELETE/cascade. Its own short,
owner-scoped transactions persist the fence, clean Notes contributions and Memory derivatives,
and seal completion. They do not take the last-admin lock or nest transactions on their own
actor/source locks. No provider, network operation or embedding runs during account cleanup.
The bootstrap connection holds no actor/source lock while these callbacks run. Fence admission
prevents new publishers; the sealed generation prevents later cleanup changes before cascade.
The final DELETE then commits under the existing last-admin lock. DB failure after some cleanup
is resumable from committed receipts; do not promise failed deletion leaves all data untouched.
Private-vault subtree removal remains after DB commit, as in `delete-user-data.ts:244`.

Add `createManagedDeletionPreparation` in
`packages/module-registry/src/managed-deletion-runtime.ts`, composed from public Notes/Memory
cleanup APIs. Construct the CLI's ordinary runtime DB/DataContext/VaultContext dependencies at
its entrypoint and destroy them in finally. Trusted composition scopes cleanup to the requested
target; the administrator receives only a stable outcome code, never target paths, note text,
facts or private receipt payloads. Read-only status/details remain owner-scoped.

Each request processes a bounded cleanup batch, with persisted per-item progress. Pending work
returns HTTP 409 `managed_cleanup_pending`; changed blocks return HTTP 409
`managed_cleanup_conflict`. Self-service 409 schema currently enumerates only topology errors
(`packages/shared/src/me-api.ts:288`), so extend it and keep those existing codes distinct.
Admin DELETE/reject schemas (`packages/shared/src/platform-api.ts:577`, `:600`) declare the new
codes without returning private details. CLI returns nonzero and a scrubbed stable outcome on
pending/conflict, never deleted:true. A pending or conflicted request keeps the account, sessions
and fence; no response claims deletion succeeded. Retry the same endpoint with its normal fresh
confirmation factors, or rerun the confirmed maintenance command. No queued password/confirmation
body and no background job which can cascade an account later.

Use the existing owner What Moss took review/conflict surface for changed contributions. It may
review and explicitly accept removal of its exact current source block under a fresh revision;
unrelated text is preserved. Ordinary filing remains fenced. No admin-only private review path.
Settings deletion error handling (`apps/web/src/settings/delete-account.tsx:53`) gives clear
pending/conflict guidance and an owner Meetings link. Do not invent another settings screen.
Extend the relevant Settings and Meetings app-map errors/remediations in the same product PR.

### Recording deletion and worker retries

The current record DELETE invokes `beforeRemove` inside its row-lock transaction
(`packages/meetings/src/routes.ts:64`); import cleanup is
`packages/meetings/src/recording-import-service.ts:212`. Replace its root wiring with a public
MeetingDeletionService facade. First prove owner access, then fence and clean through owning
services outside the record-row transaction, then enter a final admitted transaction and invoke
the existing import cleanup plus record remove. No nested pool acquisition from beforeRemove.
Return 204 only after cleanup and cascade. A disappeared record remains idempotent 204. Return 409
`meeting_cleanup_pending` or `meeting_cleanup_conflict` for retained fenced records; reusing the
same deletion operation resumes it. Account deletion supersedes its source-cleanup operation.

Add the `meetings.filing` queue and its owning declaration in
`packages/meetings/src/filing-jobs.ts`. Register it through the Meetings built-in entry's
queueDefinitions/registerWorkers in `packages/module-registry/src/index.ts` (existing worker
composition at `:3259`). Queue options: retryLimit 3, retryDelay 60, expireInSeconds 180,
retentionSeconds 1209600. Each job validates exactly
`{ actorUserId, resourceId, operationId }` UUIDs, all already metadata-allowlisted in
`packages/jobs/src/pg-boss.ts:100`. Persist intent and enqueue atomically using sendJob plus
scopedJobDatabase, following `packages/meetings/src/stop-summary-jobs.ts:37`.

A pending transient owning operation throws for bounded queue retries. A terminal conflict saves
its visible conflict record and completes the job; it does not retry-storm. Expired retries leave
an explicit failed state. Owner Retry creates a new attempt ID under the same source intent,
preserving per-item receipts; duplicate requests cannot duplicate contributions. A worker restart
replays only current persisted operations. Stale generation, disabled module or missing source
cannot publish; disabled modules keep a visible retryable unavailable state. Source/account
cleanup runs on explicit deletion requests, not on this filing queue. These choices avoid a
second new account-cleanup scheduler or a platform-wide user-lifecycle rewrite.

### Derivative and correction details which are part of this slice

Managed destination identity is canonical across configured aliases. A global unique canonical
identity claim prevents two owners from establishing incompatible managed bindings: forced-RLS
rows remain owner-readable only; a conflicting claim returns unavailable, never another owner's
binding or contents. The global path advisory lock still serializes participating Notes/People
writers across actors. Unmanaged/external file edits remain outside side-policy enforcement.

A topic snapshot includes all active source contributions and their generations; removing or
moving one contribution invalidates the complete old indexed snapshot. Rebuild the remaining old
side note under its existing binding and index the new destination under the new side. Never
relabel an entire old topic note just because one contribution moved. Full private-vault nudges,
linked Notes sweeps and partial continuations must all use the same snapshot publication guard.
An unlabelled legacy snapshot cannot overwrite a managed side-labelled derivative.

Recording-created graph facts do not coalesce across opposite sides or silently absorb unrelated
legacy facts. Corrections copy all managed source associations to replacement lineage, not just
existing.sources[0] (`packages/memory/src/graph-repository.ts:684`). If same-side facts have
multiple recording associations, undo removes only that association; a flip must separate the
moving association into its own labelled surviving fact without replacing user correction text.
A forgotten lineage stays forgotten; a superseded original stays superseded. Episode and search
publication participates in the same admission/generation checks. Ambiguity is a visible conflict.

### Required additional discriminating cases

- Pause final publication under shared admission; account/source fencing must wait. Release it,
  fence, then release a previously paused embedding: no deleted/old-side derivative is recreated.
- Run two cleanup requests plus a filing retry across processes: one source-owned removal, stable
  receipts, no duplicate facts, and successful retry after a simulated post-filesystem crash.
- Call all three account-deletion entrypoints with managed rows and a missing cleanup dependency:
  no cascade. Check self/admin 409 schemas and CLI nonzero on pending/conflict, and that the owner's
  existing session survives until actual deletion succeeds. Preserve all existing topology guards.
- Make account deletion fail after one committed cleanup item, then retry the confirmed request:
  it resumes the same fenced operation and does not re-delete an unrelated edit.
- Use an alias and another actor on one destination: no incompatible managed binding and no
  lost disjoint participating-writer update. The second owner never receives first-owner content.
- Move one of two old-side contributions and release a stale partial continuation: remaining old
  note retains its label, moved item/new derivative has the new label, and no stale chunk returns.
- Correct a fact with several source associations, forget its replacement, then flip/undo/replay:
  no original/reactivated replacement and no erased correction. A split association preserves text.

### Terminal attempt reconciliation (independent review follow-up)

Independent seam review found no architectural blocker and identified a required implementation
detail: pg-boss retry exhaustion/expiration does not update a Meetings operation row itself.
Do not implement the promised failure state only in the worker's catch block.

Persist the exact accepted job UUID, attempt ID, source generation and a bounded attempt deadline
with the intent transaction. Add `reconcileFilingAttempt(access, meetingId)` to the Meetings owning
service. Owner ledger/status GET, Retry, cleanup admission and every replay call it before using
a pending attempt. Read only the stored queue/job ID through
`boss.findJobs(queue, { id, db: scopedJobDatabase(db) })`; the current pg-boss public API supports
this connection-scoped lookup (`node_modules/pg-boss/dist/index.d.ts:52`,
`dist/manager.js:773`). Validate returned actor/resource/operation metadata against the receipt.
Never enumerate arbitrary owners' job payloads or return pg-boss output to the browser.

A failed/cancelled job, a missing previously accepted job, or an elapsed attempt deadline moves
that current attempt to persisted failed state under actor/source/intent locks and invalidates its
publication lease. Use a fixed 15-minute attempt deadline; a queue delay beyond it is a truthful
retryable timeout. Late queued/active jobs cannot publish after reconciliation or their deadline,
even when their process was alive past expiration. Completed jobs without a terminal owning
receipt are reconciled from per-item receipts, never blindly marked applied. No handler may turn
an unchanged generation's partial receipts into a second contribution. Retry creates a fresh
attempt/lease and deadline, retaining the logical per-item receipt identities.

The pending What Moss took query refreshes at a bounded 5-second interval while visible, and
reconciles on reload/reconnect; stop refreshing after a terminal state. This deliberately makes
terminal-state reconciliation lazy on the next owner/status/cleanup access; it is not an unclaimed
always-running status synchronizer. Job process death and even deletion of retained job metadata
therefore cannot leave a displayed operation permanently pending. Test worker kill before catch,
retry exhaustion, expiration, missing retained job, deadline fencing and replay of a completed
job with only some committed items. Remove the terminal reconciliation/lease guard in separate
negative controls and observe the relevant failure before restoring it.

## Review rulings ledger

- Initial independent critique found three gaps: unlabelled indexed derivatives, lost correction
  lineage and a deletion check/publish race. The Managed source snapshots, Corrected fact lineage
  and Concrete lifecycle contracts sections resolve those findings without a global context rewrite.
- Follow-up reviewed the current deletion library/self/admin/CLI, record/import deletion,
  DataContext, queues and both index producers: no high-confidence architectural blocker.
- That follow-up required terminal operation reconciliation beyond a worker catch. The scoped
  installed pg-boss API, stored deadline and lazy owner-access reconciliation above address it.
  A delta review found no concrete blocker. Reviews were read-only; no implementation tests were
  run and no implementation or security result is claimed by this plan.
