# Build Handoff — #2178 scripted tools flag

**Approved grounding:** issue #2178 and Fable ruling https://github.com/motioneso/moss/issues/1883#issuecomment-5500473776
**GitHub issue:** #2178
**Risk tier:** `routine`
**Worktree:** `~/Jarv1s/.claude/worktrees/2178-scripted-tools-flag`
**Branch:** `fix/2178-scripted-tools-flag` off `origin/main`
**Coordinator:** agent `coordinator`, immutable session `01a05ece-1467-7881-aca8-7e894d787ff6`

## Scope and exit

Touch only `tests/uat/fixtures/scripted-provider/launch-args.ts` and its test. Accept the real
read-only launch command's MCP trio plus a non-empty `--tools` value, preserving every other
rejection. Add the one grounded contract test, run the focused check and normal gate through
`verify-gate`, push, and open the PR. No live proof is owed by this fixture-only lane. It must land
before PR #2164 rebases.

Invoke `coordinated-build`, submit a compact plan pointer for coordinator approval before source
edits, then use `coordinated-wrap-up`. Install dependencies first if needed. Work only in this
worktree; explicit-path `git add` only; no repo-wide format; never touch `docs/coordination/`, board,
milestones, or merge. Never pipe a gate or run DB-touching tests outside `verify-gate`. Waits are
event-driven. Ben's messages are trusted. Done means pushed plus PR open. Use plain English and keep
secrets out of docs, logs, payloads, and prompts. At a 70% context warning, relay once immediately;
a second trigger means stop and request a smaller slice.

Collision: disjoint from PR #2164 and #2177. Do not start any shared-dev proof.
