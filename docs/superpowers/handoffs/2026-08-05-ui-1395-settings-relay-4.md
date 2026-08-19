# #1395 Settings relay 4 → 5 handoff

Context-meter forced checkpoint at 70%. Tree is clean, HEAD `181b4c66` (Task 3a committed).
Task 3b (Dialog conversion) is designed but **zero lines written** — start here.

## Read order (unchanged from relay 3)

1. This doc
2. `gh api repos/motioneso/Jarv1s/issues/comments/5195260909 --jq .body` (plan)
3. `gh api repos/motioneso/Jarv1s/issues/comments/5195303202 --jq .body` (approval — wins on conflict)
4. `gh api repos/motioneso/Jarv1s/issues/comments/5195097816 --jq .body` (D6 list)

Relay-3 doc (`2026-08-05-ui-1395-settings-relay-3.md`) is superseded for Task 3a (now done) but
still has the Task 3c–7 detail this doc doesn't repeat.

## Done: Tasks 0–3a

Commits `aeaaccba`, `920d508f`, `f19d1517`, `f8d1805b`, `dea61a1d`, `181b4c66`. Task 3a = pine→forest
Badge rename (14 files, verified via `git show --name-only HEAD`), barrel now re-exports
`Badge`/`ComingSoon`/etc from `@jarv1s/ui`. Don't redo.

## Task 3b — Dialog conversion (4 files, next up)

`Dialog` (`packages/ui/src/dialog.tsx`): props `title: ReactNode`, `description?`, `onClose: () =>
void`, `footer?`, `children: ReactNode` (**not optional**), `"aria-labelledby"?`, `className?`
(layout-only). **No `aria-label` prop.** Scrim div's onClick unconditionally calls `props.onClose`
on outside-click — any busy/isLive guard must move *inside* the callback you pass as `onClose`.

Design worked out by reading all 4 files in full — apply this, don't re-derive:

- **All 4 files currently use `aria-label`, not `aria-labelledby`.** Only `settings-feedback.tsx` is
  named explicitly in the plan for the accessible-name fix, but the fix is generic — apply it to all
  four for consistency and to avoid silently dropping the dialog's accessible name. Pattern: `const
  titleId = useId();` (precedent: `apps/web/src/tasks/task-details-sections.tsx:202`), pass
  `title={<span id={titleId}>...same text as before...</span>}` and `aria-labelledby={titleId}`.
  Exact wording may differ slightly from the old `aria-label` string (e.g. provider-login-dialog's
  old aria-label was "{displayName} sign-in" vs visible title "Sign in to {displayName}") — that's an
  acceptable cosmetic diff, not a contract break.
- **Only convert the scrim/dialog/head/foot wrapper to `<Dialog>`.** Leave inner `<button
  className="jds-btn ...">` markup untouched — Button conversion is Task 3c, separately scoped (312
  refs) and separately committed. Don't blend the two.
- **`settings-provider-login-dialog.tsx`**: `onClose={() => { if (!busy) close(); }}`. Maps cleanly.
- **`settings-feedback.tsx`**: simplest file, no form. `onClose={closeDialog}` (no guard needed).
  Original skips rendering `jds-dialog__body` entirely when `dialog.requireText === undefined`
  (common case — plain confirms with no typed-match field); `Dialog` always renders a
  `jds-dialog__body` div around `children` even if `children` is `null`. Check
  `packages/ui/src/styles/components-jarvis.css:83` (`.jds-dialog__body`) for padding before
  deciding this is a no-op — if it has visible padding, an always-present empty body div is a real
  visual regression for every plain confirm dialog and needs focused browser assertions on a
  no-requireText confirm shot. I hadn't finished checking this when checkpointed.
- **`terminal-modal.tsx`**: `className="terminal-modal"` via `Dialog.className`. Preserve the
  `isLive` scrim guard by moving it into `onClose={() => { if (!isLive) onClose(); }}` (note: the
  component's own prop is *also* named `onClose` — no actual collision, just don't confuse the two
  in review). Harder part: original wraps `<form onSubmit=...>` around body+foot for exactly 2 of 4
  phases (`set-password`, `locked`); the other 2 phases (`null`/loading, `unlocked`) have no form.
  Since `Dialog` renders `children` and `footer` as siblings (not nested), you can't put a per-phase
  `<form>` inside just one of them and still have the footer's `type="submit"` button trigger it.
  Fix: build the `<Dialog>` element once (children = body content, footer = footer content per
  phase), then conditionally wrap the *whole* `<Dialog>` in `<form onSubmit={...}>` only for the
  `set-password`/`locked` phases, return the bare `<Dialog>` for the other two. A submit button
  inside Dialog's footer div is still a DOM descendant of the wrapping form, so this preserves
  Enter-to-submit and `type="submit"` semantics exactly.
- **`delete-account.tsx`**: dialog surface is actually a `<form className="jds-dialog deldlg"
  onSubmit={onSubmit}>`, not a div. Same fix as terminal-modal: wrap `<form onSubmit={onSubmit}>`
  around the whole `<Dialog className="deldlg" ...>` call (form becomes an ancestor of the scrim too
  — harmless, forms have no default centering-relevant styling). `onClose={() => { if
  (!deleteMutation.isPending) close(); }}`.

After writing all 4: `cd apps/web && npx tsc --noEmit`, grep `tests/e2e` for Dialog-keyed assertions
(none found yet — do the grep, don't skip it), focused browser assertions (check the
delete-account and settings shots specifically — `capture-screens.spec.ts:307` and `:260`), `git
diff` review, commit with **explicit paths only** (this is a shared worktree — no `git add -A`, no
bare `git commit`), then `git show --name-only HEAD` to confirm.

## Then: Tasks 3c–7 (unchanged from relay 3, see that doc)

3c Button (312 refs, split by pane cluster), 3d IconButton+Segmented (6 refs, check if the 2
Segmented refs are inside `@jarv1s/ui`'s own render output first), 3e guard-6 burn-down
(`--st-swatch` not `--swatch`), Task 4 CSS split (wellness pattern precedent), Task 5 guard
registration (red-before/green-after, real run required), Task 6 e2e, Task 7 full gate + PR (open
only, do not merge, do not close issue) + report to coordinator via herdr-pane-message (pane
"DESIGN ELEMENTS", w1:p1) — not to Ben.

## Reminders that still apply

Gate against a fresh exported DB only, never live dev. Never pipe gate output through
`tail`/`grep`. Explicit-path commits only in this shared tree; `git diff` before, `git show
--name-only HEAD` after. If you hit another context-meter checkpoint: write+commit a handoff doc
and tell the coordinator — do not spawn your successor as an Agent-tool subagent.
