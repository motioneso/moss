# Plan: #1412 — real space between masthead title and accent

Issue #1412, spec `docs/superpowers/specs/2026-08-08-non-feature-wave-1.md` (#1412 row).
Branch `fix-1412-masthead-space`. User-facing text → live-path proof required.

## Fix

`packages/ui/src/masthead.tsx:17-20` concatenates `<span>{title}</span><span>{accent}</span>`
with no whitespace node, so real callers (`today-labels.ts:45`: `top:"ONE"`,
`accent:"ON THE BOOKS"`) render `"ONEON THE BOOKS"`. Text-node bug, not CSS — no gap/margin
exists between `.jds-masthead__title`/`__accent` in `components-moss-today.css`, and the issue
is about accessible/copyable text.

Reuse the repo's established `{" "}` explicit-whitespace convention (e.g.
`wellness-trends.tsx:172`), only when `accent` is present:

```tsx
<h1 className="jds-masthead__title">
  <span>{props.title}</span>
  {props.accent ? (
    <>
      {" "}
      <span className="jds-masthead__accent">{props.accent}</span>
    </>
  ) : null}
</h1>
```

## Test (TDD)

New `tests/unit/masthead-ui.test.tsx`, relative import to `../../packages/ui/src/masthead.js`
(no `@moss/ui` alias in `vitest.config.ts`), pattern per `briefing-freshness-ui.test.tsx`
(`renderToString`). One case: render `{title:"ONE", accent:"ON THE BOOKS"}`, assert stripped
text contains `"ONE ON THE BOOKS"` and not `"ONEON"`. Red pre-fix, green post-fix.

```bash
pnpm exec vitest run tests/unit/masthead-ui.test.tsx > /tmp/masthead-unit.log 2>&1; echo "EXIT=$?"
```

## Live-path proof

New `tests/uat/specs/1412-masthead-title-accent-space.uat.spec.ts`, same shape as
`1112-today-masthead-oneline.uat.spec.ts` (`admin+data`, sign-in block). Mode-agnostic
assertion — proves a real single space regardless of which `buildHeadline` branch seed data hits:

```ts
const titleEl = page.locator(".jds-masthead__title");
const topText = (await titleEl.locator("> span").first().innerText()).trim();
const accentText = (await titleEl.locator(".jds-masthead__accent").innerText()).trim();
expect((await titleEl.innerText()).trim()).toBe(`${topText} ${accentText}`);
```

Add one row to `.claude/skills/coordinate/uat-trigger-map.tsv`:

```
blocking	packages/ui/src/masthead.tsx	tests/uat/specs/1412-masthead-title-accent-space.uat.spec.ts
```

```bash
pnpm test:uat -- 1412-masthead-title-accent-space > /tmp/masthead-uat.log 2>&1; echo "EXIT=$?"
```

Proof posted via `gh pr comment` at wrap-up.

## Pre-push (per coordinator note: main was red only on Prettier for the shared spec, fixed at

`00ec6d5f5` — rebase onto origin/main, do not touch the shared spec file in this lane)

```bash
pnpm format:check && pnpm lint && pnpm typecheck
git fetch origin main && git rebase origin/main
```

## Exit criteria

- [ ] `masthead-ui.test.tsx` red before fix, green after.
- [ ] UAT spec proves a real space through the live UI; posted as PR comment.
- [ ] PR carries a release-note sentence (user-visible text change).
- [ ] No dependency added, no file touched outside masthead.tsx + the two new test files + the
      trigger-map row.
