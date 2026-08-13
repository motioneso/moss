# #1274 external-module trust lint — relay

Worktree/branch: `.claude/worktrees/1274-external-module-trust-lint`, branch
`1274-external-module-trust-lint`. Security-tier lane, plan already approved by coordinator.
Coordinator label: `Coordinator` (confirm via `herdr pane list` before messaging — never trust a
baked-in pane number).

Plan: `docs/superpowers/plans/2026-08-13-1274-external-module-trust-lint.md`.

## Done (all commits green, all pushed to local branch only — not yet pushed to origin)

- `d1f7cb488` — `@moss/ai` exposes `./gateway/input-validation` subpath export.
- `287631af9` — Task 2: `lintToolInputSchemaPatterns` walker added to `validate.ts` (later
  extracted, see below).
- `1022587b8` — 4 new unit tests in `tests/unit/external-validate.test.ts`, plus the
  `vitest.config.ts` alias fix (subpath alias must precede the bare `@moss/ai` alias — same
  pattern as `host-fetch/policy`, `module-registry/node`).
- `e7d880b79` — committed the previously-untracked plan doc.
- `169aa36eb` (this segment) — fixed `check:file-size` gate failure: extracted the walker into new
  sibling file `packages/module-registry/src/external/input-schema-lint.ts`, exported as
  `lintAssistantToolInputSchema(tool, errors)` (small wrapper hides the path-formatting so the
  call site in `validate.ts` fits on one line). `validate.ts` is now 999 lines (was 1043; cap is
  1000, comparison is strictly `>`). Import uses explicit `.js` extension
  (`./input-schema-lint.js`) — this repo's `nodenext` moduleResolution requires it; the first
  typecheck attempt without it failed with TS2835, now fixed.

**Verified this segment, all green:**
- `pnpm exec tsx scripts/check-file-size.ts` → "No checked files exceed 1000 lines."
- `pnpm exec eslint <the 2 touched files>` → clean.
- `pnpm typecheck` (full, background+sentinel) → rc=0.
- `pnpm exec vitest run tests/unit/external-validate.test.ts` → 33/33 pass.
- `pnpm lint` (full) → rc=0.
- `pnpm format:check` (full) → rc=0.

Isolated gate DB `jarvis_gate_1274trustlint` was DROP+CREATEd fresh this segment (empty, ready) —
`export JARVIS_PGDATABASE=jarvis_gate_1274trustlint` before using it.

## Not yet done — resume here

1. **Re-run the full isolated-DB gate** (`verify-gate` skill procedure — DROP+CREATE the gate DB
   again if any time has passed, since a prior run's migration state can carry over):
   ```bash
   GATEDB=jarvis_gate_1274trustlint
   docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS $GATEDB;"
   docker exec jarv1s-postgres psql -U postgres -c "CREATE DATABASE $GATEDB;"
   export JARVIS_PGDATABASE=$GATEDB
   ( pnpm verify:foundation > /tmp/1274-gate.log 2>&1; echo "### FINAL rc=$?" >> /tmp/1274-gate.log ) &
   ```
   Watch via Monitor with an until-loop on `### FINAL` in the log, never poll in-context. All of
   `format:check`/`lint`/`typecheck`/`check:file-size` are already independently verified green
   this segment — this full run should mainly confirm `test:unit`, `db:migrate`, `test:uat-seed`,
   `test:integration`. Check `herdr pane list` first per `shared-checkout` (stagger with other live
   gate runs against the shared dev Postgres container).
   Drop the gate DB when done: `docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE $GATEDB;"`.
2. **Rebase check** immediately before push (other lanes are actively landing):
   `git fetch origin main && git rebase origin/main`.
3. **Push** the branch, open a PR **tagged `[SECURITY]`**.
4. **Live-path gate does NOT apply** — the plan's own Determinism/scope note states this is pure
   backend/install-time validation with no UI surface. State that explicitly and deliberately in
   the PR body (not as a shortfall — as a scoped-out gate).
5. **Report to the coordinator**: PR link, which gate was verified (local `verify:foundation`,
   note `test:e2e` is excluded per the skill), and the live-path-gate-does-not-apply framing.
   **Never merge, move the board, or close #1274 yourself** — that's the coordinator's job.

## Key facts for the successor

- `validate.ts` was already at 997/1000 lines *before* this lane touched it — near-zero margin.
  If any future task on this file adds even a few lines, expect the file-size gate to trip again;
  the fix pattern (extract to a sibling file with a narrow exported entry point) is the established
  precedent to reuse, not `exemptFiles` (rejected as an unprincipled bypass — none of the 5
  existing exemptions apply to this file's situation).
- `input-schema-lint.ts` is brand new, single-purpose, not otherwise referenced anywhere except
  `validate.ts`'s one import — confirmed via repo-wide grep before the refactor.
