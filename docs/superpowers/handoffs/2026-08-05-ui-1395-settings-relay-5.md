# #1395 Settings relay 5 → 6 handoff

Context-meter forced checkpoint at 70%. Tree is clean except this doc. HEAD `02f3405e`.

## Read order (unchanged)

1. This doc
2. `gh api repos/motioneso/Jarv1s/issues/comments/5195260909 --jq .body` (plan)
3. `gh api repos/motioneso/Jarv1s/issues/comments/5195303202 --jq .body` (approval — wins on conflict)
4. `gh api repos/motioneso/Jarv1s/issues/comments/5195097816 --jq .body` (D6 list)

Relay-4 doc (`2026-08-05-ui-1395-settings-relay-4.md`) superseded for Task 3b (now done); relay-3 doc
still has any Task 4-7 detail not repeated here.

## Done: Tasks 0-3c

- Task 3a: `181b4c66` (Badge/ComingSoon barrel repoint, pine→forest).
- Task 3b: `2c155a2a` (Dialog conversion, 4 files: settings-provider-login-dialog.tsx,
  settings-feedback.tsx, terminal-modal.tsx, delete-account.tsx). Verified via tsc, e2e-assertion
  grep (no dialog-role/name selectors affected), and focused browser DOM/layout assertions.
- Task 3c: 4 commits `d993a572`/`105ee7cf`/`6ea8cf93`/`02f3405e`, one per pane cluster (A/B/C/D),
  24 files, 312 `jds-btn` refs converted to `<Button>` from `@jarv1s/ui`. Delegated to 4 parallel
  `general-purpose` Agent subagents (not a relay-successor spawn — intra-session task delegation,
  distinct topology, allowed). All verified: `npx tsc --noEmit` clean (from `apps/web/`), diffs
  spot-checked (Dialog-adjacent files untouched beyond import merges), `git show --name-only HEAD`
  confirmed per commit.
  - Two **documented exceptions**, left as raw `jds-btn` markup, correct as-is — do not "finish" them:
    - `settings-skills-pane.tsx` "Upload file" button: holds a `ref` for focus restoration
      (`listActionRef`). `Button`'s props type has no `ref` (not `forwardRef`-wrapped, no `ref` in
      `ButtonProps`) — extending the shared primitive's contract is a bigger design decision than
      this mechanical task covers. Left as raw `<button ref={listActionRef} className="jds-btn
      jds-btn--secondary jds-btn--sm">`.
    - `settings-profile-subviews.tsx` "Download" is an `<a href download>`, not a `<button>` —
      `Button` renders only `<button>`. Left as raw `jds-btn jds-btn--primary jds-btn--sm` anchor.

## In progress: Task 3d (IconButton + Segmented) — verification done, conversion not started

**IconButton**: plan said 4 refs; actual grep found 3, and one is out of scope:
- `apps/web/src/settings/settings-admin-panes.tsx:161` — convertible.
- `apps/web/src/settings/settings-ai-admin-pane.tsx:264` — convertible.
- `packages/settings-ui/src/priority/index.tsx:276` — **out of scope**, same file already excluded
  from Task 3c for `jds-btn` refs per the coordinator's ruling. Leave alone.

So only **2** real `jds-iconbtn jds-iconbtn--sm` refs to convert. Next step: read
`packages/ui/src/icon-button.tsx` (not yet read this session) to get `IconButton`'s prop contract,
then convert those 2 sites the same way Button was — worked examples for icon-only buttons already
exist in the Task 3c diffs (grep `icon=` in the pane-cluster commits above for the pattern: a
`title` attribute, not `aria-label`, carries the accessible name in every icon-only case seen so
far — check whether `IconButton` requires an `aria-label` prop instead before assuming `title` still
works).

**Segmented**: plan said 2 refs, found 2, both **verified as NOT needing conversion**:
- `packages/settings-ui/src/index.tsx:80-98` — this package's own local `Segmented` definition
  (analogous to the Badge/BadgeTone duplicate Task 3a's ruling already covers: "packages/settings-ui's
  own BadgeTone keeps pine, do not touch either" — same precedent applies here, this is the package's
  own primitive implementation, not a usage to convert).
- `apps/web/src/settings/settings-appearance-pane.tsx:172-189` — a raw `jds-segmented`/
  `jds-segmented__opt` usage, but it needs **per-option `disabled` and `title`**, which
  `@jarv1s/ui`'s `Segmented` (`packages/ui/src/segmented.tsx`) does not support (no per-option
  disabled/title in `SegmentedOption`/`SegmentedProps`). Converting would either regress the
  disabled/title behavior or require extending the shared primitive's contract — out of scope for
  this mechanical task, same judgment call as the Button-ref case above. **Leave as raw markup.**

No code written yet for the 2 real IconButton conversions — that's the next action.

## Then: Tasks 3e-7 (unchanged from relay 3/4, see those docs)

3e guard-6 burn-down (5 static inline styles + 2 swatch sites using `--st-swatch` not `--swatch`,
plus adding `--st-swatch` to `check-design-tokens.ts`'s allowList scoped to settings paths), Task 4
CSS split (wellness pattern precedent), Task 5 guard registration (red-before/green-after, real run
required, every registered path must resolve to a real file), Task 6 `pnpm test:e2e` (unpiped, same
commit as the conversions it protects — grep `tests/e2e` for assertions keyed to any control
converted; already spot-checked Button-name assertions this session, all keyed on visible
text/aria-label which conversions preserve exactly, no regressions expected but re-verify with a real
run before Task 7's gate), Task 7 full gate against a freshly self-exported gate DB (never live dev),
open a PR (do NOT merge, do NOT close the issue), then report to the coordinator via
herdr-pane-message (pane "DESIGN ELEMENTS", w1:p1) — not to Ben.

## Reminders that still apply

Never pipe gate output through `tail`/`grep`. Explicit-path commits only in this shared tree (never
`git add -A`/bare `git commit`); `git diff` before, `git show --name-only HEAD` after every commit.
Re-check `herdr pane list` before any tree-wide action. If another context-meter checkpoint hits:
write+commit a handoff doc and tell the coordinator — do not spawn a successor as an Agent-tool
subagent.
