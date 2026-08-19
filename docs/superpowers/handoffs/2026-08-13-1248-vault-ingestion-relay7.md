# #1248 vault-ingestion — relay7 continuation

## Where things stand

PR #1606 (branch `1248-vault-ingestion`, this worktree, HEAD `fe5776cd1`) got a **RED QA verdict**:
https://github.com/motioneso/moss/pull/1606#issuecomment-5284804690

Coordinator label: **Coordinator** (resolve fresh by label + `agent_session.value` via
`herdr pane list` — do not reuse any pane number from this doc, it reflows). Filed tracking issue
for the unrelated CI flake: **#1607** (see below — do not re-investigate it, it's someone else's).

## 4 blocking findings — fix all before re-QA

**(1) Rebase onto `origin/main`.** Branch is 5 commits behind, including 3 `[SECURITY]` merges
(#1602/#1604/#1605) that touch `packages/module-registry/src/index.ts` — this PR also edits that
file, so expect real conflicts, not just a fast-forward. Resolve carefully; re-read the merged
security changes' intent, don't blindly take "ours".

**(2) Spec AC 1(b) unmet: "non-allowlisted path never read or ingested, asserted at the ingester".**
Currently only covered by a pure-function unit test (`isPathIngestable`-style check). QA wants an
**integration-level** assertion — exercise the actual ingester path (attachments/exports
references) and prove a non-allowlisted file is never read/ingested, not just that the predicate
function returns false. Add this to `tests/integration/vault-ingest-jobs.test.ts` or
`tests/integration/vault-ingest-people-notes.test.ts` (whichever already has the ingester
plumbed — check both before picking).

**(3) `packages/memory/src/vault-ingest-registry.ts` — `normalizeRoot()` never collapses `..`.**
Reproduces: `isPathIngestable('people/../attachments/x.md', ['people/..'])` returns `true` when it
should be `false`. **Currently not exploitable** — `apps/web`/`packages/people`'s
`notes-service.ts:97` blocks `..` upstream before it ever reaches this function — but this is a
defense-in-depth layer that is silently dead. Fix `normalizeRoot()` to collapse `..`/`.` segments
(e.g. via `path.posix.normalize` + reject any result that still contains `..` or escapes the root),
and add a unit test asserting the repro case above now returns `false`.

**(4) After rebase, run the 2 blocking e2e-uat specs on live dev** (not just headless — needs a
real live-dev instance per the Live-Path Gate):
- `tests/uat/specs/1217-uat-vault-ownership.uat.spec.ts`
- `tests/uat/specs/module-install.uat.spec.ts`
Post the run output + screenshots as a PR comment (live-path proof format — see
`coordinated-wrap-up` skill § "Live-path proof").

8 non-blocking notes are in the verdict comment (URL above) — read them, fix at your discretion,
they do not gate re-QA.

## Explicitly NOT your job right now

- The `chat-drawer-surface.test.tsx` CI flake (tracked separately as **#1607**) — already
  diagnosed as pre-existing, unrelated to #1248, escalated to Fable via the Coordinator for the
  merge-policy call. Don't re-investigate; if it resurfaces after your rebase, note it and move on.
- Merge, board, or issue-close actions — report to the Coordinator when green, it owns those.

## Next concrete steps, in order

1. `git fetch origin main && git rebase origin/main` — expect conflicts in
   `packages/module-registry/src/index.ts` against #1602/#1604/#1605. Resolve, re-run
   `pnpm typecheck` on that package after resolving.
2. Fix (3) first (`normalizeRoot()`) — smallest, self-contained, unblocks writing a clean test.
3. Fix (2) — add the integration-level non-allowlisted-path assertion.
4. Re-run the isolated gate (`verify-gate` skill — fresh gate DB, never bare
   `pnpm verify:foundation`) to confirm green post-rebase-and-fixes.
5. Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`) + push.
6. Run the 2 blocking UAT specs on live dev, post proof comment on PR #1606.
7. Message the Coordinator label: ready for re-QA, cite the new HEAD sha and the proof comment.

## Worktree / branch

- Worktree: this directory (`.claude/worktrees/1248-vault-ingestion`)
- Branch: `1248-vault-ingestion`
- `node_modules` already installed — **do not re-run `pnpm install`**.
