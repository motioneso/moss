# Handoff — opus-1013-reconcile-v5 → v6

Pointer brief. **Read `<scratchpad>/STATE.md` first** — it is the live state doc and outranks this
file if they disagree.

Scratchpad:
`/tmp/claude-1000/-home-ben-Jarv1s--claude-worktrees-coord-overnight-20260810--claude-worktrees-build-1013-ddl-lock/34c87fd7-0561-4dd4-8cd7-8e71c9e5be6d/scratchpad`

Original task brief: `~/Jarv1s/.claude/handoff-1013-phase3-relay.md` — still binding, read it.

## Boundaries (verbatim, still in force)

- Phase 1 kill gate is the **Coordinator's**. Escalate, never self-adjudicate. (Now RESOLVED: PASS.)
- **Never merge.** Security tier needs Coordinator + Ben explicit sign-off.
- Never move the board, close the issue, or close the milestone.
- `docs/coordination/post1632-queue-2026-08-16.md` is **coordinator-only**: read, never edit.
- No `pnpm verify:foundation` or any DB-touching test command without the **`verify-gate` skill**.
- Never pipe a verification command. Log to a file with a sentinel; read the exit code from the log.
- Shared checkout: explicit paths only, `git diff` each file first, `git show --name-only HEAD`
  after. Never `git add -A`/`.`, never bare `git commit`, never `checkout`/`stash`/`reset`.
- Run the two gates **sequentially, never concurrently** — cross-lane interference is exactly what
  Phase 1 spent two rounds ruling out.

## Worktrees

- **This one:** `~/Jarv1s/.claude/worktrees/coord-overnight-20260810/.claude/worktrees/build-1013-ddl-lock`,
  branch `build-1013-ddl-lock`, HEAD `3d16cb57a`, tree clean, **nothing pushed**. Origin is stale at
  `8bc7cd112` → push needs `--force-with-lease`.
- **#1637:** `~/Jarv1s/.claude/worktrees/fix-1013-lock-domain`, branch
  `fix-1013-lock-domain-env-consistency`, HEAD `755e1aa2a`, tree clean.

## Done

- **Phase 3(a)** test-surface routing guard — `b5b608696`
- **Phase 3(b)** D2 attribution + T3 negative control in `scripts/prove-cluster-ddl-lock.ts` — same
  commit, wording fix in `3d16cb57a`
- **Phase 3(c) P1′** — all green, unpiped, exit codes recorded, logs at `<scratchpad>/p1p-*.log`:
  solo N=30 EXIT=0; owner-loss EXIT=0; cross-db N=30 EXIT=0 (60 locked sections, **zero overlap**,
  0 lane errors, 341 samples / 53 backends); T3 demo EXIT=0 (writer captured in 49 samples, all 49
  classified external); guard `--external-writer-demo --mode=solo` EXIT=1, refuses.
  **Honest limitation to carry into every report:** the demo writer never collided, so 0 lane errors
  occurred and the _attribution_ path was not exercised — only observer liveness. The harness prints
  exactly that; do not upgrade the claim.
- **Phase 3(d)** spec amendment — `3d16cb57a`
- **Phase 1** — Coordinator's tiebreaker gate returned **PASS** (XX000 = 0 in both lanes). All other
  failures explained as fixed-module-id role collisions.
- **#1638 filed** (label `task`) + comments on `#1625` (`5306546638`) and `#1638` (`5306649336`).

## In flight / next

1. **T1 — #1637 gate + PR.** Gate launched at `755e1aa2a` with `JARVIS_PGDATABASE=jarvis_gate_1637fix`
   via `<scratchpad>/gate-1637.sh` → `<scratchpad>/gate-1637.log`, sentinel `### FINAL rc=`.
   On green: file the PR with `<scratchpad>/pr-1637-body.md` (paste the recorded exit code in),
   `DROP DATABASE jarvis_gate_1637fix`, report to the Coordinator.
2. **T6 — Phase 3(e) `coordinated-wrap-up`** for `build-1013-ddl-lock`: own gate via `verify-gate`
   (fresh separate gate DB), pre-push trio + fresh rebase, push `--force-with-lease`, PR against
   #1013, report. Starts only after T1's gate has exited.
3. **Tell the Coordinator** that `finance` belongs in **#1638**, not folded into #1625 — the
   Coordinator's tiebreaker message assumed otherwise. `tests/integration/finance-tables-install.test.ts:15`
   pins `const moduleId = "finance"`, a real `external-modules/` id, so #1625's
   derive-the-fixture-id-from-lane fix cannot apply without changing what is under test. Evidence is
   already on #1638; the Coordinator has not been told directly.

## Routing

Coordinator pane `w1:pC1` (label `Coordinator`) — **re-resolve from `herdr agent list` / `pane list`
every time**, pane ids reflow. Use the `herdr-pane-message` skill. A relay to a successor
coordinator was in progress at last contact, so the label may outlive the session behind it: confirm
`agent_session.value` before anything destructive.
