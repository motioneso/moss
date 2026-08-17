# #1137 — Tasks, notes, and commitments robustness follow-ups

**Date:** 2026-08-10

**Status:** Approved by Ben's Fable delegate on 2026-08-10

**Roll-up issue:** [#1137](https://github.com/motioneso/Jarv1s/issues/1137)

**Grounded on:** `origin/main` = `ba1acd70a7`, issue #1137, and the #1137 decomposition in
`docs/coordination/2026-08-10-follow-up-wave-decomposition.md`

**Pre-build grounding gate:** refresh `origin/main`, Project 2, open PR filenames, and the caller
inventory before filing any child. In particular, resolve #1246 before the tasks child and preserve
any notes or commitments work that has landed since this draft.

## Outcome

#1137 remains an open roll-up. Seven narrow child tasks close its eight findings without assigning
the parent to one builder:

1. invalid share targets are rejected before an `app.shares` write;
2. notes paths are rechecked immediately before path-following filesystem I/O;
3. concurrent note edits no longer silently overwrite one another;
4. commitment-candidate upsert is one atomic database statement;
5. commitment extraction failures produce bounded, content-free structured warnings;
6. commitment tools assert the branded data context at their boundary and the list route rejects an
   invalid status filter; and
7. stored evidence excerpts escape plain-text HTML metacharacters.

The parent closes only after every child is merged and its required automated and live-path evidence
is linked from #1137.

## Current-state grounding

The codebase graph and the live tree agree on the relevant choke points:

- `SharesRepository.grant` is in `packages/db/src/sharing/shares-repository.ts`. The graph finds one
  non-test caller, the UAT seeder; the live tree adds only tests. There is no production sharing
  caller at this baseline. The database foreign key rejects a missing grantee, but only during the
  insert and as an unhandled PostgreSQL error.
- `notesEditExecute` resolves and checks a file, then performs an unlocked
  `readFile`/replace/`writeFile`. The `oldText` contract already returns 409 when the precondition is
  not unique. The notes worker similarly resolves and checks a path before a later `readFile`.
- `packages/vault/src/vault-ops.ts` already contains the small ancestor-`realpath` containment
  pattern needed for an immediately-before-I/O recheck. Port the pattern into notes ownership;
  notes must not import vault internals.
- `CommitmentsRepository.upsertCandidate` performs SELECT, then UPDATE or INSERT despite the
  `uq_candidate_owner_sig` unique constraint.
- `extractCommitmentsFromText` converts both generation failures and malformed responses into `[]`.
  The worker also returns silently for missing provider/model/credential configuration, then a
  valid empty result is indistinguishable from failure in logs.
- The five commitment tool executors rely on repository assertions instead of asserting at their
  own boundary. `GET /api/commitments/candidates` casts any `status` query string to the union.
- `sanitizeExcerpt` strips only `<script>...</script>` and truncates to 500 characters.

## Locked decisions

### Parent and child shape

Do not implement against #1137 directly. Create one GitHub `task` child for each row in the ordered
plan below, mark it `Part of #1137`, and copy its owned surfaces, dependencies, acceptance, and
live-path ruling into the issue body. Each child is one fresh-agent session, one branch, and one PR.

File-disjoint children may build in parallel only after the Coordinator checks live PR filenames.
Children sharing a source or test file are serialized. A builder that cannot finish its row in one
session stops before code and returns a smaller re-slice.

### A — Share-target validation

Validate at the shared repository boundary because every present and future caller routes through
`SharesRepository.grant`.

- Run `assertUuid(input.granteeUserId, "share grantee user id")` before querying or inserting.
- Query the existing `app.get_user_by_id(uuid)` SECURITY DEFINER helper and select only `id`. A
  direct `app.users` query is wrong: ordinary app-runtime RLS exposes only the actor's own row and
  would reject every legitimate cross-user target.
- If the helper returns no row, throw the fixed repository error text `Share target user not found`
  before constructing the insert.
- Do not add a migration, duplicate the helper, catch PostgreSQL `23503`, or broaden user
  visibility. The foreign key remains defense in depth.
- Preserve the existing lifecycle contract: an existing pending or deactivated user is still an
  existing target. Changing which account statuses may receive a future share is product policy,
  not part of this low-severity validation fix.
- Preserve owner RLS, the no-self-share constraint, upsert behavior, injected timestamps, and valid
  grants.

### B1 — Immediately-before-I/O notes path recheck

Add one notes-owned async guard to `packages/notes/src/path-guard.ts`. It walks upward from the
target to the deepest existing ancestor, calls `realpath`, and rejects unless that resolved ancestor
equals the resolved notes root or is below it. Use `NotesPathError`; do not expose host paths in a
new API response.

Call the guard with no intervening `await` immediately before each affected path-following operation:

| Path                                            | Required recheck                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `notesCreateExecute`, overwrite branch          | before `writeFile`                                                           |
| `notesCreateExecute`, exclusive-create branch   | before `open(..., "wx")`; the returned file descriptor is then safe to write |
| `notesEditExecute`                              | separately before `readFile` and before `writeFile`                          |
| `notesDeleteExecute`                            | before `unlink`                                                              |
| shared `ingestResolvedMarkdownFile` worker path | before `readFile`, covering both worker handlers                             |

Keep the existing lexical Markdown validation, allowed-root resolution, `lstat`, `realpath`, and
containment checks. The new guard is a last-moment defense, not a replacement for them. Do not add
fd-based traversal, a filesystem abstraction, a dependency, or a migration.

A deterministic test must resolve an in-root target, swap an ancestor or target to a symlink aimed
outside the root, and prove the new guard rejects before outside content is read, changed, created,
or deleted. Retain happy-path coverage for ordinary in-root create/edit/delete and both notes-sync
worker entry points. Security QA must inspect every table row above for immediate placement.

### B2 — Lost-update control: process-local keyed mutex

Use a process-local mutex keyed by the resolved absolute note path. This is the chosen B2 contract;
there is no remaining Fable approval question.

The lock covers the B1 pre-read guard, read, unique-`oldText` check, B1 pre-write guard, and write.
Release it in `finally`; enqueue sync after release. Delete an idle key so unique note names cannot
grow the lock map without bound. Keep the current input and output schemas unchanged.

This choice follows the existing system shape:

- the supported Compose topology runs one API process, and `notes.edit` executes there rather than
  in the worker;
- the input already carries an optimistic precondition, `oldText`, and already uses HTTP/tool 409
  semantics when that precondition no longer holds;
- serializing the read/compare/write lets two non-overlapping edits both persist, while overlapping
  edits make the later call receive the existing 409 instead of silently winning;
- atomic rename alone does not serialize two read-modify-write operations, and an mtime check still
  has a stat/write race unless it adds a new versioned API contract.

Add a `ponytail:` comment at the lock stating its ceiling: if multiple API replicas become
supported, replace it with a cross-process file/advisory lock. Do not import the CLI runner's mutex
across module boundaries and do not add a lock package.

The concurrency test must start two edits against different unique substrings in one file and hold
both calls so they overlap. Both calls must succeed and the final file must contain both edits.
Add one overlapping-same-substring case: exactly one succeeds, the other returns the existing 409,
and the file contains one complete result. A timing-only test is not acceptable; use a deterministic
barrier or injected test seam local to this file.

### C1 — Atomic commitment-candidate upsert

Replace SELECT-then-UPDATE/INSERT with one
`INSERT ... ON CONFLICT (owner_user_id, candidate_signature) DO UPDATE ... RETURNING` statement.

- Insert the same fields and `source_count = 1` as today.
- On conflict, atomically increment the stored `source_count`, and update `last_seen_at` and
  `updated_at`.
- Preserve the canonical row's id, first-seen timestamp, title, kind, confidence, due date,
  counterparty, and suggested handling on conflict.
- Return the row from `RETURNING`; do not issue a follow-up SELECT and do not catch `23505`.

The database test runs two distinct transactions concurrently with the same owner/signature. Both
promises resolve, both return the same id, exactly one row exists, and its source count is 2.
Retain the sequential re-upsert and RLS coverage.

### C2 — Bounded extraction-failure visibility

Add a narrow optional warning logger to `CommitmentExtractionWorkerDeps` and pass the existing
worker logger through the single commitments registration block in the module-registry composition
root. Define the port locally as `warn(fields, message)`; do not create or configure another logger.

Emit one structured warning for each of these failure classes:

- source provider missing;
- no configured economy summarization model;
- selected provider or encrypted credential missing;
- decrypted credential invalid;
- adapter generation throws; and
- generated output is malformed or lacks a candidates array.

Each warning contains only a stable event/reason, `sourceKind`, and bounded `errorName` and
`errorMessage` fields. Cap each error string at 256 characters and remove CR/LF. Never log actor id,
boundary text, prompt, model output, provider response body, credential material, or encrypted data.
Valid `{"candidates":[]}` and prefilter misses are normal no-candidate outcomes and emit no warning.

Keep extraction best-effort and preserve current cursor/retry behavior. Do not add
`extraction_state.last_error`, a migration, a notification, or a new public response in this child.
Tests use a logger spy to distinguish a valid empty result from every failure class and assert that
sentinel prompt/model/credential text is absent from serialized warning fields.

### C3 — Commitment boundary validation

Call `assertDataContextDb(scopedDb)` as the first statement in all five executors in
`packages/commitments/src/tools.ts`: list, get, accept, reject, and snooze. Keep repository assertions
as defense in depth.

Give `GET /api/commitments/candidates` a Fastify query schema whose optional `status` is exactly the
six-value `CommitmentCandidateStatus` union:

`pending_review`, `accepted`, `rejected`, `snoozed`, `expired`, `explicit_non_action`.

Remove the unchecked string cast. An unknown value returns Fastify 400 before access-context or
repository work; omission and every valid value retain 200 behavior. Do not change the PATCH status
body contract, which intentionally permits only its current transition targets.

Focused tests call every executor with an unbranded context and pin the boundary error, then inject
the bare Fastify route with a fake repository to prove invalid 400, omitted 200, and all six valid
filters reaching the repository unchanged.

### C4 — Plain-text evidence excerpts

Replace the script-tag regex with one pass that maps `&` to `&amp;`, `<` to `&lt;`, and `>` to
`&gt;`, then truncates the stored result to 500 characters so the existing database constraint still
holds. Ordinary text, whitespace, quotes, and non-ASCII characters remain unchanged.

Do not add an HTML sanitizer or dependency. Excerpts are plain text, and React/Markdown escaping is
still defense in depth rather than the repository contract. Tests cover each metacharacter,
mixed/script-like input, normal text, and an escaped output whose final length is exactly 500 or
less.

## Ordered child plan

| Order | Suggested child title                                                | Exclusive owned surfaces                                                                                                                                                       | Dependency / collision rule                                                          |
| ----: | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
|     1 | **#1137-A — Validate share targets before grant writes**             | `packages/db/src/sharing/shares-repository.ts`, `tests/integration/shares.test.ts`                                                                                             | After #1246 and any live tasks-sharing work clear.                                   |
|     2 | **#1137-B1 — Recheck notes paths immediately before filesystem I/O** | `packages/notes/src/path-guard.ts`, `write-tools.ts`, `jobs.ts`; focused notes path/write/job tests                                                                            | Security-tier child. No overlap with B2.                                             |
|     3 | **#1137-B2 — Serialize concurrent edits per note path**              | `packages/notes/src/write-tools.ts`, its focused concurrency test                                                                                                              | B1 merged; rebase on its guard placement.                                            |
|     4 | **#1137-C1 — Make commitment candidate upsert atomic**               | `packages/commitments/src/repository.ts`, `tests/integration/commitments.test.ts`                                                                                              | Starts the repository chain; no overlap with C4.                                     |
|     5 | **#1137-C2 — Warn safely on commitment extraction failures**         | `packages/commitments/src/extractor.ts`, `workers.ts`, their focused unit tests, and only the commitments worker-registration block in `packages/module-registry/src/index.ts` | May run beside C1/C3 after live collision check; composition-root edit is exclusive. |
|     6 | **#1137-C3 — Validate commitment tool and status-query boundaries**  | `packages/commitments/src/tools.ts`, `routes.ts`, `tests/unit/commitment-tools-shape.test.ts`, `tests/unit/commitment-routes-shape.test.ts`                                    | File-disjoint from C1/C2; no broad route refactor.                                   |
|     7 | **#1137-C4 — Escape commitment evidence excerpts as plain text**     | `packages/commitments/src/repository.ts`, `tests/integration/commitments.test.ts`                                                                                              | C1 merged; rebase on its atomic statement.                                           |

The table order is the default filing and merge order. B1 → B2 and C1 → C4 are hard
serializations. A waits for #1246. C2 and C3 may build in parallel with the repository chain only
when the Coordinator confirms their exact files are free; C2's one module-registry block does not
reserve the rest of that large file.

## Trust and security contract

- RLS remains active for every actor. A uses the existing narrow lookup helper only to validate a
  supplied id; it does not add user listing or return identity data.
- B1 is security-tier defense in depth against a local attacker who can mutate a configured notes
  root. It must fail closed without reading, overwriting, creating, or deleting outside content.
- B2 does not weaken confirmation policy or turn a conflict into last-writer-wins. The lock is
  process-local by explicit supported-topology decision, not claimed as distributed locking.
- Commitment worker payloads remain metadata-only. C2 logs no user id, private content, prompt,
  output, or secret.
- C1/C3/C4 retain owner-only commitment RLS and never expose `resolutionRef` or other newly private
  fields.
- No applied migration is edited. This spec requires no new migration.

## Acceptance and live-path applicability

### Per child

| Child | Automated acceptance                                                                                                                                                                                                           | Live-path ruling                                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | A missing grantee fails with `Share target user not found`, a malformed id fails the UUID guard, and both happen before an insert; a valid cross-user grant and re-grant still pass; owner RLS and no-self-share remain green. | Not currently live-path applicable because `grant` has no production caller. Re-run the caller inventory after #1246; if a caller exists then, exercise that real share flow before merge.                                                                                                              |
| B1    | Deterministic swapped-symlink cases cover edit read/write, create/open, delete, and the shared worker read; normal in-root operations and sync still pass.                                                                     | Configure a disposable in-root notes source and exercise real assistant create/edit/delete plus sync. Do not place host paths or outside-file content in evidence.                                                                                                                                      |
| B2    | Concurrent disjoint edits both persist; overlapping edits produce one complete write plus one existing 409; lock-map cleanup is asserted.                                                                                      | Through the real assistant tool gateway, perform a normal edit and show the synced result. The race itself is proven by the deterministic harness because the UI does not issue two controlled simultaneous tool calls.                                                                                 |
| C1    | Concurrent identical upserts return one canonical id, one row, source count 2, and no `23505`.                                                                                                                                 | No separate UI proof: this is an internal worker repository race. It participates in C2's assembled extraction proof.                                                                                                                                                                                   |
| C2    | Logger-spy matrix covers every failure and valid-empty silence; secret/private sentinels never enter fields.                                                                                                                   | On a live dev worker with synthetic source data, trigger one deliberately missing-model/config path and record the single bounded warning, then restore configuration. If a real provider is configured, also run one successful extraction without putting private content or credentials in evidence. |
| C3    | All five tool boundaries reject an unbranded context; invalid GET status is 400; omitted and all six valid statuses are 200 and forwarded unchanged.                                                                           | Against the live authenticated API, record one invalid-status 400 and one valid-status 200. A normal commitment tool call proves the branded production path remains usable.                                                                                                                            |
| C4    | Repository tests prove `&`, `<`, `>` escaping, ordinary-text preservation, and final length at most 500.                                                                                                                       | Use only synthetic evidence. Confirm the real commitment read/tool path returns the stored plain-text-safe excerpt without rendering active markup.                                                                                                                                                     |

Every child runs its focused test file(s), package typecheck, and `pnpm check:file-size`. Database
tests and the final `pnpm verify:foundation` run use the repository's guarded verification
procedure; never invoke DB-touching commands unscoped. The PR records the exact commands and results.

### Parent roll-up

#1137 may close only when:

- all seven child issues and PRs are linked and merged in the allowed order;
- A's caller inventory is refreshed after #1246 and its live-path ruling is updated honestly;
- independent security QA passes B1 and confirms C2 warning fields contain no private or secret
  data;
- the complete focused test matrix and guarded `pnpm verify:foundation` are green;
- required live-path artifacts above are attached to their child PRs; and
- no child is merely code-complete/unverified.

## Non-goals

- No sharing UI, target picker, list-level sharing, invitation flow, or new share API.
- No migration from external notes roots into `VaultContext`, filesystem watcher, cross-host lock,
  edit-version field, mtime API, CRDT, merge engine, or note history.
- No commitment extraction retry redesign, persisted last-error column, operator dashboard,
  notification, model/provider choice, or prompt change.
- No commitment UI, route-family redesign, repository abstraction, sanitizer dependency, or broad
  commitments refactor.
- No changes to #1246 or any issue outside #1137's children.

## Stops and re-grounding triggers

- A production sharing caller landing under #1246 changes A's live-path requirement and may change
  its owned surface; stop and update the child before implementation.
- Multiple supported API replicas would invalidate B2's process-local guarantee; stop and request a
  cross-process lock design rather than silently shipping the mutex.
- A B1 implementation that cannot place the guard immediately before an operation without a broad
  filesystem abstraction must stop and re-slice; do not expand the child opportunistically.
- A C2 logger path that can include provider bodies, prompts, model output, actor ids, or credentials
  is a security blocker.
- Any need to edit an applied migration, add a public API field, or overlap another live PR requires
  Coordinator re-planning before code.
