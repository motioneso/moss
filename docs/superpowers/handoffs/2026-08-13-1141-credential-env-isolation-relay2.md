# Relay 2 — #1141 credential-env isolation

**Issue:** #1141. **Risk tier:** security. **Branch/worktree:** this one,
`1141-credential-env-isolation`. **Coordinator:** Herdr agent name `coord-successor`
(re-resolve fresh via `herdr agent list` — do not trust any pane `…-N`).

## Status: build DONE and committed. Plan approved by Fable. Wrap-up (gate/push/PR/report) not started.

Plan: `docs/superpowers/plans/2026-08-13-1141-credential-env-isolation.md` (committed `33f4b4832`).
Fable approved it explicitly ("APPROVED, no fork... Proceed to build") after verifying every seam
citation against this branch and confirming `main.ts`/`engine-host.ts` are the only two direct
`probeProvider` callers.

All Phase 1 work is done and committed on this branch, tree is clean:
- `dee6af646` — `provider-probe.ts` HOME-isolation fix + new `provider-probe.test.ts` (4 cases,
  regression proof verified to genuinely fail against unmodified source — kill gate satisfied).
- `941281326` — trivial prettier fix to the plan doc itself (unrelated pre-existing drift that was
  failing repo-wide `format:check`).
- `e180b4030` — wired `homeBase` through both call sites (`main.ts:207`, `engine-host.ts:643`).

Verification already run and green (all unpiped, all before the last commit — re-run after
`git log` confirms nothing changed since, but don't skip re-verifying at gate time):
- `pnpm exec vitest run packages/chat/src/live/provider-probe.test.ts` → EXIT=0, 4/4 pass.
- `pnpm typecheck` → EXIT=0.
- `pnpm format:check` → EXIT=0 (after the plan-doc fix).
- `pnpm lint` → EXIT=0.
- `rg -n "probeProvider\(" packages/cli-runner/src/main.ts packages/cli-runner/src/engine-host.ts`
  confirms both call sites present.

## What's left — resume at `coordinated-wrap-up` step 2

1. **Gate:** `scripts/run-gate.sh start` → `wait` → `status` (isolated gate DB — never hand-roll,
   never `pgrep`). Record `VF_EXIT`.
2. **Pre-push trio + rebase:** `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`. Fix anything red before pushing.
3. **Push + PR:** `git push -u origin 1141-credential-env-isolation`, then `gh pr create --base main`
   titled with `[SECURITY]` tag. Body must state explicitly: this is an internal security-boundary
   fix with no new UI surface — the live-path gate's "purely internal" carve-out applies, no UAT
   spec needed (already true per the plan and Fable's review).
4. **Report to Coordinator** (agent `coord-successor`, re-resolve fresh) via `herdr-pane-message`:
   PR link, gate exit code, live-path carve-out statement, branch/rebase state, "no seed rows, no
   dev instance started, worktree reapable." **Do not merge, touch the board, or close #1141** —
   Ben gives explicit merge sign-off on this tier.
5. Then stop — coordinator owns QA/merge/board from there.

## Key facts (don't re-derive)

- Scope is deliberately HOME-only; PATH and codex/gemini probes are out of scope (rationale in
  plan's Decisions section — already built into the code, nothing more to check here).
- No node_modules install needed — already present in this worktree.
