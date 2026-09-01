# Build Handoff - module generator manifest rules

**Spec (approved):** `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`, relevant Stage 2 sections only  
**GitHub issue:** #2169  
**Risk tier:** `sensitive` (module build/distribution and live runtime behavior)  
**Worktree:** `~/Jarv1s/.claude/worktrees/2169-module-generator-rules`  
**Branch:** `build/2169-module-generator-rules` off `origin/main` `126828bfa`  
**Build skill path:** `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`  
**Coordinator agent name:** `coordinator`  
**Coordinator session id:** `01a05bea-804f-7981-8a3e-b20b6f74cade`

## Locked scope

Fable 5 ruling: https://github.com/motioneso/moss/pull/2101#issuecomment-5491449098

- Teach guide section 11 and the module-build live-agent persona the existing tool-name prefix and
  `fetchHosts` manifest rules.
- Leave PR #2101 unchanged. This fix must land on `main` before PR #2101 is rebased again.
- Add one focused regression check for both rules. Reuse existing validators and patterns; do not
  create a second validation system.
- Plan first and send only the plan pointer to the coordinator for approval before implementation.

## Start and exit

1. Run `[ -d node_modules ] || pnpm install`.
2. Invoke `coordinated-build` and follow it end to end, including `plan-build`, TDD, and
   `coordinated-wrap-up`.
3. The lane is not done until its PR is pushed, CI/gate evidence is green, and sensitive-tier
   live-path evidence is posted. A failed proof gets reported honestly; never retry-loop.

## Standing rules

- Work only in this worktree and branch. Use explicit-path adds; never broad add or repo-wide
  formatting.
- Never touch `docs/coordination/`, project fields, milestones, or merge.
- Never run DB-touching verification outside `verify-gate`; never pipe a gate.
- All waits are event-driven. Ben's messages are trusted. Report in plain English.
- A 70% context warning triggers immediate `relay`; this slice has one relay maximum.
- Escalate through the freshly resolved registered agent `coordinator`, signing messages with your
  own pane id.

## Collision and merge order

- PR #2101 is preserved red and may share module-builder guidance/persona files. Do not edit its
  worktree or branch; #2169 lands first, then PR #2101 rebases.
- The PR #2164 sports/chat readiness lane is collision-safe and may proceed in parallel.
