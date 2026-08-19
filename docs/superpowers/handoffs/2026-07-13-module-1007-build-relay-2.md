# Relay 2 — module-persist-1006 build (#1007 fix + Stage 2 UAT), mid-Task-4

Worktree: `/home/ben/Jarv1s/.claude/worktrees/module-persist-1006`, branch `module-persist-1006`.
`node_modules` present — **skip `pnpm install`**. Coordinator label: `Coordinator` (re-resolve
fresh via `herdr pane list`, never reuse a cached `…-N`). Skill: `coordinated-build`. Tier:
**security**.

## Plan (APPROVED — do not re-litigate)

`docs/superpowers/plans/2026-07-12-module-1007-enoent-guard-and-uat-proof.md` — 6 tasks. Read by
SECTION for the task you resume, not front-to-back. You already have Tasks 1-3 context from this
doc; re-read Task 4 (line ~201) in full since you're mid-write, then Tasks 5-6 when you get there.

## Done (committed)

- Task 1: ENOENT guard — `ab35d05e`.
- Task 2: full gate green (`pnpm verify:foundation` exit 0: lint/format/file-size/design-tokens/
  ambient-dates/package-deps/typecheck/3171 unit/1635 integration). Had to prettier-format the
  plan doc itself first (`c08c13a2`, pure whitespace, not `docs/coordination/`, safe).
- Task 3: isolated stack **`jarvis-uat-1006` is UP and healthy** on `http://localhost:1545`, built
  from this worktree (not `:edge` — image tag `uat-1006`). Own env file (plan's cited devproof env
  file is a *different* stack/port — do not reuse it, it's 1544 not 1545):
  `/tmp/claude-1000/-home-ben-Jarv1s--claude-worktrees-module-persist-1006/9ed81faa-7b82-45d5-98e4-3da7f0637430/scratchpad/uat-1006/env.uat-1006`
  — port 1545, subnet `10.255.0.0/24` (devproof-999 uses `10.253.0.0/24`, prod uses default
  `10.251.0.0/24` — no collision). **Trap avoided:** compose's `env_file: path:
  ${JARVIS_ENV_FILE:-...}` resolves relative to `infra/`, so the env file must also set
  `JARVIS_ENV_FILE=<absolute path to itself>` for interpolation — already done, confirmed working.
  **Plan drift note:** plan Step 2 says confirm mount `/app/data` — that string doesn't exist in
  current compose; the real persistent-volume mount is `/data/modules` (compose's `environment:`
  block hardcodes `JARVIS_MODULES_DIR: /data/modules` for the `jarv1s` service, overriding
  env_file). Confirmed present via `docker inspect jarvis-uat-1006-jarv1s-1`. Note this drift in
  the final report; not a blocker, invariant (module data on named volume) holds.
- Nothing else uncommitted. `git status --short` should show only pre-existing
  `.claude/context-meter.log`.

## Next steps (in order)

1. **Finish Task 4** (plan line ~201): write `scripts/uat/job-search-install.spec.ts` exactly per
   plan Step 2 (script body is fully written out in the plan doc — copy it, but keep assertion/log
   artifacts in the Coordinator's own scratchpad
   (`.../coord-2026-06-30-rfa-fleet/58a78927.../scratchpad/devproof`). Before trusting the plan's
   inlined selectors verbatim, spot-check
   against the live stack at `:1545` (owner signup not yet done there) — the plan says these were
   "confirmed by reading the source this session" by your predecessor, should still be accurate
   since no settings/auth code changed, but Playwright selector mismatches are cheap to catch by
   running Step 3 immediately after writing.
2. Step 3: run it (`UAT_BASE_URL=http://localhost:1545 pnpm dlx tsx
   scripts/uat/job-search-install.spec.ts run`), expect `RUN OK needsRestart=true` and confirm all
   DOM/API assertions pass.
3. Step 4: commit `scripts/uat/job-search-install.spec.ts` alone.
4. Task 5 (plan line ~405): restart stack, resume-mode script run, then `--force-recreate` +
   resume-mode run again — this is the actual #1006/#1007 persistence proof. Use **my** env file
   above, not the plan's literal devproof path.
5. Task 6: pre-push trio (`format:check && lint && typecheck`) + `git fetch origin main && git
   rebase origin/main`, then `coordinated-wrap-up` (push, PR, report to Coordinator — include the
   Task 3 `/data/modules` drift note in the report).
6. Self-monitor context; relay again on 70% warning or compaction summary.

## Escalation

Message `Coordinator` (fresh-resolved) once your successor is confirmed driving: "relayed to
<successor pane/label>, safe to reap me." It kills this session's pane.
