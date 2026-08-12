# Build Handoff — fix-1452-safe-seed

**GitHub issue:** #1452 — briefing content strings have no live-path proof (#1441/PR #1450 walked
only the empty frame: `Today page headings: ["ALL CLEARTODAY"]`). Part of #1440.
**Risk tier:** `routine` (test-infra only — a UAT spec addition, no product code path change).
**Worktree:** /home/ben/Jarv1s/.claude/worktrees/coord-overnight-20260810/.claude/worktrees/fix-1452-safe-seed
(corrected 2026-08-12 — originally created nested by a coordinator path error; the sibling-level
path `/home/ben/Jarv1s/.claude/worktrees/fix-1452-safe-seed` this doc used to state is a plain,
non-worktree decoy directory, not this lane. Successor `fix-1452-safe-seed-relay2` is already
driving in the nested path above — treat it as authoritative, do not relocate.)
**Branch:** fix-1452-safe-seed (off origin/main, includes #1256's merged confirmation-registry fix)
**Build skill path (absolute):** /home/ben/Jarv1s/.claude/worktrees/coord-overnight-20260810/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; verify `herdr pane list`
shows exactly one pane with this label before messaging (resolve fresh, never a cached pane id).
**Coordinator session id:** `0bb9f516-c026-454f-bc97-dc9faf43bd20`
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Design decision (already made — do not re-litigate)

Ben chose the approach on 2026-08-12 (posted at
https://github.com/motioneso/moss/issues/1452#issuecomment-5273554969): a **UAT spec that triggers
a real briefing generation for a throwaway account, waits for the row to appear, then cleans up
after itself.** Rejected: dedicated non-shared instance, insert-by-recorded-id fixtures. This is
your spec for design-fork purposes — build to it, don't re-open the 3-way choice.

## What #1452 requires (read the issue in full before planning — it's short)

1. A UAT spec that: creates/uses a throwaway account, triggers real briefing generation (the actual
   worker path — not a fixture insert), polls/waits for the generated row to land, exercises a live
   walk of the Today page with that row present, then removes what it created — leaving the shared
   dev DB exactly as it found it. No destructive seed/reset of the shared database.
2. Live walk must show at least one briefing card **rendered** (not the empty `ALL CLEARTODAY`
   frame), with a screenshot, confirming zero occurrences of the old product name in the rendered
   content (mirrors the #1441/#1450 rename check, now proven against real content not just unit
   tests).

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read #1452's full issue body (`gh issue view 1452`) and its two comments (the design decision
   above, plus any further Ben commentary) before planning.
3. Invoke **`coordinated-build`**: plan with **`plan-build`** → coordinator approval (do NOT write
   code first) → TDD build → **`coordinated-wrap-up`** (PR + live-path proof + report).

## Exit criteria

- UAT spec exists, triggers real generation, waits for the row, walks Today live, cleans up after
  itself. Full gate green on an isolated gate DB.
- PR open, rebased on `origin/main`.
- Live-path proof posted (`gh pr comment`): screenshot of a rendered briefing card, plus
  confirmation the shared dev DB was left as found (e.g. row count before/after, or an explicit
  teardown step in the spec run log).

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path only.
- Never touch `docs/coordination/`, the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.
- **Never seed/reset the shared dev database destructively.** This is the entire point of #1452 —
  any approach that requires a destructive reset is out of scope, full stop.

## Collision notes

- None known. Adjacent to #1429 (`fix-1429-briefing-css`, same `briefing-action-rows.tsx` file,
  currently in gate) — if your UAT spec locates elements in that file, expect its CSS classes to
  exist by the time you write assertions against them (check whether #1429 has merged; if not yet,
  don't hard-block on its exact class names, describe elements more durably e.g. by role/text).
