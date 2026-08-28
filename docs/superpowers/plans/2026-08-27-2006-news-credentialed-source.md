---
issue: 2006
title: Integrate credentialed News sources with refresh and health
status: approved issue spec, grounded on current branch
---

# Scope

The approved `SPEC` comment on issue #2006 is the source of truth. The prerequisite slices are
merged on this branch: #2005 stores owner-scoped encrypted credentials, #2007 provides the keyed
publisher runtime, and #2008 provides the Settings connection flow. This plan uses the current
names and migration sequence rather than the stale line numbers and `available`/`unavailable`
examples in that comment.

## Seams check

- `packages/news/src/compilation/candidates.ts:144-208` currently fetches every custom source with
  the public `NewsSafeFetchPort`; `:237-250` skips only `available` mismatches and records no
  failure reason.
- `packages/news/src/compilation/compile.ts:101-115` writes `unavailable` for every custom-source
  failure, so it cannot distinguish a rejected key from a temporary outage.
- `packages/news/src/revalidation.ts:72-74` treats only `unavailable` as attention-worthy, and
  `:108-135` fetches public URLs and can restore a failed credentialed source to `available`.
- `packages/news/src/personalization-repository.ts:135-145` and `:286-297` define and write the
  two-state health field; `:713` exposes the existing snapshot-domain pruning seam.
- `packages/news/src/credential-routes.ts:158-287` owns connect, replace, revoke, and status
  routes, but currently has no refresh/prune dependency or health transition.
- `packages/news/src/source/credential-lookup.ts:14-57` already resolves a stored key under the
  actor's `DataContextDb` and reports missing, revoked, or unreadable keys without exposing them.
- `packages/datasets/src/keyed-client.ts:116-217` already performs owner/source/generation cache
  isolation, checks credentials before cache reads, and refuses to fetch without a usable key.
- `packages/news/src/source/credentialed-source.ts:93-158` already sends the reviewed key only to
  the declared host and returns bounded failure classes; `:165-184` maps sanitized items to News
  headlines.
- `packages/news/src/routes.ts:240-274` is the composition seam for chat tools and credential
  routes; `packages/news/src/jobs.ts:94-243` is the worker compilation seam.
- `packages/news/src/manifest.ts:303-519` is the static assistant-tool, migration, route, and
  export/deletion declaration; `packages/news/src/chat-tools.ts:36-55` is its late-bound dependency
  seam.

## Decisions

- Add `packages/news/sql/0204_news_source_health_states.sql`, the next free News migration. It
  maps `available` to `healthy` and `unavailable` to `temporarily_unavailable`, replaces the
  check with `healthy`, `authentication_failed`, `temporarily_unavailable`, `unsupported`, and
  `disabled`, and preserves the existing worker `health_status` update grant. Do not edit 0159.
- Keep credentialed fetching on the existing keyed dataset runtime. Add one News-owned reader seam
  that supplies the source row, actor-scoped database, and `NEWSAPI_DATASET_KEY`; it maps only
  sanitized items to candidates. Public custom sources keep the existing safe-fetch path.
- Represent failures as `{ sourceId, reason }`, with only `authentication_failed` and
  `temporarily_unavailable` reaching health writes. Missing, revoked, and unreadable credentials
  become authentication failure and make zero network calls. A failed source remains stored and is
  skipped until a successful rotation or explicit state transition.
- Extend credential connect/replace/revoke route dependencies with the existing personalization
  store and `PgBoss`. After a successful replace, restore that source to `healthy`, prune its
  domain, and call `triggerNewsRefresh`; after revoke, set it to `disabled`, prune, and queue the
  refresh. The transaction writes the credential/source state before the refresh side effect.
- Add one read-only `news.credentialedSourceStatus` tool. It returns owner-visible label, domain,
  health, credential state, and fixed guidance to replace a key in News settings. It accepts an
  empty object and never reads or returns ciphertext, plaintext, headers, provider bodies, URLs,
  or raw errors.
- UI wording stays in the existing Settings primitives and CSS. Run the design-system audit
  before and after changes to `packages/news/src/settings/index.tsx`; do not add a new primitive or
  a raw color.

## Build phases

### Phase 1: health state and refresh behavior

Change `packages/shared/src/news-api.ts`, `packages/news/src/personalization-repository.ts`,
`packages/news/src/news-service.ts`, `packages/news/src/compilation/candidates.ts`,
`packages/news/src/compilation/compile.ts`, `packages/news/src/revalidation.ts`, the 0204
migration, and the manifest migration list. Add or update unit tests for health rendering in
`tests/unit/news-candidates.test.ts`, `tests/unit/news-compile.test.ts`, and
`tests/integration/news-revalidation.test.ts`.

The public seam test is `collectCandidates`/`compilePersonalizedNews`: one authentication failure
marks only that source `authentication_failed`, an unreachable source marks
`temporarily_unavailable`, existing good candidates still publish, and a second run skips the
failed source. The revalidation test proves a public homepage success does not heal an
`authentication_failed` credentialed source. Run the focused unit tests and observe exit code 0.

Kill gate: if the existing snapshot/degraded behavior cannot preserve good candidates while one
source fails, stop after this phase and report the conflict in the task record. The build owner is
the lane agent.

### Phase 2: credentialed runtime wiring and lifecycle

Add the News-owned keyed-source reader, wire it through `jobs.ts` and the module-registry worker
registration, and make the registry's `validateKey` use the existing host-pinned credentialed
adapter. Extend `credential-routes.ts` and `routes.ts` to restore/disable health, prune the source
domain, and queue the ordinary refresh. Update `packages/news/src/source/newsapi-connection.ts`
only if a shared keyed declaration is needed; do not add a second source or scheduler.

Test through the public compilation and route seams in `tests/unit/news-candidates.test.ts`,
`tests/unit/news-credential-routes.test.ts`, `tests/unit/news-credentialed-source.test.ts`,
`tests/integration/news-refresh-jobs.test.ts`, and `tests/integration/news-credentials.test.ts`:
missing/revoked/unreadable keys make zero calls, rejected keys do not fall back to public fetch,
rotation changes the generation and prunes/queues, revoke disables before refresh, two owners are
isolated, and public/curated sources remain unchanged. Observe focused tests at exit code 0.

### Phase 3: Settings and assistant status

Update `packages/news/src/settings/index.tsx`, `packages/news/src/settings/connect-publisher.tsx`,
`packages/news/src/chat-tools.ts`, `packages/news/src/manifest.ts`, and the route dependency
wiring. Add explicit wording/badges for all five health values and the fixed assistant result.
Extend `tests/unit/news-settings-pane.test.tsx` and `tests/unit/news-manifest.test.ts` to prove
the tool is declared, read-only, empty-input, and not allowed to manage credentials. Add
`tests/uat/specs/2006-news-credentialed-source.uat.spec.ts` and one row in
`.claude/skills/coordinate/uat-trigger-map.tsv`. The UAT must use a real HTTPS NewsAPI key from an
environment variable, never print it, and record only bounded DOM/network assertions.

The phase e2e test is `pnpm test:uat 2006`, observed at exit code 0 against the real Settings path.
If no live NewsAPI key is available, report `code-complete, unverified`; do not weaken HTTPS,
host-pinning, redirect, or response bounds.

## Full verification

Before pushing, run the safe gate through `scripts/run-gate.sh` using the verify-gate procedure and
observe exit code 0. Then run, unpiped, `pnpm format:check && pnpm lint && pnpm typecheck` with exit
code 0. Rebase on the current `origin/main`, push the existing `fleet/lane-2006` branch, open the
PR for #2006, run `node scripts/append-release-note.mjs --pr <number>`, and commit the release
note. Post a PR comment whose first line is exactly `LIVE-PATH PROOF` with the UAT command, exit
code, and bounded evidence, or state that the code is complete but unverified.

No database-touching test may run outside the verify-gate procedure. No secret may enter a test
fixture, payload, log, comment, snapshot, export, prompt, or documentation.
