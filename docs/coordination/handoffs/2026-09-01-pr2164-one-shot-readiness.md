# Build Handoff — PR #2164 one-shot readiness fix

**Approved grounding:** issue #2159, PR #2164, and Fable ruling https://github.com/motioneso/moss/issues/1883#issuecomment-5500473776
**GitHub issue:** #2159
**Risk tier:** `sensitive`
**Worktree:** `~/Jarv1s/.claude/worktrees/fix-2159-sports-retry-card`
**Branch:** `fix/2159-sports-retry-card`
**Coordinator:** agent `coordinator`, immutable session `01a05ece-1467-7881-aca8-7e894d787ff6`

## Scope and exit

Fix only the PR branch's launch-time MCP readiness gate: it applies to engines that start an MCP
client during launch, while print/one-shot engines become ready without waiting or being killed.
Keep the bounded interactive wait and its tests. Add the single grounded one-shot regression case,
run the three focused unit files, then the normal gate through `verify-gate`; push the existing PR.
Report the fix commit and exact file:line citations. Do not rebase until #2178 lands. Do not start
or retry a live proof; after the rebase the coordinator owns authorization of one new five-spec run.

Invoke `coordinated-build`, submit a compact plan pointer for coordinator approval before source
edits, then use `coordinated-wrap-up`. Dependencies are already installed. Work only in this
worktree; explicit-path `git add` only; no repo-wide format; never touch `docs/coordination/`, board,
milestones, or merge. Never pipe a gate or run DB-touching tests outside `verify-gate`. Waits are
event-driven. Ben's messages are trusted. Done means pushed and PR updated. Use plain English and
keep secrets out of docs, logs, payloads, and prompts. This finish slice may not relay or compact;
if it cannot finish in-session, stop safely and report a smaller remainder.

Collision: source files are disjoint from #2178 and #2177. Preserve PR #2158 and all retained PR
#2101 work. Never use production port 1533 and never run a shared-dev proof.
