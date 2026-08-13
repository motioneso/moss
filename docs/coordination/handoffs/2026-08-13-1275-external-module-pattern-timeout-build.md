# Build Handoff — 1275-external-module-pattern-timeout

**GitHub issue:** #1275 — external-module `inputSchema.pattern` compiles/matches unconfined on
the host API event loop. Part of #1262. No separate spec doc — scoped fix, build off the issue
text below. `gh issue view 1275` first for the full context (already summarized here).

**Risk tier:** `security` (label on the issue; matches the CLAUDE.md trigger table —
network-exposed surface, external-module trust boundary). Opus adversarial QA + mandatory `gh pr
comment` verdict + merge sign-off (Fable is this run's sign-off delegate — see agentmemory
`fable-signoff-delegation-waves-3-6`; not Ben directly this run).

**Model:** Codex, `gpt-5.6-luna`, `model_reasoning_effort=high` (Ben's explicit directive this
run — see manifest 2026-08-13 entry).

**Context — related work just merged:** #1274 (external-module `inputSchema` pattern **install-time
lint**) merged as PR #1605, commit `0c185619`, just before this branch was cut. #1274 is about
*rejecting* overly-complex patterns at install; #1275 is about *confining execution* of whatever
patterns pass that lint (defense in depth — a pattern that's complex-but-not-rejected could still
be slow, and the lint itself is heuristic). Read `packages/module-registry/src/*` for whatever
#1274 added (lint rules, any shared complexity-scoring helper) — reuse it if it helps, but #1275's
ask is orthogonal: bound *compile/match time or isolate it*, not re-do the install-time reject.

**Ask (from the issue, "Confine external-module `inputSchema.pattern` compilation/matching the
same way `execute` already is"):** pick one:
- Compile/match with a bounded timeout (kill a catastrophic-backtracking match before it can pin
  the event loop for more than e.g. a few ms/tens of ms).
- Run pattern compilation/matching inside the same Worker sandbox `execute` already uses
  (`packages/module-registry/src/external/worker-runtime.ts`) — reuses an existing isolation
  boundary rather than inventing a new one.
Pick whichever is proven simplest against a real ReDoS-pattern reproduction test; do not build
both. This only applies to **external** (third-party) modules — built-in module patterns are
trusted code already, same as the rest of the manifest; do not add overhead to the built-in path.

**Scope:** `packages/ai/src/gateway/input-validation.ts` (the `compilePattern`/pattern-matching
call site), `packages/module-registry/src/external/worker-runtime.ts` (if the Worker-sandbox
direction is chosen).

**Worktree:** `.claude/worktrees/1275-external-module-pattern-timeout`
**Branch:** `1275-external-module-pattern-timeout` (off `origin/main` @ `0c185619`)
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list`.
**Coordinator session id:** `caef4e32-df22-4310-a42d-866771a0ba6c`
**Plan reviewer:** none required to wait on — write a short plan per `plan-build`, self-approve
against this handoff's locked ask, proceed. If a genuine design fork comes up (e.g. timeout value
choice, or the Worker-sandbox route turns out to need API changes beyond what's described here),
message the Coordinator and wait rather than guessing — this is a security-tier lane.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. `gh issue view 1275` for full issue context (already summarized above).
3. Read `packages/ai/src/gateway/input-validation.ts` in full — understand `compilePattern`, the
   `patternCache`, and every call site (built-in and external module tool invocations both flow
   through here today — you need to distinguish them, not slow down the built-in path).
4. Write a reproduction test: a catastrophic-backtracking regex pattern (classic ReDoS shape, e.g.
   `(a+)+$` against a crafted non-matching input) installed as an external module's
   `inputSchema.pattern`, proving it currently blocks the host event loop for a long time
   (measure via `perf_hooks.monitorEventLoopDelay()` or wall-clock on the match call — must be a
   deterministic, CI-safe assertion, not a flaky timing-based one held together by hope).
5. TDD build the fix (bounded timeout, or Worker-sandbox routing — pick per the Ask above),
   commit per step, follow `coordinated-build`/`coordinated-wrap-up`.

## Exit criteria

- Reproduction test: red on current `main` (unconfined pattern match blocks the loop), green after
  the fix (match is either killed within a bounded timeout or isolated in the Worker sandbox and
  can't affect the host loop).
- Built-in module tool calls unaffected — no measurable regression to their pattern-match latency
  or behavior; existing `input-validation` test suite green.
- Full gate green on an isolated gate DB (`verify-gate` skill).
- PR open, rebased on `origin/main`, tagged `[SECURITY]`.
- Live-path proof: install an external module with a deliberately pathological (but non-destructive)
  pattern on live dev, invoke its tool, show the host process stays responsive (screenshot/log
  excerpt on the PR) — per the Live-Path Gate, this binds even at security tier since it's a
  host-process-availability property, not just a unit-test property.

## Run-specific bans

- Work only in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, or merge anything yourself.
- No secrets (real or placeholder-looking) in any doc, payload, log, or prompt.
- Do not modify #1274's install-time lint logic — this is a separate, additive runtime guard.

## Collision notes

- `packages/module-registry/src/external/worker-runtime.ts` — PR #1606 (#1248, vault ingestion,
  mid-rework) touches `packages/module-registry/src/index.ts` per its QA verdict, a different file
  in the same package. No direct overlap identified; rebase onto latest `origin/main` right before
  opening your PR.
- #1274 (PR #1605) just merged touching `packages/module-registry/src/*` for its install-time
  lint — your branch is already cut from that commit, so no rebase needed for this specifically.
