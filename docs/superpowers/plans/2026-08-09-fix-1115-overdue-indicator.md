# Plan — #1115 one overdue indicator

**Spec:** `docs/superpowers/specs/2026-08-08-non-feature-wave-2.md` (row #1115)
**Issue:** Part of #1115
**Risk tier:** routine

## Seams check (file:line citations, current branch)

- `apps/web/src/tasks/task-list-view.tsx:65-69` — `DueInfo` interface: `label`, `tone`, `drift`.
- `apps/web/src/tasks/task-list-view.tsx:75-94` — `dueInfo(task, locale)`, pure, exported. Branch at
  `:81-83` returns `{ label: "Overdue", tone: "overdue", drift: done ? null : "overdue" }` — this is
  the only branch where `tone === "overdue"`.
- `apps/web/src/tasks/task-list-view.tsx:229-242` — icon/text badge (`tk-meta-due`), renders
  whenever `due` is non-null; shows an `AlertCircle` + "Overdue" text when `due.tone === "overdue"`.
- `apps/web/src/tasks/task-list-view.tsx:243-248` — drift pill (`jds-drift jds-drift--overdue`),
  renders whenever `due?.drift` is truthy; shows a dot + "Overdue" text when `due.drift ===
  "overdue"`.
- **Confirmed bug:** for a non-done overdue task, `dueInfo` returns `tone: "overdue"` **and**
  `drift: "overdue"` simultaneously, so both blocks render — two "Overdue" indicators on one row.
  For a *done* overdue task, `drift` is `null` (line `:82`, `done ? null : "overdue"`), so only the
  icon/text badge renders — already a single indicator, must stay that way.
- `tests/unit/web-day-classification-timezone.test.ts:1-6,68-80` — existing Tasks surface test,
  imports `dueInfo` from `apps/web/src/tasks/task-list-view.js` and asserts on `.label` / `.drift`.
  This is the "existing Tasks surface test" named in the spec's Scope row for #1115.
- No component-render test infra (`@testing-library/react`, `react-test-renderer` usage) exists
  anywhere in the repo today (`grep -rl` over `*.test.*` returns nothing) — spec's non-goals bar a
  "Tasks visual pass"/new abstraction, so this plan does not introduce one. The fix stays inside the
  pure `dueInfo` function, covered by the existing test file.

## Design decision

Add one field to `DueInfo`, computed inside `dueInfo`, so the "which indicator(s) show" decision is
made once, in the pure/testable function, not duplicated in JSX:

```ts
interface DueInfo {
  readonly label: string;
  readonly tone: "" | "overdue" | "today";
  readonly drift: "atrisk" | "overdue" | null;
  readonly showBadge: boolean; // false only when the stronger drift pill already shows "Overdue"
}
```

`showBadge` is `true` in every existing branch except the overdue-and-not-done branch, where it is
`false` (the drift pill renders instead). Concretely: `showBadge: done` on the `dueKey < todayKey`
branch (mirrors the existing `drift: done ? null : "overdue"` ternary — `done` and "pill will render"
are exact opposites there); `showBadge: true` on the other two branches (`today`, future).

Render change: `apps/web/src/tasks/task-list-view.tsx:229` — guard the icon/text badge block on
`due?.showBadge` instead of just `due`. No other JSX changes; the drift-pill block (`:243-248`) is
untouched.

**Determinism boundary:** no model involved. `showBadge` is a pure function of `task.status` and
`task.dueAt` vs. locale-bucketed "today" — same inputs, same output, every render.

## Task (single phase — routine, one file + one test file)

1. `apps/web/src/tasks/task-list-view.tsx`: add `showBadge` to `DueInfo`, set it in all three
   `dueInfo` return branches, gate the icon/text badge JSX on it.
2. `tests/unit/web-day-classification-timezone.test.ts`: add a `describe("#1115 ...")` block with:
   - `showBadge` is `false` for a non-done, overdue task (drift pill will render — this is the case
     that currently double-renders "Overdue"; **fails without the fix** because `dueInfo` doesn't
     return `showBadge` at all, so `.showBadge` is `undefined`, not `false`).
   - `showBadge` is `true` for a **done** overdue task (no drift pill; badge must stay the only
     indicator — guards against over-suppressing).
   - `showBadge` is `true` for a "Today" task and for a future/at-risk task (unaffected paths).

## Verification

```bash
pnpm --filter @moss/web exec vitest run ../../tests/unit/web-day-classification-timezone.test.ts > /tmp/1115-vitest.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`, all cases in the new `describe` block pass, and fail (non-zero, `showBadge`
assertion mismatch) if `showBadge` is reverted or removed from `DueInfo`/`dueInfo`.

Full gate + live-path proof per `coordinated-wrap-up` (isolated gate DB; `/tasks` screenshot showing
one overdue indicator on a non-done overdue task, posted as a `gh pr comment`).

## Kill gate

Owner: this lane, self-assessed before wrap-up. If the live-path screenshot shows the badge and
pill still co-rendering for a non-done overdue task, or the done-overdue row loses its only
indicator, stop — do not open the PR — re-check the `showBadge` branch logic against `:81-83`
before retrying. Single-phase, single-file change; no further phases planned.
