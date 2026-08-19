# #1395 Settings — build lane relay 3 (2026-08-05)

Epic #1387 "UI consolidation", section 8/9. Repo `motioneso/Jarv1s`. Worktree
`.claude/worktrees/ui-1395-settings`, branch `feat/1395-ui-settings`. Coordinator pane label
"DESIGN ELEMENTS" (resolve fresh via `herdr pane list` — confirm exactly one match before
messaging; do not trust a stale pane id).

Relayed on the context-meter 70% PostToolUse warning, **before any Task 3 file edit** — this
session did investigation only, zero code changes, so there is nothing new to commit. Read
`docs/superpowers/handoffs/2026-08-05-ui-1395-settings-relay-2.md` first (superseded but has the
full Task 0-2 history + the binding Badge-tone coordinator ruling — do not re-litigate it).

## What's done (unchanged from relay-2)

Commits `aeaaccba` (Task 0), `920d508f` (Task 1), `f19d1517` (Task 2 barrel trim),
`f8d1805b`/`dea61a1d` (relay-2 doc). Barrel `apps/web/src/settings/settings-ui.tsx` currently:

```tsx
export { Avatar, Indicator, Segmented, Select, Switch } from "@jarv1s/ui";
export * from "@jarv1s/settings-ui";
```

## This session: sent coordinator a non-blocking FYI, do not re-ask

Already told the coordinator (DESIGN ELEMENTS pane) this, no reply needed, do not re-send: the
ruling's "10 `tone="pine"` sites across 7 files" count is **verified correct for literal
`tone="pine"` JSX only**, but undercounts the true rename scope needed for the build to compile.
**Corrected figure: 21 literal `"pine"` string sites across 12 files** — use 21/12 in the
commit/PR body, not 10/7. Still 100% confined to `apps/web/src/settings/`, same pine→forest
mapping, no scope creep into `packages/settings-ui`. This is additive detail on the same ruling,
not a re-opening of it — the tone mapping and CSS facts in relay-2 stand as ground truth.

**Full list of all 21 sites** (grep `"pine"` — the exact quoted token, so `solid-pine` never
matches and is never touched):

Original 7 files (from relay-2's `tone="pine"` grep, unchanged):
1. `settings-admin-panes.tsx:79` — `diagnosticTone()` helper, `return ... "pine" ...`
2. `settings-admin-panes.tsx:149,774,783,848` — JSX literal/ternary
3. `settings-ai-admin-pane.tsx:206` — JSX literal
4. `settings-appearance-pane.tsx:349,378` — JSX literal
5. `settings-module-subviews.tsx:308,467` — JSX literal
6. `settings-personal-data-panes.tsx:667` — JSX literal
7. `settings-personal-panes.tsx:197` — JSX literal
8. `settings-profile-subviews.tsx:372` — JSX literal

5 more files this session found (missed by a literal `tone="pine"` grep because they use
`tone={ternary}` / `tone={helperFn()}` / a typed pass-through field — confirmed each one actually
feeds a `<Badge tone={...}>` call, not a dead code path):
9. `settings-people-pane.tsx:372` — `tone={person.status === "active" ? "pine" : "neutral"}`
10. `settings-skills-pane.tsx:158` — `tone={skill.enabled ? "pine" : "neutral"}`
11. `settings-connector-sync.ts:5,105` — `badgeTone: "pine" | "amber" | "neutral"` field, consumed
    at `settings-admin-panes.tsx:593` (`<Badge tone={health.badgeTone} ...>`)
12. `host-health-summary.ts:31,36` — `tone: "pine" | "amber" | "red"` return field, consumed at
    `settings-admin-panes.tsx:819` (`<Badge tone={healthSummary(diag.checks).tone}>`)
13. `settings-memory-dashboard.tsx:46,51` — `itemKindTone()`/`confidenceTone()` helpers, consumed
    at `settings-memory-dashboard.tsx:449,452`

(13 numbered above but files 2 and 8 are folded into file 1's `settings-admin-panes.tsx` — actual
distinct-file count is 12, matching the corrected figure.)

**Mechanical rule for every site:** replace the string literal `"pine"` with `"forest"` — nowhere
does `"solid-pine"` appear in `apps/web/src/settings/`, so a plain string-literal rename (not a
regex touching `solid-pine`) is safe everywhere. After the rename, the barrel's `BadgeTone` type
(next section) will structurally reject any missed site at typecheck, which is a good
correctness backstop — but don't rely on it over the list above, some of these are `string`-typed
locals (`settings-connector-sync.ts`'s field, `host-health-summary.ts`'s field) that widen before
they'd ever hit the Badge prop type error at the right call site — check each by hand.

**Coordinator independently re-verified 21/12 and accepted it** (their own 10/7 had come from only
re-deriving half of a predecessor's "19 errors across 12 files" correction). Three points to fold
into the commit/PR body, verified against merged `main` before writing this doc:

1. **The pine→forest mapping is not this build's invention — it already shipped in #1390.**
   `apps/web/src/today/overnight-section.tsx:5-11` has:
   ```ts
   const FEED_BADGE_TONE: Record<FeedTone, BadgeTone> = {
     pine: "forest", amber: "amber", steel: "steel", red: "red", neutral: "neutral"
   };
   ```
   Cite this file:line in the commit/PR body — it means the mapping is a precedent already merged
   elsewhere in epic #1387, not a judgment call this lane is asking a reviewer to trust on faith.
2. **`apps/web/src/today/feed-source.ts:2`'s `FeedTone = "pine" | ...` is correctly OUT of scope
   and must not be touched.** It's domain vocabulary (Today's feed model) translated to a
   `BadgeTone` at the render boundary (the `FEED_BADGE_TONE` map above) — not a Badge prop itself.
   Don't let a blind `"pine"` grep sweep this file in.
3. **`settings-connector-sync.ts`'s `badgeTone` field and `host-health-summary.ts`'s `tone` field
   are the opposite case, and the commit body should say why explicitly** — they feed straight
   into `<Badge tone={...}>` at `settings-admin-panes.tsx:593` and `:819` respectively, so unlike
   Today's `FeedTone`, these fields *are* the Badge prop, not a separate domain concept requiring
   a translation map. Renaming `"pine"`→`"forest"` at the source field is correct here; adding a
   Today-style indirection layer would be pointless ceremony. State this contrast plainly — without
   it a reviewer sees two sections solving the same-looking problem two different ways and flags it
   as an inconsistency rather than two genuinely different shapes.

## Task 3a next concrete steps (not started — do these first)

1. **Barrel**: update `apps/web/src/settings/settings-ui.tsx` to add `Badge`, `ComingSoon` to the
   explicit `@jarv1s/ui` export list, plus `export type { BadgeTone } from "@jarv1s/ui";`. Final
   file:
   ```tsx
   export { Avatar, Badge, ComingSoon, Indicator, Segmented, Select, Switch } from "@jarv1s/ui";
   export type { BadgeTone } from "@jarv1s/ui";
   export * from "@jarv1s/settings-ui";
   ```
   (`ComingSoon` is safe to repoint alongside Badge — it only ever passes `tone="steel"`, which
   exists identically in both the local and `@jarv1s/ui` tone maps; the local file's own copy at
   `packages/settings-ui/src/index.tsx:100-121` is unaffected, per the ruling's scope trap note.)
2. **Raw-class Badge conversion**: `settings-activity-pane.tsx` is the *only* file with a raw
   `jds-badge` div/span (not already the `<Badge>` component) — lines 178, 181-183, 187. Convert
   all three to `<Badge tone="neutral">`, `<Badge tone={isDistinct(entry.outcome) ? "red" :
   "neutral"}>`, `<Badge tone="steel">`. Add `Badge` to its existing `import { Select } from
   "./settings-ui.js"` (line 8).
3. **Pine→forest rename**: all 21 sites listed above, `apps/web/src/settings/**` only.
4. `cd apps/web && npx tsc --noEmit` (direct form, true error count) → must be `EXIT=0`.
5. `grep -rn '"pine"' apps/web/src/settings/` → must be empty (confirms nothing missed; `grep
   -rn 'jds-badge"' apps/web/src/settings/` or similar for the raw-class check on
   settings-activity-pane.tsx).
6. Focused browser assertions → this IS the first visually-different step in the PR (forest tone now
   renders where pine never did). Expect a pixel delta on every settings shot with an affected
   badge — that's the **named, understood cause** the relay-2 kill-gate clarification covers, not
   a trip. Report it as such in the commit body, do not treat it as a failure.
7. Commit as its own commit (coordinator's explicit instruction — Task 3's first, most visible
   commit). PR-body framing: "10 badges that were specified with a tone and have been rendering
   untoned since the tone class never existed now render their intended forest tone. The
   pine→forest mapping is the same one #1390 already shipped for Today's feed badges
   (`overnight-section.tsx:5-11`'s `FEED_BADGE_TONE`), not a new judgment call. 21 pine→forest
   string sites across 12 files were needed to keep the build compiling once the shared
   `BadgeTone` type stopped including `pine` — 11 beyond the originally-counted 10 were reached via
   dynamic `tone={...}` expressions and typed pass-through fields, not literal `tone="pine"` JSX,
   so the visible-badge count (10) and the source-site count (21) are both correct, just counting
   different things. Two of those 12 files (`settings-connector-sync.ts`, `host-health-summary.ts`)
   rename at the source field because that field *is* the Badge prop passed straight to
   `tone={...}`, unlike Today's `FeedTone` (`feed-source.ts:2`, untouched by this PR), which is
   domain vocabulary translated to a `BadgeTone` at the render boundary — two genuinely different
   shapes, not an inconsistency."

## Task 3b–3e (not started, unchanged from relay-2's plan pointers)

Already tracked as tasks #2-#5 in this session's TaskCreate list (task tool, not GitHub) — a fresh
session won't see those; recreate or just work the plan directly:
- **3b Dialog** (4 files, 30 refs): `settings-provider-login-dialog.tsx`, `settings-feedback.tsx`,
  `terminal-modal.tsx`, `delete-account.tsx`. `Dialog.className` (layout-only, already in
  `@jarv1s/ui` per #1393) for `terminal-modal`/`deldlg` classes. Preserve `terminal-modal.tsx`'s
  `isLive` scrim-close guard (move into `onClose`) and `settings-feedback.tsx`'s
  `aria-labelledby` contract (Dialog's `title` prop needs an id-bearing node, wired via
  `aria-labelledby`, not `aria-label`).
- **3c Button** (312 refs): split 1-2 commits by pane cluster. Modifier map: `--sm`→`size="sm"`,
  `--quiet`→`variant="quiet"`, `--secondary`/`--primary`(default)/`--accentSoft`/`--danger`,
  `--active`→`active` flag (already added in Task 1, `920d508f`).
- **3d IconButton** (4 refs) + **Segmented** (2 refs, note: `Segmented` the *component* was
  already barrel-repointed in Task 2 — check whether these 2 raw-class refs are inside the
  `@jarv1s/ui` Segmented component's own render output (nothing to do) or a second, separate raw
  usage in a settings file (needs conversion) — verify before assuming either way.
- **3e Guard-6 burn-down**: 5 static inline-style props → section CSS classes; 2 swatch sites →
  `style={{["--st-swatch"]: value}}` — **`--st-swatch`, not `--swatch`** (binding coordinator
  override from relay-2, plan text is stale). Add `--st-swatch` to `check-design-tokens.ts`'s
  `allowList`, scoped to settings paths. Nothing added to `INLINE_STYLE_EXEMPT_PATHS`.

Full detail for 3b-3e: plan comment `5195260909`, read by section only (Task 3 subsection), never
front-to-back — a full read is what pushed a prior relay session to the 70% trigger with zero
commits.

## Hard constraints — unchanged, non-negotiable

No settings IA changes. `packages/settings-ui`'s router/scanner/vite/priority half untouched — only
`src/index.tsx:49-165`'s primitives half is in scope, and per the ruling, its own `BadgeTone` /
`Badge` (`:100-121`) stay `pine`-using and untouched. Nothing added to
`INLINE_STYLE_EXEMPT_PATHS`. `components-forms.css`/`command-palette.css` out of scope. No
`className` on `Card`/`Button`. `Dialog.className` is layout-only (fine to use).

## Gate discipline (unchanged)

`pnpm test:e2e` unpiped with `echo "EXIT=$?"`. Never pipe a gate command through `tail`/`grep`.
Full gate only against a freshly self-exported gate DB. Guard registration (Task 5) needs
red-before/green-after proof, two real runs.

## Shared-checkout git discipline (unchanged, and it mattered this session)

Never `git add -A`/`git add .`, never bare `git commit`. `git diff` any co-edited file before
staging; `git show --name-only HEAD` after every commit. **Before starting, re-resolve "DESIGN
ELEMENTS" fresh via `herdr pane list`/`herdr agent list` and confirm you are the only agent with
`foreground_cwd` in this worktree** — this session hit a real (since-resolved) collision with a
predecessor relay pane that hadn't been reaped yet; the coordinator confirmed reaping it and that
this session was sole owner. Don't assume that's still true by the time you read this — re-check.

## Coordinator contact

Confirmation-of-read message already sent and acknowledged this session (coordinator replied,
confirmed sole ownership, approved proceeding to Task 3). The 21/12 count-correction FYI was sent
and the coordinator independently re-verified and accepted it (their own 10/7 traced to only
re-deriving half of a predecessor's "19 errors/12 files" correction), and supplied the three
PR-body reinforcement points folded into this doc above (Today's `FEED_BADGE_TONE` precedent,
`FeedTone` out-of-scope boundary, the two `.ts` data-file rename-at-source rationale) — both
citations independently re-verified against merged `main` before this doc was written. No further
reply needed on any of this. Next contact with the coordinator should be either a real blocker or
the Task 7 wrap-up report — not another confirmation ping.

## Relay trigger note

Fired on the context-meter 70% PostToolUse warning during Task 3a investigation, before any file
edit. No compaction summary seen. All of Task 3a's investigation (barrel plan, raw-badge site,
corrected 21-site pine list with exact line numbers) is captured above so the successor builds
immediately rather than re-deriving it — re-deriving the 21-site list cost real budget this
session; don't redo that grep work, use the list as given (spot-check a couple of entries against
the live file if paranoid, but it's fresh as of this commit).
