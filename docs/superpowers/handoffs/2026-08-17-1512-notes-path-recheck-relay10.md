# Relay 10: #1512 notes-path-recheck — BLOCKED on gateway message-swallow, awaiting Coordinator ruling

Spec: `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` §B1
Plan: `docs/superpowers/plans/2026-08-17-1512-notes-path-recheck.md` — "Addendum (relay 8)" has the
approved live-UAT scope (a)/(b)/(c') + the jobs.ts TOCTOU test-only carve-out. Don't re-read it in
full — you don't need to; the scope hasn't changed.
Issue: #1512 (security tier). PR: **#1671**, branch `1512-notes-path-recheck`, this worktree.
Coordinator: resolve fresh by label "Coordinator" via `herdr pane list` (pane id reflows).

## State: relay9's three verification steps are DONE. One is a real blocker, escalated, unresolved.

1. **Typecheck: clean.** `pnpm typecheck` (root tsc + `@moss/web` + external-modules) — all pass.
   Log: `/tmp/uat-1512-typecheck.log`.
2. **`pnpm test:uat notes-path-recheck`: FAILED, exit 1.** Log: `/tmp/uat-1512.log` (1329 lines).
   - Scenario (a) legit create/edit/delete: **passed**.
   - Scenario (b) `rejectSymlinkParent` refusal-text assertion: **failed** — 60s timeout waiting
     for `role="status"` text `"Not changed — path is not within the linked notes source"`.
   - Scenario (c') not reached (test aborted at b's failure).
3. **Integration re-run (jobs.ts TOCTOU citation): clean, 29/29.**
   `pnpm test:integration tests/integration/notes.test.ts` (NOT bare `vitest run` — that trips the
   DB-isolation guard, `tests/integration/test-database.ts:57`). Log:
   `/tmp/notes-integration-1512-v2.log`.

## THE BLOCKER — root cause, confirmed via static trace, not a guard-code defect

The security guards are correctly blocking both writes in (b) and (c') — this is a **messaging**
gap, not a security gap.

Trace: `packages/notes/src/write-tools.ts` (`rejectSymlinkParent` line ~124, pre-existing;
`recheckInside` → `recheckWithinRoot` → `canonicalizeAsFarAsExists` in `packages/notes/src/path-guard.ts`,
the actual #1512 guard) both throw `HttpError(400, "path is not within the linked notes source")`
correctly on a blocked write. But `packages/ai/src/gateway/gateway.ts`'s `runHandler()` (lines
536-575) — **confirmed via `git log` UNTOUCHED by any #1512 commit** (`fe263802f`, `10bad6374`,
`918bc78ff`, `b0b3077e3`) — has a bare `catch { ... }` with no `instanceof HttpError` branch. It
unconditionally discards the thrown message and returns `{ ok: false, error: "Tool ${name} failed" }`.
That generic string flows through `gatewayFailureReason()` → `gateway-notifier.ts`'s
`toTranscriptRecord()` → renders in the chat UI as `"Not changed — Tool notes.create failed"`
instead of the specific refusal text the UAT spec asserts on. Affects (b) and (c') identically —
both go through the same gateway path. Contrast: `packages/module-sdk/src/route-errors.ts`'s
`handleRouteError()` DOES special-case `HttpError` and unwraps its `.message` — `gateway.ts`
doesn't mirror that pattern.

**This has always been true** — `rejectSymlinkParent` predates #1512 entirely. It was just never
previously asserted against in a UAT spec.

## Escalated to Coordinator, NOT yet ruled on

Sent via `herdr agent prompt` to pane `w1:pEH` (label "Coordinator", session
`77c69c9b-1feb-462a-b6dc-2d505a751bbd` at time of sending — **re-resolve fresh, don't reuse this**),
agent name `coordtake38`. Full message covered: results 1-3 above, the root-cause trace, and two
options **presented, not decided**:
- (i) patch `gateway.ts` to unwrap safe `HttpError` messages (mirrors `route-errors.ts`) — broader,
  security-relevant, touches every write tool, arguably outside #1512's scope.
- (ii) relax the UAT spec's assertion to match the actual generic text — still proves the write was
  blocked, just not that the specific guard fired.

**No reply received yet as of this doc.** Your first job: check for a reply (message your own pane
or check `herdr pane read` on the Coordinator pane), and if none, wait/re-ping rather than deciding
unilaterally. Do NOT pick (i) or (ii) yourself — the handoff chain has been explicit and repeated
about not silently re-scoping.

## What's NOT been done — do not skip when unblocked

- **No `gh pr comment` posted to PR #1671 yet.** Do not post the "success" proof template from the
  relay9 doc's step 5 verbatim — (b)/(c') did not pass live yet. Once the Coordinator rules and
  either the gateway fix or spec relaxation lands and passes, the comment must state the true
  outcome (including that a pre-existing gateway messaging gap was found and how it was resolved),
  not overclaim.
- No merge, no close, no board move — not yours regardless of outcome.

## Predecessor panes

- relay8 (session `8f1f39dc-4b4b-4871-9b86-41ad119ce50c`): already absent from `herdr pane list`
  when relay9 checked — already reaped, nothing to do.
- relay9 (this session, `f43230ef-d07e-478c-8396-735822d317d7`): relaying now on the context-meter
  70% warning, zero uncommitted changes (made no code edits — pure investigation + escalation).
  Message the Coordinator "relayed to <your pane/label>, safe to reap relay9" once you're confirmed
  driving — resolve relay9's pane fresh by session id, never a baked pane number.

## Logs on disk (not committed, all under /tmp — re-generate if gone)

- `/tmp/uat-1512-typecheck.log` — clean.
- `/tmp/uat-1512.log` — UAT failure, 1329 lines, failure at spec.ts:229.
- `/tmp/notes-integration-1512-v2.log` — 29/29 pass.
- `tests/uat/specs/notes-path-recheck.uat.spec.ts` lines 190-264 — the spec itself (already
  committed at `818b80961`), unchanged this session.
