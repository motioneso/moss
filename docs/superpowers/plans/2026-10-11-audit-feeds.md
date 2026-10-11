# News and Sports audit recovery plan

Status: coordinator-approved bounded repair plan.
Task: [#3397](https://github.com/motioneso/moss/issues/3397), under umbrella plan
`f0a11eec90e78963387c6d246f2c38172453dfb0`.

Scope: LIFE-06 through LIFE-10 from the approved UX audit. This lane is stacked on
PR #3348 at `f3e6c057b621e76b79eab5e86b4c147edd30bb5e`, tree
`59bc999ef0a63eabb7f5a6793f27714d6d8c850a`. Existing visual work, editorial hierarchy,
canonical matching (#3227), and deferred subject-context work (#3241) are preserved.

## Verified seams

- Curated source/topic operations use the existing ordered, idempotent planner and
  `runOps` in `packages/news/src/settings/index.tsx:61-197`; reads and invalidation
  are wired at lines 240-258. No API or storage-contract change is needed.
- Failed preferences currently collapse to an empty array and remain writable at
  `packages/news/src/settings/index.tsx:327-350`; On/Off derives from that array.
- News filtering is canonical at `packages/news/src/web/news-page.tsx:25-31`, but
  emptiness precedes filtering at lines 66-91. The latest visual retry UI remains.
- Root disables focus refetch at `apps/web/src/main.tsx:16-22`; mounted News does
  not override it at `packages/news/src/web/news-page.tsx:38-44`.
- News story preferences already have list/update/undo APIs in
  `packages/news/src/web/story-feedback-client.ts:11-44`. A successful undo clears
  tab-local dismissal at `packages/news/src/settings/story-feedback.tsx:32-40`.
- The two Sports carousels share `useAutoAdvance` in
  `packages/sports/src/web/use-auto-advance.ts:17-48`. Hover and focus currently
  share one Boolean, and reduced motion is read only when the timer effect runs.
- Score refresh is separate at `packages/sports/src/web/sports-page.tsx:92-103`.
  Pausing rotation must not change that query or live score announcements.
- The isolated UAT fixture seam supports News RSS and Sports provider fixtures in
  `tests/uat/fixtures/espn-fixture-routes.ts:220-304`; `withEspnFixture` is supported
  by `tests/uat/run-uat.ts`. Browser interception is not live-path evidence.

## Ownership

Owned product files: News settings index and story-feedback, News page and story
feedback menu, Sports auto-advance hook, Sports page and story carousel.
Owned tests/docs: unique `audit-feeds-*` unit tests, this plan, and
`tests/uat/specs/audit-feeds.uat.spec.ts`.

Shared API clients/query keys, shared contracts, common fixtures, app-map entries,
UI primitives, dependency files, and UAT trigger map stay with the integration
owner. This lane supplies exact metadata deltas before publication.

## Phase 1: truthful News state

1. Require successful catalog and preference reads before displaying saved toggle
   states, effective counts, or executing toggle planners. A failed or pending read
   shows unknown/loading state and disables mutations. A failed refresh with cached
   values also blocks edits until Retry establishes current preferences. Keep
   independent personalization sections intact.
2. Compute visible-story presence after canonical matching. A healthy zero-result
   topic filter displays its topic and an All action; unavailable empty data names
   unavailable coverage instead of implying confirmed absence.
3. Set an explicit News query freshness contract: ten-minute stale time and focus
   refetch enabled for this query. Keep server TTL and existing invalidations; no
   new alert or background job.
4. Add distinct pending/failure/success receipts to curated preference writes and
   story feedback creation, editing, and removal. Preserve a rejected reason draft;
   prevent edit/remove overlap; place removal receipts above the list so the final
   row can disappear without losing its outcome. Positive feedback acknowledges a
   saved preference without claiming immediate ranking changes.

Tests: failed uncached and cached-error reads cannot invoke planners or POST default
subscriptions; Retry restores actual saved preferences; rejected saves remain
retryable; selected zero-match topic renders an action and All restores stories;
explicit focus refresh overrides a disabled root default; edit/remove outcomes and
retained drafts survive delayed, rejected and successful responses. Unit fixtures
are synthetic and do not establish assembled acceptance.

Kill gate: the coordinator stops/re-scopes this lane if any requirement needs a
new backend personalization contract, conflicts with #3348, or changes #3241.

## Phase 2: rotation control

1. Separate persistent user pause, hover, focus-within, and live reduced-motion
   preference. Internal focus moves cannot resume rotation. Subscribe/unsubscribe
   to media-query changes and clear timers on pause, shrink, and unmount.
2. Both existing Sports carousel control rows use a shared Button pause/resume
   control. Manual next/previous controls stay usable. Reduced motion explains why
   automatic rotation is off. Scores continue to refresh independently.
3. Pass existing degraded state to the empty Sports story hero; unavailable data
   cannot state categorically that no followed game exists.

Tests: hover then focus then mouseleave remains stopped; focus transfer within the
carousel remains stopped; explicit pause survives focus/hover departure and manual
selection; live reduced-motion changes stop/restart correctly without overriding
explicit pause; one-slide/shrinking pools and unmount clean up; score data changes
render while carousel rotation is paused.

## Determinism boundary

All receipts derive from query/mutation results and saved records. This work adds
no model task, model guidance, or injected chat turn. A saved preference receipt
does not imply that a future story has been reranked.

## Verification and browser acceptance

Expected exit 0: focused `pnpm exec vitest run tests/unit/audit-feeds-*.test.tsx`
plus existing News/Sports regression tests; scoped `pnpm exec eslint <changed TS>
--max-warnings=0`; scoped `pnpm exec prettier --check <changed files>`; root,
tests, and web TypeScript checks; design-token/UI-class/file-size guards.

Aggregate checks are coordinated on the assembled candidate. Any database-backed
gate uses `scripts/run-gate.sh` under the verify-gate skill, never a raw test or
migration command. Commands are unpiped and retain actual exit codes.

The dedicated UAT uses the existing fixture provider through the actual API and
UI on an isolated account, with no real subscriptions/providers or rewritten
browser responses. It covers News settings save/read-back, News feedback receipts
and removal, Sports pause/manual navigation, mixed pointer/keyboard inputs,
runtime reduced motion, and 1440/390/320 widths. Controlled unavailable/read/write
states require the coordinator's supported isolated outage setup; otherwise they
remain explicitly unit-tested and live-unverified. Record bounded DOM/network
assertions, not screenshots.

Browser tests must be observed passing before a live-path claim. Authored or
collected tests, synthetic component browsers, and focused unit passes are not
that proof. If the isolated instance cannot run, status is code-complete,
unverified. No merge, deployment, or existing-owner acceptance artifact changes.

### Verification as run (2026-10-11)

- Automated UAT `tests/uat/specs/audit-feeds.uat.spec.ts` covers News only: settings
  save/read-back and feedback receipts/removal, on fixture RSS/model inputs compiled
  through the production compiler behind the real API. It proves feedback UI/API
  persistence, not real News acquisition, production AI routing or live refresh.
- Sports pause/resume was proven manually on a real account with real ESPN data,
  following teams through the app and removing the follows afterwards. Evidence is on
  the PR. No automated Sports browser test exists.
- Mixed pointer/keyboard input beyond that manual run, runtime reduced motion, the
  1440/390/320 widths for Sports, and controlled unavailable/read/write states remain
  unit-tested only and live-unverified.

## Exclusions

No reader library, spoiler policy, new alerts, Sports redesign, News rotation
expansion, backend subject-context changes, real service operations, production
data changes, or Finance/Food/Job Search/Workshop work.
