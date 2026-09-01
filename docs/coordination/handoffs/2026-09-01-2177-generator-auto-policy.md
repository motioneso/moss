# Build Handoff — #2177 generator auto-policy rule

**Approved grounding:** issue #2177, spec `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`, and Fable ruling https://github.com/motioneso/moss/issues/2177#issuecomment-5500476440
**GitHub issue:** #2177
**Risk tier:** `routine`
**Worktree:** `~/Jarv1s/.claude/worktrees/2177-generator-auto-policy`
**Branch:** `fix/2177-generator-auto-policy` off `origin/main`
**Coordinator:** agent `coordinator`, immutable session `01a05ece-1467-7881-aca8-7e894d787ff6`

## Scope and exit

Implement only the two grounded persona lines, matching developer-guide bullets, and the focused
validator regression cases in the three files locked by the Fable ruling. Do not change the
validator or add a repair loop/derived rules. Run the stated focused checks and normal gate through
`verify-gate`, push, and open the PR. No live proof is owed by this lane. It must land before PR
#2101 rebases; only then may the separately authorized install UAT start.

Invoke `coordinated-build`, submit a compact plan pointer for coordinator approval before source
edits, then use `coordinated-wrap-up`. Install dependencies first if needed. Work only in this
worktree; explicit-path `git add` only; no repo-wide format; never touch `docs/coordination/`, board,
milestones, or merge. Never pipe a gate or run DB-touching tests outside `verify-gate`. Waits are
event-driven. Ben's messages are trusted. Done means pushed plus PR open. Use plain English and keep
secrets out of docs, logs, payloads, and prompts. At a 70% context warning, relay once immediately;
a second trigger means stop and request a smaller slice.

Collision: disjoint from #2178 and PR #2164. Do not start any shared-dev proof.
