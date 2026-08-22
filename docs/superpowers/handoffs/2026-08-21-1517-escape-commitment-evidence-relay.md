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

## Open — the one thing blocking wrap-up

Ran the full gate once (`scripts/run-gate.sh`, gate DB `jarvis_gate_1517_escape_commitment_evidence`,
log `/tmp/jarv1s-gate/1517_escape_commitment_evidence-20260821-164802.log`): **rc=1**. Failures are
in two files, both **unrelated to this change** (this branch only touches
`packages/commitments/src/repository.ts` and its test file):

- `tests/unit/local-embedding-provider.test.ts` — 1 failure on the full-suite run
  ("recovers when the process holding the cache load lock is killed"); **passed** on an isolated
  re-run of just that file. Looks like load/timing flake (many sibling lanes were gating
  concurrently on this box).
- `tests/unit/mcp-gateway-validation.test.ts` — 3-4 failures, **reproduced deterministically on a
  second isolated run** (`ToolInputValidationError: Tool test-tool: Pattern matching failed and
  was rejected`, thrown from `packages/ai/src/gateway/input-validation.ts:380`). This is NOT a
  timing flake — same 3 tests failed both times, isolated. Last commits touching that file/test:
  `3ab2f4793`, `20663ec02`, `d9106afa4` (all pre-date this branch; unrelated to commitments).

I flagged this to the coordinator (message sent, not yet acknowledged when I relayed) and am
relaying before getting a reply — context hit the 70% trigger mid-investigation.

## Next concrete steps for the successor

1. Re-resolve the coordinator pane fresh (label `Coordinator`), read recent output — it may have
   already answered whether `mcp-gateway-validation.test.ts` is a known pre-existing break on
   `main` (check `docs/coordination/` if readable, or just re-ask).
2. If not yet confirmed: check whether the 3 `mcp-gateway-validation.test.ts` failures reproduce
   on `origin/main` with this branch's one commit removed (e.g. `git worktree` a scratch checkout
   of `origin/main`, or `git stash`-free — just check out main in a **separate** worktree, don't
   touch this one's branch — and run
   `pnpm vitest run tests/unit/mcp-gateway-validation.test.ts` there with a fresh gate DB). If it
   fails identically on main, this is pre-existing and out of scope for #1517 — say so in the PR
   body per `coordinated-wrap-up`, and proceed to push/PR without waiting for it to go green
   (per CLAUDE.md scope: "do not absorb sibling cleanup").
3. Once cleared (either coordinator confirms pre-existing, or you've verified it independently):
   run the pre-push trio again fresh (`pnpm format:check && pnpm lint && pnpm typecheck`,
   `git fetch origin main && git rebase origin/main`), push, `gh pr create`, note the gate result
   honestly in the PR body (VF_EXIT=1 due to the pre-existing unrelated failure, cite the two file
   names and the isolation evidence above), report DONE to the coordinator per
   `coordinated-wrap-up` step 4, then stop.
4. No live-path proof needed (see "Done" above) — don't re-litigate that; the coordinator already
   ruled on it.

## Teardown state

Gate DBs `jarvis_gate_1517_escape_commitment_evidence` and `jarvis_gate_1517_recheck` were left in
place (not dropped) so failures can be inspected; drop both once done:
```bash
docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS jarvis_gate_1517_escape_commitment_evidence;"
docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS jarvis_gate_1517_recheck;"
```
No dev instance was started by this lane. No seed rows in the shared dev DB were touched.
