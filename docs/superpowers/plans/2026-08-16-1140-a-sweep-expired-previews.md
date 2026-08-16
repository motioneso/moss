# Plan: 1140-A — sweep expired news previews

**Spec:** `docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md` § "1140-A: sweep expired
news previews" (lines 71-99).
**Issue:** Part of #1523 (`task` label, OPEN).
**Tier:** routine.

## Seams check

- `packages/news/src/discovery/preview-store.ts:32-44` — `put()` currently has no sweep step; it
  builds `ownerEntries` (owner-scoped) and applies the per-owner cap, then inserts. Confirmed on
  branch head, matches spec premise "at the start of `put`... delete every map entry whose age is
  greater than `ttlMs`" is not yet implemented.
- `packages/news/src/discovery/preview-store.ts:29` — `now` is already an injectable
  `() => number` (defaults to `Date.now`), usable directly for the sweep's single `now()` read.
- `packages/news/src/discovery/preview-store.ts:30` — `entries` is a plain `Map<string,
  PendingSourcePreview>`; iterable with `for...of` / spread, no new data structure needed.
- `packages/news/src/discovery/preview-store.ts:45-50` — `take()` already treats
  `now() - preview.createdAt <= ttlMs` as valid (inclusive at exactly `ttlMs`). The new sweep must
  use the same inclusive boundary (delete when `age > ttlMs`) so the two functions agree.
- `tests/unit/news-preview-store.test.ts:12-38` — existing tests cover owner-scoping, single-use,
  TTL expiry (via `take`), and per-owner cap eviction. None currently exercise cross-owner sweep at
  `put` time — this is the gap 1140-A closes.

No new platform capability, dependency, timer, or class is required. Nothing here is an open
question.

## Task 1 — sweep expired entries at the start of `put`

**File:** `packages/news/src/discovery/preview-store.ts`

**Decision (locked by spec, not invented):** insert a global sweep as the first statement in
`put`, before the existing owner-scoped cap logic:

```
const nowTs = now();
for (const [id, value] of entries) {
  if (nowTs - value.createdAt > ttlMs) entries.delete(id);
}
```

- Runs once per `put`, one `now()` read, deletes from `entries` directly (not just the calling
  owner's slice).
- Existing cap block continues to operate on `entries` after the sweep, using the same
  `ownerEntries` filter it has today — unaffected by this change except that expired entries no
  longer inflate any owner's count.
- No signature change: `put(preview: PendingSourcePreview): string` unchanged. No change to
  `take`, `createPreviewStore` options, or exports.

**Test cases** (added to `tests/unit/news-preview-store.test.ts`):

1. *Cross-owner sweep.* Owner A puts an entry, clock advances past `ttlMs`, owner B puts a new
   entry. Assert owner A's `take` now returns `null` (swept), proving the sweep is global, not
   scoped to the owner performing the put. Would fail against the current implementation, which
   only ever deletes within the *put-time owner's* cap logic and never inspects other owners'
   entries.
2. *Boundary.* One entry aged exactly `ttlMs` at the moment of a triggering put must survive the
   sweep (not deleted); an entry aged `ttlMs + 1` must be gone. Would fail against an off-by-one
   sweep condition (`>=` instead of `>`).
3. *Cap regression.* Existing "evicts the oldest preview per owner without affecting other owners"
   test (`tests/unit/news-preview-store.test.ts:27-38`) must continue to pass unmodified — proves
   the sweep doesn't change cap behavior for live (non-expired) entries.

## Kill gate

None expected — this is a single locked contract in one file with no design fork. If the sweep
interacts badly with the cap logic (e.g., an owner's cap count becomes wrong because sweep ordering
changed), stop and escalate to the coordinator before altering the cap logic itself; the spec
explicitly says "keep the existing... per-owner cap" unchanged.

## Verification

```bash
pnpm vitest run tests/unit/news-preview-store.test.ts > /tmp/1140a-vitest.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`, 4 tests passing (2 existing + 2 new; boundary case may be one `it` with two
assertions).

Full repository gate run separately at wrap-up per `coordinated-wrap-up` / `verify-gate`.

## Determinism boundary

N/A — no UI, no model involvement, no user-facing feedback surface. Pure backend data-structure
change.
