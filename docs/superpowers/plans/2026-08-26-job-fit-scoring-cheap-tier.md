# Plan: route job-fit scoring to the cheap AI tier (#1421)

Spec: `docs/specs/1421.md`. Task issue: #1421 (this issue is not a "task" sub-issue system in this
repo — #1421 itself is the build target, confirmed via `gh api repos/motioneso/moss/issues/1421`).

## Seams check (facts, with citations)

- The AI request shape and the tier values the job-search module can ask for are already declared:
  `external-modules/job-search/src/worker/stages/score.ts:31` —
  `tierHint?: "reasoning" | "interactive" | "economy"`.
- The one call site that sets a tier hint is
  `external-modules/job-search/src/worker/stages/score.ts:328-332`, currently
  `tierHint: "reasoning"`.
- The host that carries this hint across the module boundary already accepts `"economy"` as a
  valid value — `packages/module-registry/src/external/worker-rpc-host.ts:519` validates
  `tierHint` against `AI_TIERS`, which includes `economy` (confirmed via
  `packages/module-sdk/src/ai-capabilities.ts:6`: `AiModelTier = "reasoning" | "interactive" |
  "economy"`). No change needed on the host side — this is purely a caller-side value change.
- No test currently pins which tier job-fit scoring asks for:
  `grep -n "tierHint" tests/unit/job-search-score-stage.test.ts` returns nothing.
- A comment at `external-modules/job-search/src/worker/stages/score.ts:82-86` explains
  `MIN_CALL_RESERVE_MS` by citing "per-call latency on the reasoning tier ... observed between ~7s
  and ~240s" — this becomes misleading once the call no longer asks for that tier, so it needs a
  one-line correction alongside the tier change.

No open questions — this is a single-file, single-behavior change with an existing, already-typed
seam.

## Task 1 — change the tier hint and fix the stale comment

Files:
- `external-modules/job-search/src/worker/stages/score.ts`

Changes (decisions, not bodies):
- Line 331: `tierHint: "reasoning"` -> `tierHint: "economy"`.
- Lines 82-86 comment: rewrite the sentence that currently asserts "reasoning tier" latency
  numbers to instead say the reserve is measured live per run regardless of which tier is
  configured, so the comment doesn't assert a specific tier's timing as if it were still true.

Test (new — today nothing pins this):
- In `tests/unit/job-search-score-stage.test.ts`, add a test using the existing `scriptedAi`
  helper (or a plain `vi.fn`) that runs `runScore` for one candidate posting and asserts the
  captured `generateStructured` call's first argument has `tierHint: "economy"`. This test would
  fail against today's code (`tierHint: "reasoning"`), so it's a real regression guard, not a
  tautology.

Verification (unpiped, expected exit code 0):
```bash
pnpm vitest run tests/unit/job-search-score-stage.test.ts > /tmp/job-search-score-test.log 2>&1; echo "EXIT=$?"
```

## Kill gate

None needed — this is a single reversible line change with no phase 2. If the new test or the
existing suite fails and can't be fixed within this task, escalate via `fleetctl` blocked status
rather than pushing forward.

## Determinism boundary

N/A — no model output reaches a user-visible surface differently than before; this only changes
which model tier answers the same deterministic scoring prompt/schema.

## Live-path / UAT

Not required: this is a backend routing-parameter change with no visible UI difference (per the
issue's own "User-facing summary: no visible change"). The verification is the unit test above
plus the manual spot-check drift check described in the spec, recorded on the PR.
