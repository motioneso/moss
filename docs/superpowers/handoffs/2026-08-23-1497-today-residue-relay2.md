# Relay: #1497 / #1427-A — Today CSS residue (relay 2)

Worktree: `~/Jarv1s/.claude/worktrees/1497-today-residue`, branch `build/1497-today-residue`.
Commit `62ea1f830` on this branch adds the plan. No source (CSS/TS) edits made yet.

## Where this stands

Plan is written and committed:
`docs/superpowers/plans/2026-08-23-1497-today-css-residue.md`. It re-verified the 152-violation
baseline directly against the guard's own `checkBannedProperties` export (matches what the prior
session already recorded on issue #1497 — no drift) and lists every selector/property move with
exact line numbers pulled from that same tool call, not hand-read from the CSS (a first hand-count
attempt was short by 10 — the tool call is the only trustworthy source; if you need to re-verify,
write a throwaway `.mjs` importing `checkBannedProperties` from
`scripts/check-design-tokens.ts` and pass the three file paths as the second argument — see the
plan's baseline section for the exact snippet shape).

**Plan approval message was sent to the coordinator** via
`herdr agent prompt coordinator "Plan ready for #1497 / #1427-A..."` and confirmed landed (the
coordinator pane showed it reading the plan file, "Newspapering..."). **No reply has been received
yet as of this relay** — this session hit the context-meter 70% warning right after sending it and
is relaying per the coordinated-build gate, not because of any blocker.

## Next concrete step for whoever picks this up

1. Re-resolve the coordinator by name (`herdr agent list`) and check whether it has replied
   (`herdr pane read <coordinator-pane> --source recent --lines 30`, or just prompt it "any word on
   the #1497 plan?" if unclear). Do NOT re-send the plan-ready message — it already landed.
2. If approved: proceed straight into `coordinated-build` step 2 (Build) — execute the plan's five
   tasks with `superpowers:test-driven-development`, committing per task. The plan cites exact line
   numbers for every declaration to move; no further re-reading of the CSS files is needed to start
   Task 1.
3. If the coordinator flags a fork or asks a question: answer from the plan/seams-check content
   already there (baseline, cascade-order, the two `font: inherit` couplings) before escalating
   further — most likely questions are already answered in the plan's Seams Check and Kill Gate
   sections.
4. After build: `coordinated-wrap-up` — gate via `verify-gate` skill (never bare), UAT spec +
   `uat-trigger-map.tsv` row per the plan's Task 5, PR with live-path proof, report to coordinator.
   Do not merge, touch the board, or touch `docs/coordination/`.

## Skip

- `pnpm install` — `node_modules` already present in this worktree.
- Re-reading the CSS files in full — the plan's Tasks 1-3 already cite every line number needed.
