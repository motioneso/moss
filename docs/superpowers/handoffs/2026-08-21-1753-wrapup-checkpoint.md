# 1753 draft-module-author-only — wrap-up checkpoint

Branch `1753-draft-module-author-only`. Tasks 8, 9, 10 of the plan are done and committed:
- `8f994f2d1` Task 8 (API resolver hides drafts from non-owners)
- `01a410390` Task 9 (worker gate treats a draft as always enabled)
- (Task 10 + migration renumber) `6e83c0c9f` fix: renumber 0185/0186 to 0187/0188 (collided
  with #1524 on main), wire ship route into route-coverage allowlist, add 4 ship-route tests
- `03803167a` style: prettier fix on the 5 files the gate's format:check flagged

Rebased cleanly onto latest `origin/main` already. Full `pnpm typecheck` is clean.

## What's left: coordinated wrap-up

Doing the `verify-gate` skill's flow by hand (GATEDB `jarvis_gate_1753draft`, exported via
`JARVIS_PGDATABASE`, never inline).

1. First gate run: format:check failed (fixed, committed as `03803167a`).
2. Second gate run: `pnpm lint` through `pnpm typecheck`/`build:app-map` all green.
   `test:unit` failed on `tests/unit/mcp-gateway-validation.test.ts` only — this is a **known
   local-only flaky failure**, not caused by this branch. Confirmed via the
   `module-sdk-worker-tests-fail-locally-green-in-ci` memory note: same test family
   (CPU-budget/ReDoS-guard tests), box-load-dependent, always green in CI. Verified this
   branch touches neither `packages/ai/` nor `packages/module-sdk/`
   (`git diff --name-only origin/main...HEAD`), and the latest main CI run
   (32454852251) is green. So: box, not branch — do not bisect this.
3. Because `verify:foundation` chains with `&&`, that stopped `db:migrate` / `test:uat-seed` /
   `test:integration` from running as part of the same command. Currently running those three
   by hand in the background against the same `GATEDB=jarvis_gate_1753draft`:
   `pnpm db:migrate && pnpm test:uat-seed && pnpm test:integration`, log at `/tmp/vf_rest.log`,
   sentinel line `### FINAL rc=`.

## Next steps (in order)

1. Check `/tmp/vf_rest.log` for `### FINAL rc=`. If `rc=0`, the full gate is effectively green
   (lint/format/checks/typecheck/build:app-map all passed on run 2; test:unit's only failure is
   the confirmed box issue; db:migrate/test:uat-seed/test:integration passed on this run). If
   nonzero, read the log and fix — don't assume it's the same known issue unless the failing
   test names match the module-sdk-worker/mcp-gateway-validation/external-module-invocation-budget
   family.
2. `docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS jarvis_gate_1753draft;"`
   to clean up the gate database.
3. Open the PR: base `main`, head `1753-draft-module-author-only`, title referencing #1753.
   Body should say plainly that `test:unit` had one file's failures that are a confirmed
   local-only box issue (link the reasoning above), not a gate the branch itself failed, and
   that everything else (lint, format, file-size/design-token/ui-class/migrated-sections/
   ui-catalogue/ambient-date/package-dep checks, typecheck, build:app-map, db:migrate,
   test:uat-seed, test:integration) passed locally. Note the dependency on #1754 if that issue
   is still open (check `gh issue view 1754 --repo motioneso/moss`).
4. Fill in the PR template's Release note section. Check the plan doc under
   `docs/superpowers/specs/` (or ask what Group D does) to decide Category — likely `N/A` since
   this PR only wires backend/API/worker behavior, no new UI surface, but confirm Group D
   (front-end) hasn't already shipped a UI that depends on this before deciding. If user-visible,
   run `node scripts/append-release-note.mjs --pr <number>` from the branch and commit the
   `docs/WHATS_NEW.md` change onto the same branch (project rule — nothing does this
   automatically).
5. This is a shared worktree — re-check `herdr pane list` before any tree-wide git action, and
   follow the `shared-checkout` skill for the release-note commit (explicit path, diff-review
   before commit, verify `git show --name-only HEAD` after).

Chat/status text for this task must stay plain English per the global CLAUDE.md rule — no
identifiers unless the user needs to act on them directly.
