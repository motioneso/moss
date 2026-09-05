# Relay 2: web search by default (#2228)

Worktree: `~/Jarv1s/.claude/worktrees/web-search`, branch `build/web-search-default`.
Plan: `docs/superpowers/plans/2026-09-04-web-search-default-native.md` (read by section only).
Spec: `docs/superpowers/specs/2026-09-04-web-search-default-native.md`.
Task issue: #2228. No coordinator pane for this run — direct boot task, brief at
`/home/ben/.coord-briefs/boot-web-search.txt`.

## What's done

Phase 5 (News Module Integration) is fully committed and green:
- `deaeec9ae` — actor-aware `webSearchReason` on `NewsPersonalizationAvailabilityPort`
  (module-registry, personalization-routes, routes.ts port, test fakes).
- `cbf701d00` — described-topics prereq gate copy (specific message when the actor's chat
  model has no built-in search) and the News manifest feature/remediation entry (this is
  also the app-map-truthfulness entry for this feature).
- `9bb6c0399` — new unit test `tests/unit/news-availability-web-search.test.ts` (4 cases,
  all passing) covering `resolveNewsWebSearch` (now exported from
  `packages/module-registry/src/index.ts`) for all four engine outcomes. Also updated
  `tests/unit/news-routes.test.ts` GET-personalization assertions for the new field.

Verified green just before this relay:
```
pnpm --filter @moss/shared typecheck        # clean
pnpm --filter @moss/module-registry typecheck  # clean
pnpm --filter @moss/news typecheck          # clean
pnpm exec eslint <all Phase 5 files> --max-warnings=0   # clean
pnpm exec vitest run tests/unit/news-availability-web-search.test.ts tests/unit/news-routes.test.ts \
  tests/unit/news-personalization-preview-connection.test.ts tests/unit/news-manifest.test.ts
  # 4 files, 57 tests, all passing
```
Not yet re-run: the full `tests/integration/news-*.test.ts` suite (needs the live dev
database per CLAUDE.md — go through the `verify-gate` skill, don't run directly). The two
integration test files touched (`news-personalization-routes.test.ts`,
`news-revalidation.test.ts`) only got a one-line fake-availability fix each; they were not
executed this session because they need the gated DB.

## Next: Phase 6

Read the plan's "Phase 6: User Interface and App Map Truthfulness" section (grep for that
heading) by section, not before. It covers:
- AI providers settings page wording: a "Use your model's built-in web search" switch and a
  status line.
- Confirm the CLAUDE.md app-map-truthfulness requirement is satisfied for every new setting/
  screen this feature adds (the News manifest entry from Phase 5 already covers described
  topics; Phase 6 will likely need a `packages/shared/src/app-map-core.ts` entry for the new
  AI providers switch, since that's a core setting, not module-owned).

## Hard invariants to keep honoring

- Provider-agnostic AI: never hardcode a provider or model name outside the provider family
  tables the plan describes.
- Module isolation: News never imports `@moss/settings` directly.
- App map truthfulness: any new setting or screen text needs its app-map entry in the same PR.

## Pre-push / finish line (unchanged from original handoff)

Before pushing: `pnpm format:check && pnpm lint && pnpm typecheck`, then `git fetch origin main &&
git rebase origin/main`. At the end: `coordinated-wrap-up` skill for the gate-DB recipe, push,
open the draft PR with the release note section filled in referencing #2228, note honestly
whether a live-path proof was possible. Do not mark ready, do not merge. Report line via
`herdr pane run w1:pD6 "..."` per the boot brief's DONE MEANS section, signed with pane id — or,
if this continues as a direct interactive session with Ben rather than under Herdr, just report
the PR link and status directly in chat.
