# Workshop D2 — durable user-message feed

Task #2305, part of #2023. Approved parent spec: Workshop projects and supervised builds.
Ben's blanket authorization applies; no new approval pause is required.

## Seams and contract

`packages/workshop/src/projects-repository.ts` supplies actor-scoped private project access.
`packages/db/src/data-context.ts:35` supplies one transaction to host composition. Existing
`packages/workflows/src/repository.ts:330` uses `forUpdate()` for durable serialization.
Workshop's manifest and migration-directory registration already own D1 lifecycle and SQL.

Add `0224_workshop_project_feed.sql`, never change applied D1 SQL. Add a per-project BIGINT
feed counter and Workshop-owned feed rows. A composite project/owner foreign key prevents
inserting one's own feed row under somebody else's project. FORCE owner RLS on both roles;
app may append user messages, worker reads only. Serialize appends by locking the project row,
deduplicate the client message UUID, then increment the counter and insert in the same transaction.
The lock holds through commit, so a reconnect cursor cannot skip an earlier uncommitted append.
A sequence alone is shorter but does not provide commit ordering; reuse the database row lock.

`WorkshopProjectFeed.append(db, projectId, {messageId,text})` returns `{entry,created}` or null
for missing/foreign project. Reusing a message ID with changed text conflicts. Text is nonblank,
NUL-free and at most 16 KiB. `list(db,projectId,{after,limit})` returns rows and the last persisted
sequence cursor, ascending, at most 100. Decimal BIGINT strings preserve precision across JS/JSON.
Cursor schema rejects invalid/out-of-range values. Export includes owner feed content and account
or project deletion cascades. All acknowledgement values come from the committed record.

The sole initial kind is `user_message`, with stored `pending` delivery. Future attempt/question
owners add their validated event kinds and acknowledgement transitions; no untyped JSON event
sink or premature delivered status. No model, route, queue, approval, execution or UI in this slice.

## Verification

Extend the isolated project integration suite: concurrent append/replay, changed-input conflicts,
reconnect across separate transactions, rollback without a cursor gap, foreign/missing denial,
raw composite-owner enforcement, worker insert denial, byte/cursor/page validation and scoped
export/cascade. `scripts/run-gate.sh start --gate test:workshop-projects --exclusive`, then
`wait --follow`, expected rc0. Root/test TypeScript, scoped lint/format, package and app-map checks
must pass. Kill gate: if append ordering requires a cross-module lock or owner bypass, stop the
slice and revise the Workshop-owned schema; no bypass is acceptable.
