# Relay — 1517-escape-commitment-evidence

**Spec:** `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` section `### C4 — Plain-text evidence excerpts`
**Issue:** #1517. **Branch/worktree:** `1517-escape-commitment-evidence` (same worktree, continue in place).
**Plan:** `docs/superpowers/plans/2026-08-21-1517-escape-commitment-evidence.md` (already approved by coordinator).
**Coordinator:** label `Coordinator` in `herdr pane list` — re-resolve pane + session id fresh, never trust a number written here.

## Done (committed)

- Commit `ba013ff78`: `sanitizeExcerpt` in `packages/commitments/src/repository.ts` now escapes
  `&`, `<`, `>` then truncates to 500 chars (was: strip `<script>` tags only). 5 new integration
  test cases added to `tests/integration/commitments.test.ts` under
  `describe("addEvidenceRow — excerpt escaping", ...)`.
- Verified green in isolation: `pnpm --filter @moss/commitments typecheck` (rc 0), focused
  integration test `tests/integration/commitments.test.ts` on an isolated gate DB — 12/12 pass
  (rc 0). Repo-wide `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm check:file-size` all
  green. `git rebase origin/main` — already up to date, no-op.
- Coordinator confirmed (before this relay): no `.tsx`/frontend component ever renders the raw
  evidence excerpt — only the API route, AI tool schema, and worker consume it — so **no live-path
  UAT proof is required** for this PR. The spec's own C4 acceptance line (synthetic
  integration-test round trip) is the bar; already met by the 5 new tests.

## Resolved — was blocking wrap-up, now cleared by the coordinator

Ran the full gate once (`scripts/run-gate.sh`, gate DB `jarvis_gate_1517_escape_commitment_evidence`,
log `/tmp/jarv1s-gate/1517_escape_commitment_evidence-20260821-164802.log`): rc=1. Failures were
in two files, both unrelated to this change (this branch only touches
`packages/commitments/src/repository.ts` and its test file):

- `tests/unit/local-embedding-provider.test.ts` — 1 failure on the full-suite run; passed on an
  isolated re-run. Load/timing flake from concurrent sibling lanes on this box.
- `tests/unit/mcp-gateway-validation.test.ts` — 3 failures, reproduced deterministically on a
  second isolated run.

**Coordinator ruling (2026-08-21):** the `mcp-gateway-validation.test.ts` failures match tracked
issue #1673 — a hardcoded 100ms worker timeout against a measured 80-150ms cold start, so it fails
under CPU load, not deterministically broken. Another lane (#1754) hit the identical 3 failures in
the same file at the same time, consistent with several lanes sharing this machine right now. Not
a real break on main, not caused by this change, no stash-verify needed. Cleared to push and open
the PR, noting these 3 failures as pre-existing/tracked in #1673 in the PR body.

## Teardown state

Gate DBs `jarvis_gate_1517_escape_commitment_evidence` and `jarvis_gate_1517_recheck` were left in
place (not dropped) so failures can be inspected; drop both once done:
```bash
docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS jarvis_gate_1517_escape_commitment_evidence;"
docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS jarvis_gate_1517_recheck;"
```
No dev instance was started by this lane. No seed rows in the shared dev DB were touched.
