# #1136 lane C relay handoff (relay 4 → relay 5)

Branch: `w3c-audit-truth`. Worktree: `~/Jarv1s/.claude/worktrees/w3c-audit-truth` (verify `pwd` +
`git branch --show-current` as your FIRST action; if mis-pinned, escalate — never self-recover with
EnterWorktree/ExitWorktree, that permanently bricked relay 3's tooling).

Plan: `docs/superpowers/plans/2026-08-09-1136-codex-persona-marker-fencing.md`. **PR #1484 is OPEN:**
https://github.com/motioneso/moss/pull/1484

## Done and committed

- **Task 1** — `c5a8943bc`, role-marker neutralization in `prompt-safety.ts`.
- **Task 2** — `2907a7f9f`, `codex-exec-session.ts` fencing + `tests/unit/chat-codex-exec-session.test.ts`
  (5 cases, TDD, RED observed) + prettier on Task 1's files + plan-doc verification fix.
- Both suites: **24 passed (24)**. Pre-push trio: EXIT=0. Pushed, PR opened, Coordinator informed.

## YOUR JOB — one BLOCKING defect, then wrap up

Opus adversarial QA returned **RED, merge-ready NO**. Full verdict:
https://github.com/motioneso/moss/pull/1484#issuecomment-5234482331

**ReDoS (catastrophic backtracking), `packages/chat/src/live/prompt-safety.ts` lines ~46 and ~48.**
The nested ambiguous quantifier `(?:[>\-*#]+[ \t]*)*` (and the `+` variant on the header regex)
backtracks exponentially. QA measured `neutralizeSeedFraming("-".repeat(30))` at **56,471ms** (34
dashes doesn't finish in 60s); same input on `origin/main` is 0.21ms. A 30-dash markdown horizontal
rule or email separator is ordinary content — no attacker needed — and reaches this function from
email bodies in memory. Blast radius is EVERY engine (`neutralizeSeedFraming` is the shared choke
point for `recall-seed.ts`, `chat-context-blocks.ts`, `cross-tool-reasoning.ts`,
`passive-retrieval.ts`) and it blocks the API's Node event loop.

**The fix (QA-verified, one character in each regex):** change the inner `[>\-*#]+` to `[>\-*#]` —
drop the inner `+`, keep the outer `*`/`+` so decoration repeats one char at a time. That removes the
ambiguous partitioning. QA measured the fix at 0.22ms @30 dashes, 1.46ms @20,000, and **byte-identical
output on all six of this PR's existing fixtures**.

TDD it — do NOT just apply the fix:

1. Add a regression test to `tests/unit/chat-recall-seed.test.ts` asserting a long decoration run
   completes within a time budget. **Pick the size by measuring first** — cost is ~2^n, so 30 dashes
   takes ~56s and would make RED unwatchable. ~24 dashes lands near 1s today and ~0.2ms after the
   fix, which gives a clean RED and a non-flaky GREEN against a 500–1000ms budget. (A vitest timeout
   will NOT save you: the regex blocks synchronously and cannot be interrupted.)
2. Watch it fail. Apply the one-char fix to BOTH regexes. GREEN.
3. Re-run both suites — all 24 prior cases must stay green, byte-identical behavior.
4. Commit explicit-path (`shared-checkout` skill: never `git add -A`, never bare `git commit`,
   `git diff` every line first, `git show --name-only HEAD` after). Push.
5. Reply on the QA thread / PR comment noting the fix + your measured numbers, and ask QA to
   re-verify (or at minimum post the 6 fixtures + new regression test results yourself).

## Then

Re-run the full gate (`verify-gate` skill), then `coordinated-wrap-up`, then report to the
Coordinator — **re-resolve its pane fresh via `herdr pane list`** (it was agent name
`relay6-coordinator`, but pane ids reflow constantly; never reuse one from a doc).

## In-flight state you're inheriting

- **A full gate was running when I relayed** on isolated DB `jarvis_gate_w3c_1136`, backgrounded as
  `bg3x97a94`, logging to a scratchpad `vf.log` with a `### FINAL rc=` sentinel. **That run is on
  PRE-ReDoS-fix code, so its result is stale either way — re-run after your fix.** Please
  `DROP DATABASE jarvis_gate_w3c_1136` when you're done; several stale `jarvis_gate_*` DBs are
  already littering the dev Postgres.
- 6 NON-blocking QA findings (Unicode/homoglyph bypass, role words outside the alternation like
  `Developer:`/`Tool:`/`Moss:`, an inaccurate comment at `prompt-safety.ts:38-40`, YAML/markdown
  corruption on recalled code snippets). Your call: follow-up issues or inline. They do NOT block
  merge — don't let them expand this PR.

## Traps already paid for — don't re-hit

- **`pnpm --filter @moss/chat test -- <names>` is a FALSE GREEN.** Workspace packages declare no
  `test` script, so pnpm exits 0 having run ZERO tests and writes a 0-byte log. The plan doc
  originally specified it; corrected in this PR. Use
  `pnpm vitest run tests/unit/<file>.test.ts > <log> 2>&1; echo "EXIT=$?"`. **EXIT=0 with an empty
  log is never proof of green — confirm a `Tests N passed` line.**
- A repo hook BLOCKS piped verification commands. Always `cmd > logfile 2>&1; echo "EXIT=$?"`, read
  the log separately. To redirect a chained trio, wrap it: `{ a && b && c; } > log 2>&1`.
- `git commit <path>` fails on an UNTRACKED file — `git add <explicit path>` it first (never `-A`).
- Relay trigger is the context meter's **70%** warning. Don't invent a higher threshold and don't
  finish "just one more thing" past it — that rule is why this doc exists instead of a botched fix.
