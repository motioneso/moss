# #1139 — Chat and export UI follow-ups

**Date:** 2026-08-10

**Status:** Approved by Ben's Fable delegate on 2026-08-10 after binding corrections; no re-review
required

**Roll-up issue:** #1139

**Grounded on:** `origin/main` = `ba1acd70a`, issue #1139, and
`docs/coordination/2026-08-10-follow-up-wave-decomposition.md`

**Pre-build grounding gate:** rebase each child on the then-current `origin/main`, repeat the owned
surface and test inventory, and update stale line references after its dependencies merge. Do not
silently absorb new chat or Settings work.

## Outcome

#1139 remains an open roll-up. Five one-session child tasks close its five confirmed low-severity UI
defects without a combined frontend PR:

1. action-request resolution becomes single-flight and unmount-safe;
2. streamed records retire only their own optimistic fallback;
3. SSE ticks no longer rebuild the send callback or churn the queued-send drain effect;
4. a focus refetch cannot locally resurrect a private chat while close is in flight; and
5. the Settings export surface resumes polling the same job after a remount without another POST.

The children reuse the existing React Query, Playwright, chat-drawer, Settings, and #1000 UAT
harnesses. They add no package, public API, database field, route, state machine, or shared
abstraction.

## Current truth

The codebase graph identifies `ActionRequestCard`, `ChatDrawer`, `sameTranscriptRecord`,
`startDataExport`, `getDataExportStatus`, and the existing async export routes as the relevant
choke points. Local inspection of `origin/main` confirms:

| Finding | Current behavior                                                                                                                                                                       | Existing seam to keep                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| #26     | `ActionRequestCard.resolve` awaits a bare promise and then writes local state. A second click can enter before React commits `loading`; an unmounted card still owns the continuation. | `useMutation` is already installed and used by adjacent chat UI. The resolve route is already idempotent.                            |
| #28     | Both fallback cleanup and render-time suppression use kind + text matching. One streamed record can hide every identical fallback.                                                     | POST and SSE records already carry `messageId`; `sameTranscriptRecord` is the shared comparison.                                     |
| #29     | `sendMessage` closes over `props.records`, so every SSE record changes the callback and retriggers the drain effect dependency.                                                        | `ChatDrawer` already uses refs and a single `sendMessage` callback; only live records need a latest-value ref.                       |
| #30     | `closePrivateChat` clears local state and fire-and-forgets `endPrivateChat`. The privacy query remains focus-refetchable, and its success effect can restore stale `incognito: true`.  | The drawer already owns the privacy query and `QueryClient`; no server contract change is needed.                                    |
| #31     | `DataExport` keeps `jobId` only in component state. Unmounting stops polling and forgets the id.                                                                                       | `getDataExportStatus(jobId)` can resume any owner-visible job; POST already deduplicates active jobs but must remain user-triggered. |

The export POST must not run automatically on a first Settings visit. It creates a job when none is
active, so using it as a mount-time discovery request would turn navigation into an unexpected data
export. Reattachment therefore persists only the already-returned job id in tab-scoped browser
storage and resumes with the existing owner-scoped status GET.

## Dependency and collision locks

As of drafting, PR #1482 is open and edits `apps/web/src/chat/chat-drawer.tsx`; #1449 / PR #1494
changes default-drawer approval rehydration and collides in `tests/e2e/app-shell.spec.ts` and
`tests/e2e/mock-chat-api.ts`. Apply these locks:

- **1139-B, C, and D do not dispatch until both #1482 and #1449 / PR #1494 are merged.** Re-ground
  the drawer after both merges. B merges before C; C merges before D. Only one of those three may own
  `chat-drawer.tsx` or `tests/e2e/chat-drawer.spec.ts` at a time.
- **1139-A does not dispatch until #1449 / PR #1494 is merged.** Re-ground its action-card and
  app-shell test surfaces after that merge; do not resolve the known test-harness collision locally.
- **1139-E is independent** and may run in parallel with A or the drawer chain because it owns only
  the Settings export surface and its Settings test.
- Every child gets its own branch, child `task` issue, PR, focused checks, independent QA, and live
  artifact. No child edits another child's production surface “while nearby.”

Recommended dispatch graph:

```text
#1449 / PR #1494 merged ─────► 1139-A
#1482 + #1449/#1494 merged ──► 1139-B ─► 1139-C ─► 1139-D
spec approved ──────────────► 1139-E
```

Every child issue body says `Part of #1139`. The parent closes only after all five children merge
with their own verification evidence.

## Child 1139-A — Make action resolution single-flight

**Suggested title:** `#1139-A — Make chat action resolution single-flight and unmount-safe`

**Exclusive surfaces:**

- `apps/web/src/chat/action-request-card.tsx`
- the Approve/Reject describe block in `tests/e2e/app-shell.spec.ts`
- keep the existing render-only assertions in `tests/unit/action-request-card-preview.test.tsx`
  green; edit that file only if the rendered state contract truly changes

### Locked implementation

Replace the hand-written async continuation with the existing `useMutation` primitive. The mutation
accepts `"confirmed" | "rejected"`, calls `resolveActionRequest`, and returns that decision so the
settled UI derives its label from mutation data rather than a second, independently writable
decision state.

`mutation.isPending` remains the rendered disabled/loading source, but it is not a synchronous
double-click lock. Keep one component-local ref as the immediate admission guard: set it before
calling `mutate`, ignore another admission while set, and clear it in `onSettled`. Writing that ref
after unmount is harmless; do not add an `isMounted` flag or an `AbortController` to an API helper
that exposes no abort signal.

Preserve the current states and copy:

- pending/error: Approve and Reject controls;
- pending mutation: both controls unavailable and `Resolving…` visible;
- success: exactly one of `Approved` or `Not approved`;
- expired 409: `This request expired — ask again.` and no retry controls; and
- other error: existing retryable error presentation.

The existing focus-on-success/error behavior stays. It may derive from mutation status and parsed
error rather than the deleted local status, but resolution must never optimistically show success.

### Focused regression

Extend the existing real-component Playwright coverage, not the server-render-only unit test:

1. hold the resolve route open;
2. trigger the same Approve button twice in one browser task;
3. assert one request, both controls unavailable, and no success label before release;
4. unmount the drawer before releasing one run and assert no console/page error; and
5. retain the existing confirmed, rejected, expired, and transmitted-body assertions.

Focused command:

```bash
cd ~/Jarv1s
pnpm exec playwright test tests/e2e/app-shell.spec.ts --grep "Approve/Reject card"
pnpm exec vitest run tests/unit/action-request-card-preview.test.tsx
```

### Live-path artifact

After #1449 / PR #1494 merges, use a #1000 ephemeral instance with one real pending action request.
Sign in through the real login UI, reload, open the default chat drawer, activate Approve twice
rapidly, and show that the real resolve endpoint reaches one terminal decision and the card settles
once. Attach the run link plus before/pending/settled screenshots to the child PR. Mocked route
evidence alone is not completion.

## Child 1139-B — Reconcile fallbacks by record identity

**Suggested title:** `#1139-B — Preserve identical chat fallbacks until their own SSE records arrive`

**Exclusive surfaces:**

- the fallback reconciliation and `sameTranscriptRecord` seam in
  `apps/web/src/chat/chat-drawer.tsx`
- one named scenario in `tests/e2e/chat-drawer.spec.ts`

**Depends on:** PR #1482 and #1449 / PR #1494 merged; then-current drawer re-grounded.

### Locked implementation

Keep `sameTranscriptRecord` private and keep the existing fallback arrays. Tighten its identity
contract:

- kinds must match;
- when either side has a `messageId`, both sides must have the same `messageId` to match; and
- only the legacy case where neither side has an id falls back to kind + exact text.

Use that one predicate in both the state cleanup and `visibleFallbackRecords` suppression. Do not
compare array position, timestamp, rendered DOM text, or object identity. Do not move transcript
ownership out of the drawer or create a general record store.

The required fixture uses two same-kind, same-text fallback records with distinct ids. Deliver the
first matching SSE record and prove only its fallback disappears; deliver the second and prove the
remaining fallback disappears. Also retain one id-less legacy fixture so the existing kind + text
fallback is not accidentally deleted.

Focused command:

```bash
cd ~/Jarv1s
pnpm exec playwright test tests/e2e/chat-drawer.spec.ts --grep "identical fallbacks"
```

### Live-path artifact

On a real #1000 instance with a configured chat route, send the same text in two turns while the
browser is network-throttled enough to expose POST fallbacks before SSE reconciliation. Record the
drawer from both fallback rows through both streamed confirmations. Each logical turn must remain
visible exactly once; the first SSE arrival must not make its identical sibling flicker away. Attach
the video or ordered screenshots and run link to this child PR.

## Child 1139-C — Stabilize send across SSE ticks

**Suggested title:** `#1139-C — Keep queued chat drain stable while SSE records arrive`

**Exclusive surfaces:**

- the `sendMessage` callback and drain effect seam in `apps/web/src/chat/chat-drawer.tsx`
- one named scenario in `tests/e2e/chat-drawer.spec.ts`

**Depends on:** 1139-B merged.

### Locked implementation

Add one latest-value ref for `props.records` inside `ChatDrawer`, update it with the current records,
and read it only where the async send completion suppresses already-streamed fallback records.
Remove `props.records` from `sendMessage`'s dependency list. Do not ref-wrap every callback input,
move send state to a new hook, or rewrite the queue.

The callback may still change when genuine send preconditions change (`isSending`, private state,
history activation, or reviewed-thread data). The invariant is narrower: an SSE-only records tick
does not change `sendMessage`, so it cannot by itself rerun the drain effect. The existing effect
continues to clear `drainAfterStopText` before invoking the callback; one queued value produces at
most one POST.

### Focused regression

Extend the existing queued-send scenario. Hold the first turn, queue a second turn, emit several SSE
records while the first is settling, stop/release the first, and assert the captured turn bodies are
exactly `[first, queued]` in order. Assert the queued chip clears once and the queued text renders
once. Do not assert callback identity through an exported test helper; the network-visible behavior
is the contract.

Focused command:

```bash
cd ~/Jarv1s
pnpm exec playwright test tests/e2e/chat-drawer.spec.ts --grep "queued chat drain"
```

### Live-path artifact

On a real #1000 instance, start a turn that streams multiple records, queue a second message, stop
the first, and let the queue drain. The PR artifact must show the second message sent and rendered
once, plus real backend request evidence showing exactly two `/api/chat/turn` requests total. A
static screenshot without request evidence does not prove this child.

## Child 1139-D — Gate private close against focus refetch

**Suggested title:** `#1139-D — Keep private chat closed during focus refetch`

**Exclusive surfaces:**

- the privacy query synchronization and `closePrivateChat` seam in
  `apps/web/src/chat/chat-drawer.tsx`
- one named scenario in `tests/e2e/chat-drawer.spec.ts`

**Depends on:** 1139-C merged.

### Locked implementation

Keep the immediate local close: clear `privateMode`, `privateEnded`, transcript records, and fallback
records before awaiting the network. Add a synchronous component-local closing guard before
starting `endPrivateChat`. While that guard is set, the privacy-query success effect must not copy a
focus-refetched `incognito` value into local state.

When the end request settles, clear the guard and invalidate `queryKeys.chat.privacy`. The resulting
refetch is authoritative:

- success returns `incognito: false` and the drawer stays closed; or
- failure leaves the server private session active and the authoritative refetch may restore the
  private indication rather than falsely claiming closure.

Use the existing `QueryClient` and API function. Do not disable focus refetch globally, cancel every
chat query, add a server endpoint, or swallow the final authoritative state. The guard must be set
synchronously before the promise begins; relying only on mutation render state leaves the original
same-task race open.

### Focused regression

In one Playwright scenario, start with server privacy true, hold the end request, close private chat,
and trigger a browser focus event whose privacy GET still returns true. Assert the local toggle and
banner remain off while close is pending. Release the end request, return false from the invalidated
GET, and assert the drawer stays non-private. Add the failure branch only if it fits the same
scenario: a rejected end followed by true server state restores the indication.

Focused command:

```bash
cd ~/Jarv1s
pnpm exec playwright test tests/e2e/chat-drawer.spec.ts --grep "private close.*focus"
```

### Live-path artifact

On a real #1000 instance, start private chat, close it, and force a window blur/focus cycle during
the close request. Capture the real drawer staying non-private and the final real privacy response
reporting `incognito: false`. Attach the run and screenshots/video to this child PR.

## Child 1139-E — Resume an export after remount

**Suggested title:** `#1139-E — Resume Settings export progress after remount`

**Exclusive surfaces:**

- the `DataExport` component in `apps/web/src/settings/settings-profile-subviews.tsx`
- one named scenario in `tests/e2e/settings-shell.spec.ts`

### Locked implementation

Persist only the job id returned by a user-triggered successful `startDataExport` call in
`window.sessionStorage` under one component-private Moss-prefixed key. Initialize `jobId` from that
key on mount and let the existing status query resume polling. Keep storage access guarded so
server-side render tests and browsers with unavailable storage still fall back to current in-memory
behavior.

When the user chooses `Prepare a new export`, status is `expired`, or the status endpoint
definitively reports 404/unavailable, remove the stored id **and set the component's in-memory
`jobId` to `null`** so the `Prepare export` state returns immediately. A failed build may remain
attached long enough to render the existing `Try again` state; retry replaces the stored id with
the newly returned one. Do not store archive contents, status payloads, errors, user ids, or download
URLs.

The start mutation remains click-driven. Mount and remount issue no POST. The owner-scoped status
GET validates a restored id, so a stale id from an earlier login cannot expose another user's job.
Do not add `GET /api/me/export/active`, change `findActiveJobForUser`, use `localStorage`, or invent a
global export context.

### Focused regression

Add one Settings Playwright scenario:

1. POST returns a pending job id and its status GET returns building;
2. click `Prepare export` and observe building;
3. navigate to another Settings category so `DataExport` unmounts, then return;
4. assert polling resumes for the same id and no second POST occurs;
5. transition the status response to ready and assert the download link targets that id; and
6. choose `Prepare a new export`, remount again, and assert the old job does not reattach; and
7. restore an expired or definitively unavailable job id and assert both storage and in-memory state
   clear, returning the `Prepare export` control.

Focused command:

```bash
cd ~/Jarv1s
pnpm exec playwright test tests/e2e/settings-shell.spec.ts --grep "export.*remount"
```

### Live-path artifact

On a real #1000 instance, click `Prepare export`, leave Account & preferences while the real worker
is pending/building, return, and show the same job resuming through Ready and Download without a
second POST. Record the job id and job-count check as metadata only; never attach archive contents or
private exported data. Attach the run link and progress/ready screenshots to this child PR.

## Per-child completion gate

Each child must complete all of the following in its own session and PR:

- Re-ground its exclusive files after dependencies and stop on a new ownership collision.
- Add the single focused regression above; do not combine B–D into a broad chat UAT.
- Run its focused command, typecheck the web app through the repository's existing command, and run
  `pnpm check:file-size`. Run `pnpm verify:foundation` only through the repository's guarded
  verification procedure.
- Exercise the child through the real UI on a live #1000 ephemeral instance and post the run link
  and screenshots/video on that child PR.
- Obtain independent QA after the branch is rebased and checks are green.
- Keep `chat-drawer.tsx` below the 1000-line limit; these fixes do not justify a component split or
  an unrelated cleanup.

## Parent acceptance

- [ ] Five child `task` issues link back to #1139 and retain the exclusive surfaces and ordering in
      this spec.
- [ ] A repeated action decision creates one request and no post-unmount state continuation.
- [ ] Record ids keep identical fallback siblings independent through SSE reconciliation.
- [ ] SSE-only ticks cannot duplicate a queued send; one queue value drains once.
- [ ] Focus refetch cannot resurrect private mode while close is pending, and final server truth is
      reflected after settlement.
- [ ] Export remount resumes the same job through the owner-scoped status endpoint without an
      automatic or duplicate POST.
- [ ] Every child has focused green coverage, independent QA, and its own real-UI live-path artifact.
- [ ] All five child PRs are merged before #1139 is closed.

## Non-goals

- No combined #1139 implementation PR or shared frontend refactor.
- No backend, database, export-worker, vault, SSE protocol, or shared DTO change.
- No change to action-request idempotency, expiry semantics, or approval policy.
- No transcript normalization, ordering rewrite, or durable client-side chat store.
- No change to private-chat teardown policy beyond synchronizing the existing UI and query.
- No background export creation, cross-tab export synchronization, or persistence beyond the
  current browser tab. Cross-device discovery requires a separately specified read-only active-job
  endpoint.
- No new dependency, hook library, state manager, component framework, or public abstraction.

## Risks and stop conditions

- **Dependency drift:** if #1482 or #1449 changes the named drawer seams or solves one finding, delete
  or resize that child after re-grounding; do not preserve work for its own sake.
- **Identity drift:** if the post-merge SSE contract no longer carries message ids on current
  user/reply records, stop B and specify one-for-one legacy reconciliation rather than guessing from
  text.
- **Export storage denial:** unavailable `sessionStorage` must degrade to today's behavior, not make
  export creation or download fail.
- **Private close failure:** never leave the UI claiming non-private after the authoritative server
  query says the private session remains active.
- **Harness mismatch:** a mocked Playwright test is focused regression coverage, not the live-path
  artifact. If a child cannot be demonstrated through the assembled real UI, it remains
  code-complete, unverified and does not merge.
