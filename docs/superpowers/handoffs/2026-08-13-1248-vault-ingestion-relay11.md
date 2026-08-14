# #1248 vault-ingestion — relay11 continuation

PR #1606, branch `1248-vault-ingestion`, this worktree. Green CI and fresh sensitive QA GREEN going
into this relay; QA correctly flagged the branch as one commit behind current `origin/main` (missing
`e546bd7d8` "fix(notes): isolate sync worker CPU (#1590) (#1609)", merged after the last rebase).

## Done this relay

1. Rebased onto current `origin/main` (`e546bd7d8`). **One conflict**, in
   `packages/jobs/src/pg-boss.ts` `ALLOWED_PAYLOAD_KEYS`: our relay's `11bc8ebe2` added `"op"` to the
   allowlist array on the same lines where an unrelated main-line commit added `"filePath"`,
   `"chunkOffset"`, `"fileHash"`. Purely additive on both sides — resolved by keeping all four new
   keys, no logic conflict. Verified no stray conflict markers and no duplicate `"op"` entry after
   resolution.
2. Pre-push trio, root-level (not filtered): `format:check`, `lint`, `typecheck` all EXIT=0. Did not
   run the full `pnpm verify:foundation` gate — this relay's only change is the rebase replay plus
   this docs-only commit, not new feature code, so the trio is the appropriate check per the task
   brief. No DB-touching command was run, so no gate DB isolation was needed.
3. Force-with-lease pushed the rebased branch to `origin/1248-vault-ingestion`.

## State handed to Coordinator

New HEAD after rebase + this commit: see PR #1606 / `git log -1` at push time. Rebase was
conflict-free in the sense that the one conflict was mechanical/additive, not a real logic clash —
reported as such to Coordinator, not silently squashed into "conflict-free."

Existing two-spec live UAT proof (from relay9/relay10, `1217-uat-vault-ownership.uat.spec.ts` +
`module-install.uat.spec.ts`, no screenshots) is unchanged and still applies — nothing in this
relay's rebase touched vault-ingestion runtime behavior, only the shared `ALLOWED_PAYLOAD_KEYS`
allowlist array which now carries both this branch's and main's independent additions. No UAT re-run
performed per task brief (preserve existing proof, no new screenshots).

## Explicitly NOT done this relay

- No merge, no board update — per task brief, Coordinator owns both.
- No UAT re-run.
