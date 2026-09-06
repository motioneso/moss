# Relay: web search by default (#2228)

Worktree: `~/Jarv1s/.claude/worktrees/web-search`, branch `build/web-search-default`.
Plan: `docs/superpowers/plans/2026-09-04-web-search-default-native.md` (read by section only).
Spec: `docs/superpowers/specs/2026-09-04-web-search-default-native.md`.
Task issue: #2228.

No coordinator pane is involved in this run — this is a direct boot task from
`/home/ben/.coord-briefs/boot-web-search.txt`. When done, follow that brief's DONE MEANS section:
push, open a draft PR against main referencing #2228 with the release note filled in, then send
one report line via `herdr pane run w1:pD6 "..."` signed with your own pane id. Do not mark ready,
do not merge.

## What is committed and green

- Phases 1-3 were already on the branch when this session started (commits
  d37a3628d, 8541bf658, d7b6ff7f5, 72ea021a6).
- This session committed Phase 4 clean and verified: commit `b1b4ef8a5`
  "feat(web-search): add model-native search provider and hide web.search when redundant (#2228)".
  Covers plan Phase 4 tasks 1-4 (createModelNativeProvider in packages/web-research/src/providers.ts,
  the provider-cache/resolver precedence update, the gateway.ts web.search visibility filter, and
  tests/unit/web-research-model-native.test.ts — 11 tests passing). Typecheck and eslint were run
  and clean for packages/web-research, packages/ai, and the root tests tsconfig.

## What is committed but NOT verified (start here)

Commit `66699a08a` "wip(web-search): start Phase 5 News actor-aware web search (#2228)" — partial,
untested. Read plan section "Phase 5: News Module Integration" (grep for that heading) before
touching anything below; the task list there is short.

Done in that WIP commit:
- `packages/module-registry/src/index.ts`: the News `availability.hasWebSearch` implementation is
  now actor-aware — it resolves the actor's effective chat model via
  `new AiRepository().selectChatModelForUser(scopedDb)` and calls `resolveWebSearchEngine` from
  `@moss/settings` (newly imported) instead of only checking the Brave key.
- `packages/shared/src/news-api.ts`: added `NewsWebSearchUnavailableReason` type (union of
  `"no-key-no-native-model" | "native-disabled" | "model-has-no-search"`) and an optional
  `webSearchReason` field on `NewsPersonalizationAvailabilityDto`, plus the matching JSON schema
  property.
- `packages/news/src/personalization-routes.ts`: only added the type import so far — no logic
  changes yet.

Still to do, in order:

1. In `packages/module-registry/src/index.ts` (same spot, around the `availability:` object for
   News, search for `hasWebSearch:`), add a sibling `webSearchReason(scopedDb)` function using the
   same `resolveWebSearchEngine` call: return `resolution.reason` when `engine === "none"`, else
   `null`. To avoid resolving twice, consider factoring a small local helper that runs the model
   lookup + resolver once and returns the whole resolution, then deriving both `hasWebSearch` and
   `webSearchReason` from it — but a straightforward duplicate call is also fine and matches
   existing style in that file.
2. In `packages/news/src/personalization-routes.ts`:
   - `PersonalizationRouteDependencies.availability` interface (near `hasWebSearch(scopedDb)`)
     needs a new method: `webSearchReason(scopedDb: DataContextDb): Promise<NewsWebSearchUnavailableReason | null>`.
   - The `GET /api/news/personalization` handler (search for `webSearchConfigured: webSearch` in
     the `response` object) needs to call `dependencies.availability.webSearchReason(db)` alongside
     the existing `hasWebSearch` call and set `webSearchReason: webSearch ? null : reason` in the
     response.
3. `packages/news/src/settings/describe-topics.tsx`: the `DescribeTopics` component's `else` branch
   (search for `PrereqGate requirement="Described topics need an AI model and web search."`) needs
   to read `props.availability?.webSearchReason`. When it is `"model-has-no-search"`, show: "Your
   chat model has no built-in search. Pick one that does under Assistant & AI, or ask an admin to
   add a Brave key." Keep the existing generic copy for every other case (missing json model,
   `native-disabled`, `no-key-no-native-model`, or reason absent). `PrereqGate` already links to
   `/settings?section=assistant` for both cases — the spec's "Chat model picker" vs "AI providers"
   distinction is wording only, not a different link, unless you find evidence otherwise when
   reading the settings page section of the plan.
4. `packages/news/src/manifest.ts`: plan Phase 5 task 3 — "Add described topics feature declaration
   and error remediation matching the new wording." Read the plan's Phase 5 task 3 bullet and the
   existing manifest features/remediations (grep `remediationRef` and `describedTopics` or similar)
   before writing this; it should match whatever copy you land on in step 3.
5. Unit test `tests/unit/news-availability-web-search.test.ts` (does not exist yet) — plan says:
   "Assert that News availability correctly reports search readiness per actor chat model." Look at
   `tests/unit/web-research-model-native.test.ts` (just added, Phase 4) and existing News route
   tests for the harness pattern (fake `DataContextRunner`/`scopedDb`, fake `AiRepository` model
   row) — grep `tests/unit/news-*.test.ts` for one that already exercises
   `registerNewsPersonalizationRoutes` or `PersonalizationRouteDependencies.availability`.
6. Run and get green, in this order, before moving to Phase 6:
   ```
   pnpm --filter @moss/shared typecheck
   pnpm --filter @moss/module-registry typecheck
   pnpm --filter @moss/news typecheck
   pnpm exec eslint packages/module-registry/src/index.ts packages/news/src/personalization-routes.ts packages/news/src/settings/describe-topics.tsx packages/news/src/manifest.ts packages/shared/src/news-api.ts tests/unit/news-availability-web-search.test.ts --max-warnings=0
   pnpm exec vitest run tests/unit/news-availability-web-search.test.ts
   ```
   Also re-run the existing News unit tests (grep `tests/unit/news-*.test.ts`) for regressions —
   the `hasWebSearch` signature did not change, only its implementation, so existing tests that
   inject a fake `hasWebSearch` should still work, but confirm.
7. Commit Phase 5 as its own commit (or a couple of commits, tests-first per plan) once green.

## Then: Phase 6

Read the plan's "Phase 6: User Interface and App Map Truthfulness" section by section, not before
Phase 5 is done. It covers the AI providers settings page wording ("Use your model's built-in web
search" switch, status line) and the CLAUDE.md app-map-truthfulness requirement — any new
setting/screen from this feature must get an app-map declaration in the same PR
(`packages/shared/src/app-map-core.ts` for core settings, or the owning manifest's `settings`
metadata for module-owned ones).

## Hard invariants to keep honoring

- Provider-agnostic AI: never hardcode a provider or model name outside the provider family tables
  the plan describes (this matters most in Phase 6's UI copy and any remaining adapter work, not
  in what's left in Phase 5).
- Module isolation: News must never import `@moss/settings` directly — that's why
  `NewsWebSearchUnavailableReason` was defined fresh in `@moss/shared` rather than re-exporting
  Settings' `WebSearchEngineResolutionReason`. Keep that boundary in Phase 6 too.
- App map truthfulness: any new setting or screen text needs its app-map entry in the same PR.

## Pre-push / finish line

Before pushing: `pnpm format:check && pnpm lint && pnpm typecheck`, then `git fetch origin main &&
git rebase origin/main`. At the end: `coordinated-wrap-up` skill for the gate-DB recipe, push, open
the draft PR with the release note section filled in, and note honestly whether a live-path proof
was possible (this feature is settings/backend-heavy — if no live dev instance is reachable, say so
plainly rather than skipping the section).
