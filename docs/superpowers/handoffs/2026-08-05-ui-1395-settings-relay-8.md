# #1395 Settings relay 8 → 9 handoff

Context-meter checkpoint at 71%. Tree clean (only `.claude/context-meter.log` modified, not mine).
HEAD unchanged at `7528511b` — **no commits made this relay**; this session was research +
tooling for Task 4, not yet applied to the real files.

## Read order

1. This doc
2. `docs/superpowers/handoffs/2026-08-05-ui-1395-settings-relay-7.md` (still accurate for
   Tasks 0-3e state and all standing rulings — not superseded, just one level further back)
3. `gh api repos/motioneso/Jarv1s/issues/comments/5195260909 --jq .body` (plan)
4. `gh api repos/motioneso/Jarv1s/issues/comments/5195303202 --jq .body` (approval — wins on conflict)

## Coordinator update received mid-relay — DO THIS FIRST, before any CSS split edit

Message from DESIGN ELEMENTS (w1:p1), verbatim substance: **#1394 Modules MERGED as `80e70bf0`.**
`origin/main` is now **23 CSS / 59 TSX** (not 14/56), and `packages/ui/src/styles.css` on main
carries three new `@import` lines (`components-news.css`, `components-sports-1.css`,
`components-sports-2.css`). Explicit instruction: **rebase onto origin/main BEFORE doing the CSS
split, not after** — the two new `components-settings-*.css` `@import` lines this task adds must
land AFTER those three; resolving that as a rebase conflict later is strictly worse than starting
from the merged file. Registration delta target is unchanged at **+4 CSS / +31 TSX**; compute
absolutes off **23/59** (expect settings to land at **27/90** if #1394's numbers hold and nothing
else merges first — recompute for real, don't trust that arithmetic blindly).

Do: `git fetch origin && git rebase origin/main` (or merge, if a coordinator override says merge —
none has; the coordinator's own word this relay was "rebase") in this worktree/branch before
touching any settings CSS file. No PR is open yet, so a rebase here is safe — nothing external
depends on the current commit SHAs. Watch for conflicts in `packages/ui/src/styles.css` (there
shouldn't be any yet, since this branch hasn't added its own imports there) and in
`scripts/check-design-tokens.ts` / `scripts/check-migrated-sections.ts` (both files #1394 also
touched, registering its own CSS/TSX paths — a real textual conflict is plausible there; keep both
sides' entries, #1394's and this section's).

## Task 4 — CSS split: plan verified, NOT yet applied to the real files

I wrote and validated a mechanical splitter (not committed — it's tooling, not product code) that
partitions each rule's declarations by `BANNED_VISUAL_PROPERTIES` (`scripts/check-design-tokens.ts`
lines ~70-86: color, background, background-color, background-image, border, border-color,
border-radius, font-family, font-size, font-weight, box-shadow, outline, fill, stroke, filter —
exact list, no cleverness beyond it), preserving source order, blank-line grouping, and top-level
comments (comments stay layout-side only, matching the wellness precedent). A rule with only banned
properties disappears entirely from the layout side and appears whole on the visual side; a rule
with both is split into two same-selector rules, one per file. `@media` blocks recurse the same way
and are dropped whole from a side if empty. `@keyframes` are atomic (kept layout-side unchanged —
verified their contents, `opacity`/`transform` only, neither banned, so this is provably lossless).

**Script: `/tmp/1395-split-css.js`** (plain Node, no deps — `node /tmp/1395-split-css.js <files...>`,
writes `<file>.layout.css` / `<file>.visual.css` next to each input and prints a selector/property
split-check count). This path is in **generic `/tmp`, not the session-scoped scratchpad**, so it
persists across sessions on this box — reuse it, don't rewrite it. If it's somehow gone, it's ~200
lines and the approach above is enough to reconstruct it from scratch; the property list is the
only part that must be exact.

**Verified output against the pre-rebase files** (re-run after rebasing — a merge from origin/main
touching these same files, unlikely but check, would change these numbers):

| source file | layout lines | visual lines | shared selectors / shared props |
|---|---|---|---|
| `settings.css` | 268 | 116 | 18 / 0 |
| `settings-panes.css` | 613 | 311 | 48 / 0 |
| `settings-panes-2.css` | 711 | 415 | 63 / 0 |
| `settings-panes-3.css` | 596 | 420 | 70 / 0 |

Combined visual destinations: `settings.css` + `settings-panes.css` visual → **427 lines**
(`components-settings-1.css`); `settings-panes-2.css` + `settings-panes-3.css` visual → **835
lines** (`components-settings-2.css`). **835 < 1000 — no `components-settings-3.css` split needed**,
decision 4's conditional doesn't trigger. Layout files (`settings.css` 268, `settings-panes.css`
613, `settings-panes-2.css` 711, `settings-panes-3.css` 596) all comfortably under the gate too.
Split-check total: **199 shared selectors / 0 shared properties** across all four files (this is the
number to report in the PR body in the same shape as prior sections' N/0).

Three sites Task 3e touched — confirmed each still splits cleanly in the script output:
- `.theme-swatch`'s `background: var(--st-swatch)` (settings-panes-3.css) → moves whole to visual
  (background is banned); `--st-swatch` allowlist entry in `check-design-tokens.ts` already
  anticipates this, no further change needed.
- `.psona-save__state--error` (settings-panes-2.css) → moves whole (`color` only).
- `.fld__sep` (settings.css) → moves whole (`color` only) — confirmed in the layout output I
  reviewed, it's fully absent from the layout side already.

### What's left to actually DO for Task 4 (successor's first real work, after the rebase)

1. Rebase (above), re-verify `origin/main`'s `packages/ui/src/styles.css` import order, re-run the
   script against the post-rebase files to catch any drift (should be none — #1394 didn't touch
   settings files).
2. Write the four `<file>.layout.css` outputs over the real `apps/web/src/styles/{settings,
   settings-panes,settings-panes-2,settings-panes-3}.css` (same filenames — layout stays in place,
   matching the wellness pattern of `wellness-{1,2,3}.css` keeping their names).
3. Prepend a short header comment to each real layout file's existing top comment, one sentence,
   matching `wellness-1.css`'s convention: "Layout only — visual declarations ... live in
   packages/ui/src/styles/components-settings-1.css and components-settings-2.css (#1395)."
   (`settings.css` and `settings-panes.css` → components-settings-1; `settings-panes-2.css` and
   `settings-panes-3.css` → components-settings-2). Don't delete the existing header content, append
   to it, same as wellness did.
4. Create `packages/ui/src/styles/components-settings-1.css` and `components-settings-2.css` from
   the `.visual.css` outputs, each prefixed with a header comment in the wellness style (see
   `packages/ui/src/styles/components-wellness-1.css:1-6` for the exact tone/shape to match).
5. Add both new `@import` lines at the end of `packages/ui/src/styles.css`, **after** the three
   `#1394` lines (`components-news.css`, `components-sports-1.css`, `components-sports-2.css`) —
   this is the ordering the coordinator flagged as the reason to rebase first.
6. Diff every rule against source intent before committing — the script is mechanical but not
   proven infallible; spot-check at minimum the three 3e sites above plus a handful of `@media`
   blocks (the ones with mixed layout+visual content inside them, e.g. `settings.css:120-125`
   `.set2__navgroup` inside `@media (max-width: 860px)`, to confirm the recursion split correctly —
   I reviewed this in the tool output and it looked right but did not diff byte-for-byte).
7. Run the #1392-style property-by-property split check as the actual committed proof (the script's
   built-in count is a reasonable stand-in, but re-derive it against the real committed files, not
   the scratch copies, before quoting a number in the PR).
8. Delete `/tmp/1395-split-css.js` reference from nothing — it's fine to leave in `/tmp`, it isn't
   part of the repo and doesn't need cleanup, but don't accidentally `git add` anything from outside
   the worktree.
9. Verify: `pnpm check:design-tokens`, `check:ui-classes`, `check:migrated-sections`,
   `check:ui-catalogue` all still green after the split (registration hasn't happened yet at this
   point — Task 5 — so these should be unaffected by the split itself, but confirm rather than
   assume).
10. Commit with explicit paths (never `git add -A`), `git diff` first, `git show --name-only HEAD`
    after.

No rules died outright in this section — I grepped `settings.css`/`settings-panes*.css` for
`jds-btn`/`jds-dialog` selectors and found zero hits, so decision 4's "rules that only restyle
jds-btn/jds-dialog die, not move" clause doesn't apply here; every rule either stays, splits, or
moves whole.

## Then: Task 5 guard registration, Task 6 e2e, Task 7 gate + PR

Unchanged in substance from relay 7's doc — restating only what's now different:

- **Registration absolutes**: compute off `origin/main` post-rebase (23/59 per the coordinator, but
  re-read `git log origin/main -1` yourself — don't trust a number handed to you without
  re-verifying, per this repo's own verification-discipline norm). Delta is still **+4 CSS / +31
  TSX**. `packages/ui/src/styles.css` union-resolve is now done at rebase time (step 1 above), not
  deferred.
- **`check-ui-classes.test.ts` holds a SECOND hardcoded `DEFINITION_FILES` list** — editing the
  script alone makes that fixture ENOENT. Update both.
- Prove registration isn't a no-op with TWO proofs per guard: red-before/green-after on an injected
  violation, AND confirm every added path resolves to a real file (`test -f`) — both guards
  `catch { continue }` on an unreadable path.
- **Gate discipline**: never pipe through `tail`/`grep`. `pnpm verify:foundation` against a fresh
  self-exported gate DB, never live dev. Excludes `test:e2e` — run separately, unpiped.
- **PR body must state**: CI's "Verify foundation and app" runs the browser suite, local gate
  doesn't; the split-check result (199/0, or whatever the post-rebase re-derived number is);
  browser assertions are corroboration not proof (one state/section); which `#1416` importers this PR
  closes (settings panes) vs. doesn't (six module packages + `task-details-dialog.tsx`) — post that
  as a factual comment on #1416, do not re-scope it. **Expect the coordinator to hold the merge on
  the live-path walk** — said explicitly by relay 7's coordinator message and unchanged.

## Reminders that still apply

Never pipe gate output through `tail`/`grep`. Explicit-path commits only (never `git add -A`/bare
`git commit`); a brand-new untracked file still needs an explicit `git add`. `git diff` before,
`git show --name-only HEAD` after every commit. Re-check `herdr pane list` before any tree-wide
action. Report to the coordinator via `herdr-pane-message` (pane "DESIGN ELEMENTS", w1:p1) — not to
Ben. Do NOT merge the eventual PR and do NOT close the issue. If another context-meter checkpoint
hits: write+commit a handoff doc and tell the coordinator — do not spawn a successor via the Agent
tool, use `herdr-handoff`.
