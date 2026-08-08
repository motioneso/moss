# Plan: Fix News Vitest subpath alias (#1448)

## Scope

- Issue: #1448
- Spec: `docs/superpowers/specs/2026-08-08-non-feature-wave-1.md`, #1448 row
- Risk: routine
- No production behavior or user-facing surface changes.

## Seams check

- `packages/news/package.json:6-10` declares the existing `./web` export as
  `./src/web/index.tsx`.
- `packages/news/src/web/index.tsx:14-26` exports the News web contribution consumed by the
  generated module-web loader.
- `tests/fixtures/virtual-moss-module-web.ts:37-42` contains the test loader that imports
  `@moss/news/web`.
- `vitest.config.ts:208-212` currently aliases only bare `@moss/news` to `src/index.ts`; because
  the alias is prefix-matched, it rewrites `@moss/news/web` to a nonexistent path.
- `tests/unit/page-context-dom-capture.test.ts:7-12` locally mocks `app-route-metadata` to isolate
  the jsdom regression from the unrelated Sports subpath alias gap.

## Phase 1 — alias and regression

Files:

- `vitest.config.ts`: add `@moss/news/web` before the bare `@moss/news` alias, resolving to
  `packages/news/src/web/index.tsx`.
- `tests/unit/page-context-dom-capture.test.ts`: retain the existing `app-route-metadata` mock so
  this DOM regression does not transitively import the unrelated Sports subpath.
- `tests/unit/news-web-vitest-alias.test.ts`: directly import `@moss/news/web` and assert the
  public News contribution, exercising only the exact alias under test without a per-test mock.

The direct News alias regression fails against the current configuration because Vitest resolves
`@moss/news/web` through the bare alias and cannot find `packages/news/src/index.ts/web`. It passes
once the exact subpath alias wins before the bare alias.

Verification (each command must exit 0; commands are intentionally unpiped):

```bash
pnpm vitest run tests/unit/page-context-dom-capture.test.ts tests/unit/news-web-vitest-alias.test.ts
pnpm format:check
```

Kill gate: if the focused test still requires a mock after the exact alias is present, stop and
send the finding to Coordinator; do not expand the alias or change production code.

## Finish criteria

- Only the specific News web alias and its focused test workaround are changed.
- Focused jsdom regression passes with its existing isolation mock, and the News-only alias
  regression passes without a per-test mock.
- No dependency is added and no user-facing live-path proof is required.
- Coordinator receives the approved-plan handoff, then the coordinated-wrap-up report.
