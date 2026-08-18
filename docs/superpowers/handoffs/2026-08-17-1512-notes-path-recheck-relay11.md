# Relay 11: #1512 notes-path-recheck — ruling applied, spec committed, live UAT re-run needed

Spec: `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` §B1
Plan: `docs/superpowers/plans/2026-08-17-1512-notes-path-recheck.md` — "Addendum (relay 8)" has the
approved live-UAT scope. Don't re-read it in full.
Issue: #1512 (security tier). PR: **#1671**, branch `1512-notes-path-recheck`, this worktree.
Coordinator: resolve fresh by label "Coordinator" via `herdr pane list` (pane id reflows). As of
this doc: pane `w1:pEP`, session `110a179c-a46a-4218-8d00-0d6f0b96cc63`, idle — **re-resolve, don't
reuse this**.

## Ruling received and applied — do NOT re-litigate the fork

Opus adjudication (`docs/coordination/post1632-queue-2026-08-16.md`, "Take 38 — Opus adjudication:
1512 gateway.ts scope fork") is IN and independently verified against the doc. Full text there;
summary: **reject** patching `gateway.ts` (its bare `catch{}` at line ~506-509 is a deliberate,
pre-existing fail-closed control on the model-context sink — not a bug). **Land**: relax the UAT
spec's (b)/(c') assertions to the actual generic swallowed text, with the precision gap named
explicitly (not silently relaxed), plus a scoped fast-follow issue.

**Both done:**
- `tests/uat/specs/notes-path-recheck.uat.spec.ts` edited and **committed** at `0b5b0548a`
  (this branch, this worktree) — (b) and (c') now assert
  `"Not changed — Tool notes.create failed"`, with an in-code comment (lines 220-232) documenting
  the precision gap and citing the ruling + `tests/integration/notes.test.ts:98-105` as (c')'s
  unit-level proof of the specific guard.
- Fast-follow issue **#1679** filed: `https://github.com/motioneso/moss/issues/1679` — scoped
  exactly as ruled (opt-in per-tool `safeErrors` flag mirroring `externalContent` at
  `module-sdk/src/index.ts:561` / `gateway.ts:494-497`, explicitly NOT a blanket unwrap).
- `pnpm typecheck`: clean (root tsc + `@moss/web` + external-modules). Log:
  `/tmp/uat-1512-typecheck-relay10.log`.

## NOT done — your first job

**Live UAT has not yet passed against the new assertions.** After committing the spec edit, one
re-run (`pnpm test:uat notes-path-recheck > /tmp/uat-1512-relay10.log 2>&1; echo "EXIT=$?"`) was
attempted and **failed — but at scenario (a)**, not (b)/(c'):

```
Error: created note was not indexed
expect(received).toBe(expected)
Expected: true
Received: false
Timeout 60000ms exceeded while waiting on the predicate
  spec.ts:181-183, polling GET /api/me/notes-last-sync for lastSync.at >= syncNotBefore
```

Scenario (a) (legit create/edit/delete) previously **passed** in relay9's run — this is a NEW
failure point, earlier in the flow than the one my edit targeted, and my edit never touched
anything above line ~220. Two live possibilities, not yet distinguished:
1. **Transient/flaky** — dockerized UAT indexing worker latency, one-off. Surrounding log noise in
   that run included `"ai.structured unsupported provider kind"`, `news_compile_ai_fallback`
   `aiError:"provider_error"`, and a claude-print transcript-not-readable warning — none obviously
   tied to notes indexing, may just be normal background noise in this env.
2. **Real regression or env problem** — e.g. an orphaned/stale UAT container colliding on the
   `moss` name (`memory: uat-moss-container-name-collision`, issue #1618) or general dev-box
   resource pressure. Check `docker ps -a | grep -x moss` before re-running.

**Do this first:** re-run once cleanly (`pnpm test:uat notes-path-recheck`, exit-code-safe form —
the `check-gate-pipe.sh` hook blocks piping gate output, redirect to a log and check `$?`
separately). If it passes clean through (a), (b), and (c'), you have your live-path proof — move to
posting it. If it fails identically on (a) again, that's a second occurrence of a NEW failure mode
(not the same failure the whole relay chain has been chasing) — per CLAUDE.md's "two identical
failures → stop and rethink," escalate to the Coordinator with both logs rather than retry-looping
further; check for a stale/orphaned `moss` UAT container first since that's the cheapest, most
likely culprit per prior memory notes.

## Once live UAT passes clean through (a)/(b)/(c')

1. Confirm (b) and (c') actually render the generic text live (not just that the earlier scenario
   (a) blocker is gone) — read the log for both `"Not changed — Tool notes.create failed"` hits.
2. Run the pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`.
3. `git fetch origin main && git rebase origin/main` (resolve conflicts if any — should be none,
   this branch only touches the one test file).
4. Push.
5. Post live-path proof: `gh pr comment 1671 --body-file <tmpfile>` (**never** `gh pr edit`). The
   comment MUST:
   - State plainly that gateway.ts's bare-catch swallow was investigated, ruled a deliberate
     fail-closed control by Opus adjudication, and left untouched by design.
   - Name the precision gap explicitly: (b) and (c') now produce byte-identical generic refusal
     text; together they prove the guard *chain* blocked both writes, not which specific guard
     fired; (c')'s specific guard is separately proven by `tests/integration/notes.test.ts:98-105`.
   - Link fast-follow issue #1679.
   - Report the actual UAT log outcome (all three scenarios (a)/(b)/(c') passing) — do not
     overclaim, don't copy any older "success" template verbatim.
6. Message the Coordinator (re-resolve label fresh) that live-path proof is posted, and
   **explicitly request a fresh Opus QA pass on the whole PR** — this is the ruling's stated final
   step, not optional.

## What is NOT yours

No merge, no closing #1512, no board move — regardless of outcome. That's the Coordinator's call.

## Predecessor panes

- relay9 (session `f43230ef-d07e-478c-8396-735822d317d7`): already reaped before relay10 started
  (confirmed absent from a fresh `herdr pane list`) — nothing to do.
- relay10 (this session, `6e5d80c3-a6fe-4370-9cc0-52a5a7b6356e`, pane `w1:pEN` as of this doc —
  **re-resolve fresh, don't reuse this**): relaying now on the context-meter 70% warning. One
  commit made (`0b5b0548a`, the spec relaxation), one fast-follow issue filed (#1679), one UAT
  re-run attempted (failed at scenario (a), see above — unresolved). Message the Coordinator
  "relayed to <your pane/label>, safe to reap relay10" once you're confirmed driving — resolve
  relay10's pane fresh by session id, never a baked pane number.

## Logs on disk (not committed, all under /tmp — re-generate if gone)

- `/tmp/uat-1512-typecheck-relay10.log` — clean, EXIT=0.
- `/tmp/uat-1512-relay10.log` — UAT failure at scenario (a) ("created note was not indexed"),
  EXIT=1. This is the log to inspect first for the transient-vs-real question above.
- `/tmp/uat-1512-typecheck.log`, `/tmp/uat-1512.log`, `/tmp/notes-integration-1512-v2.log` —
  relay9's earlier logs (typecheck clean, UAT failed at old scenario (b) text, integration 29/29
  clean) — superseded by the above but kept for reference.
