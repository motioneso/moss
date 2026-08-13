# Assistant-surface ordering: enforce claim-before-use (fail closed)

**Date:** 2026-08-12

**Status:** Approved via Fable design-fork ruling 2026-08-12 (Ben's overnight delegation, routed
by Coordinator). Ben sees this in the morning digest.

**Parent issue:** #1495 (ordering half of #1284; ruling N52 context in the
`chat-drawer-shows-live-surface` memory).

**Grounded on:** `origin/main` = `2852a12c3`, code fact-check this session.

## Decision summary

`createAssistantSurfaceHandle` (`apps/web/src/chat/assistant-surface/handle.ts`) holds
`currentSurface` as `undefined` until the module's first `setSurfaceKey` call. Today every use
before that claim **fails open into the user's main drawer thread**:

- `seedContext`/`submitTurn` (`handle.ts:82-87`) send no `surface` field — the host reads absent
  as the drawer, so the module's seed/turn lands in the user's main thread.
- `subscribeRecords` (`handle.ts:101-104`) falls back to the drawer subscription — module code
  receives the user's main-thread records. This read-side twin was not in #1495's text but is the
  same hole and is in scope by this ruling.

The contract already documents claim-first ordering (`contracts.ts:47-50`); nothing enforces it.
Ruling: **enforce it, fail closed**, on module-bound handles only:

1. **Writes fail loud.** `seedContext`/`submitTurn` on a module-bound handle
   (`moduleId` set) with no claimed surface reject with an error naming the contract
   ("claim a surface via setSurfaceKey before seeding/submitting"). A silent no-op is rejected —
   it hides the bug from the module author.
2. **Reads fail empty.** `subscribeRecords` on a module-bound, unclaimed handle returns a no-op
   subscription (no records delivered, unsubscribe is a no-op) and logs a `console.error` naming
   the contract. It does not throw: subscription happens declaratively during mount, where a
   throw crashes the module UI; delivering nothing is the fail-closed read.
3. **Drawer-bound handles (no `moduleId`) are untouched** — the drawer is their correct surface.
   `setSurfaceKey` semantics (including the `null` release from #1284) are unchanged.

Rejected alternative (from #1495): audit call sites and downgrade to a doc note. "Dead in
practice" doesn't survive the next module author, and the contract doc already failed to prevent
the gap it documents. Blast radius of enforcement is zero today: no in-repo production caller
invokes `seedContext`/`submitTurn`/module-bound `subscribeRecords` before claiming (the only
handle construction is `app.tsx:374`; job-search's `useProfileThread` left with the
cancellation).

**Fact correction to #1495:** the pinning test it cites
(`"falls through to the drawer …(pinned not fixed)"`) is **not on `main`** — it exists only on
the unmerged wave-5 lane-B branch (PR #1493, held). There is nothing to flip; this work writes
its own tests.

## Non-goals

- No change to #1284's claim/release/leakage semantics, `moduleChatSurface` derivation, or the
  `activeModuleSurface` shell wiring.
- No backend change: the host's absent-means-drawer reading stays (it is correct for the drawer
  itself); enforcement lives at the handle, the one seam every module goes through.
- No retrofit onto the held lane-B branch (PR #1493); it rebases onto this like anything else.

## Acceptance criteria

1. Module-bound handle, no claim: `seedContext` and `submitTurn` reject; **no network request is
   made** (asserted on the fetch mock).
2. Module-bound handle, no claim: `subscribeRecords` delivers no records and does not invoke the
   host subscription with the drawer surface; a `console.error` fires.
3. After `setSurfaceKey(key)`: seed/turn/subscribe all operate on the derived surface exactly as
   today (existing behavior asserted unchanged).
4. After `setSurfaceKey(null)` (release): subsequent seed/turn reject again — release returns the
   handle to the unclaimed state, not to the drawer.
5. Drawer-bound handle (no `moduleId`): all operations behave exactly as today.

## Rollout

Frontend-only, no migration, no API change. Ships as one PR.

## User-facing summary

Not directly user-visible. Closes a correctness/privacy gap in the module chat plumbing: a
mis-ordered module can no longer read from or post into your main chat thread — it now gets a
clear developer error instead.
