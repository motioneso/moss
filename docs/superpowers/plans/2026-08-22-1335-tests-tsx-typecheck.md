# Plan: typecheck the `.tsx` files under `tests/` (#1335)

**Issue:** #1335 — no TypeScript project checks any `.tsx` file under `tests/`. The issue counted
54 files; as of 2026-08-22 there are **83** (81 in `tests/unit/`, 2 in `tests/unit/helpers/`).
The issue body is a sufficient spec: it names the blind spot, the failure mode (fixture drift),
and the preferred shape of the fix (a dedicated test tsconfig added to the `typecheck` script).
No separate design spec is required — this is build-tooling, not a feature or module.

## Grounding (verified in worktree `1335-tests-tsx-typecheck`, 2026-08-22)

All numbers below come from actually running candidate configs, not estimates.

1. Root `tsconfig.json` already has `jsx: "react-jsx"` and `strict`; its `include` has
   `tests/**/*.ts` only. It uses `module/moduleResolution: NodeNext` and **no DOM lib**.
2. A probe extending the root config with only `include: ["tests/**/*.tsx"]` + DOM lib produced
   **963 errors**, dominated by TS2835 (NodeNext demands explicit import extensions) and TS2307.
   These are artifacts: at runtime these files compile under vitest/vite (Bundler resolution).
3. Switching the probe to `module: "Preserve"`, `moduleResolution: "Bundler"` dropped it to
   **428**. Restoring the full root `paths` map (a child config's `paths` **replaces** the
   parent's — it does not merge) plus react-family mappings, and including the ambient `.d.ts`
   files listed below, dropped it to **324**.
4. Residual 324 splits into three distinct classes (see "Fallout" below); only one class is
   real findings in test files.

## Design

### New file: `tsconfig.tests.json` (repo root)

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    // Tests execute under vitest/vite, which resolves like a bundler, not like Node ESM.
    // Under the root's NodeNext these files throw ~330 false TS2835 extension errors.
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "noEmit": true
  },
  "include": [
    "tests/**/*.tsx",
    // Ambient declarations the included graph needs (css side-effect imports, ?raw imports,
    // virtual:moss-module-* modules). Without these: ~40 TS2882/TS2307.
    "apps/web/src/vite-env.d.ts",
    "packages/news/src/web/styles.d.ts",
    "packages/sports/src/web/styles.d.ts"
  ],
  "exclude": [
    /* module-web tests — see "Deliberate exclusion" */
  ]
}
```

### Root `tsconfig.json`: add react-family `paths` entries

`paths` does not merge across `extends`, so rather than duplicating the ~60-entry root map into
the tests config, add the react mappings to the **root** map (inherited by the tests config;
inert for the root program, where nothing imports react). These mirror the aliases
`vitest.config.ts` already uses at runtime — react and friends are `@moss/web`-only workspace
deps, deliberately not root deps (see the comment block in `vitest.config.ts`):

```jsonc
"react": ["apps/web/node_modules/@types/react"],
"react/jsx-runtime": ["apps/web/node_modules/@types/react/jsx-runtime.d.ts"],
"react-dom": ["apps/web/node_modules/@types/react-dom"],
"react-dom/client": ["apps/web/node_modules/@types/react-dom/client.d.ts"],
"react-dom/server": ["apps/web/node_modules/@types/react-dom/server.d.ts"],
"react-dom/test-utils": ["apps/web/node_modules/@types/react-dom/test-utils.d.ts"],
"@tanstack/react-query": ["apps/web/node_modules/@tanstack/react-query"],
"react-router": ["apps/web/node_modules/react-router"]
```

Check after adding: `pnpm --filter @moss/web typecheck` must stay green (it inherits root paths;
the mappings point at the same packages apps/web resolves normally, so no drift is expected —
verify anyway).

### Root `package.json`

- devDependencies: add `@types/react-test-renderer` (types-only; `react-test-renderer@19.2.7`
  is already a root devDep with no types → 31 TS7016 + a large implicit-any cascade).
- `typecheck` script becomes:
  `tsc --noEmit && tsc -p tsconfig.tests.json --noEmit && pnpm --filter @moss/web typecheck && pnpm check:external-modules`
  (CI runs this via `verify:foundation`, `.github/workflows/ci.yml` step "verify:foundation".)

### Deliberate exclusion: tests that render external-module web components

External-module web sources (`external-modules/*/src/web/**.tsx`) compile under the **classic**
JSX transform with `jsxFactory: "h"` and a deliberately loose global JSX namespace
(`JSX.Element = unknown` in `external-modules/job-search/src/web/jsx.d.ts` — modules sit outside
the pnpm workspace and cannot resolve `@types/react`; see also the #1418 note in
`packages/module-web-sdk/src/runtime.ts`). A single tsc project has one `jsx` setting, and any
test that imports a module screen pulls that screen's source into the program, where `react-jsx`

- real `@types/react` mis-checks it: **~200 of the probe's 324 residual errors** are this wall
  (TS2786 "cannot be used as a JSX component", TS2322 `unknown` → `ReactNode`, and their
  implicit-any cascade), landing in module source files that `check:external-modules` already
  checks correctly under their own configs.

Therefore `tsconfig.tests.json` **excludes** the tests whose import graph reaches an
external-module `.tsx`. Grounded list (grep for imports of
`external-modules/*/src/web/(root|screens|keyline|latch|score)`; implementer re-derives and
trims/extends it from actual tsc output):

```
tests/unit/external-module-finance-web-root.test.tsx
tests/unit/external-module-food-web-root.test.tsx
tests/unit/helpers/job-search-board-harness.tsx
tests/unit/job-search-keyline.test.tsx
tests/unit/job-search-manifest-conformance.test.tsx
tests/unit/job-search-overview.test.tsx
tests/unit/job-search-profile.test.tsx
tests/unit/job-search-resume-editor.test.tsx
tests/unit/job-search-web-board.test.tsx
tests/unit/job-search-web-board-inspector.test.tsx   (via the harness helper)
tests/unit/job-search-web-discuss.test.tsx
tests/unit/job-search-web-onboarding.test.tsx
tests/unit/job-search-web-root-settings-link.test.tsx
tests/unit/job-search-web-root.test.tsx
tests/unit/job-search-web-settings.test.tsx
```

That closes the blind spot for ~67 of 83 files now and keeps the check honest for the rest.
**File a follow-up issue** for the excluded set: the durable fix is typing the module-web SDK's
component surface against React's types (the #1418 `ReactNodeLike` precedent points the way),
which is module-platform work, not test-config work. The exclusion list in the config must carry
a comment naming that issue.

## Fallout handling

With the config above, remaining errors are **real findings in checked test files** (probe
estimate: a few dozen across the non-excluded tests — exact count emerges once the exclude list
is applied; the probe's per-file tallies put most residual test-file errors in the excluded
job-search set). Rules for the implementation PR:

- Fix type errors **in test files only** (fixtures drifted from real interfaces — the
  `assistantSurface()` case from the issue is the template).
- If an error reveals a defect in production code, do **not** widen this PR: file an issue and,
  only if the test cannot be made truthful otherwise, mark the single line with
  `// @ts-expect-error — #<issue>`.
- No blanket `@ts-nocheck`, no loosening of `strict`/`noUncheckedIndexedAccess` for tests.
- Behavior must not change: `pnpm vitest run tests/unit` (scoped, DB-free) before and after must
  show the same pass set. Any DB-touching test command requires the `verify-gate` skill.

## Steps

1. Branch from `main` (this worktree). Add `tsconfig.tests.json`; add react paths to root
   `tsconfig.json`; add `@types/react-test-renderer` to root devDependencies
   (`pnpm add -D -w @types/react-test-renderer`); update the `typecheck` script.
2. Run `pnpm exec tsc -p tsconfig.tests.json --noEmit`; re-derive the exclude list from actual
   errors (start from the grounded list above); fix residual test-file errors per the fallout
   rules.
3. File the follow-up issue for the excluded module-web tests; reference it in the config
   comment.
4. Checks (all must pass):
   - `pnpm typecheck` green (now four projects).
   - `pnpm --filter @moss/web typecheck` green (guards the root-paths addition).
   - `pnpm check:external-modules` green (untouched configs).
   - `tsc -p tsconfig.tests.json --listFiles` includes the expected ~67 test `.tsx` files.
   - `pnpm vitest run tests/unit` pass set unchanged.
   - `pnpm lint && pnpm format:check` green.
5. PR: release note `Category: N/A` (not user-facing). Lands alone, not folded into a feature
   branch (issue requirement). CI picks the new project up automatically via `verify:foundation`.

## Acceptance

- Every `.tsx` file under `tests/` is either typechecked by `tsconfig.tests.json` or named in
  its exclude list with a follow-up-issue reference — none fall through silently.
- Introducing a type error into a checked test file (e.g. deleting a required fixture field)
  makes `pnpm typecheck` fail.
- Full `verify:foundation` gate green in CI on the PR.

## Rulings taken (Fable, plan authority)

1. **Bundler resolution, not NodeNext**, for the tests project — matches how vitest actually
   compiles these files; NodeNext manufactures ~330 false errors.
2. **React paths live in the root tsconfig**, not duplicated into the child — `paths` replaces
   rather than merges on `extends`, and a 60-entry copy would rot.
3. **Module-web tests are excluded, with a named follow-up issue** — one project cannot hold two
   JSX dialects, and mis-checking module sources already covered by `check:external-modules`
   would bury real findings under ~200 false errors.
4. **Type fixes stay inside `tests/`** in the implementation PR; production defects found by the
   new check become issues, not scope creep.
