# Weather card A build · #3736

Approved target: `docs/superpowers/2026-10-25-weather-card-design.md` and design A under
`apps/web/src/chat/openui-mockup/weather/`. Worktree: `~/Jarv1s/.claude/worktrees/weather-card-build`.

## Seams and scope

- Existing module renderer: `packages/weather/src/forecast/card.tsx:6`; snapshot reader:
  `packages/weather/src/forecast/contract.ts:18`. Keep validation and all data/tool contracts.
- Actual hourly slots, including DST: `packages/weather/src/forecast/window.ts:40`.
- Host renderer wiring: `apps/web/src/chat/visual-renderer.tsx:77`; host failure boundary:
  `apps/web/src/chat/visual-reply.tsx:18`.
- Shared `Eyebrow`, `Badge`, `Divider`, `EmptyState` supply the authored UI primitives.

## One slice

1. Replace the boxed card with A's inline ruled forecast. Derive whole-degree values, range,
   condition icons, friendly window, every interval label and curve from the validated snapshot.
   Use the snapshot retrieval day for relative date wording so saved history stays immutable.
   Missing slots remain in place and break the curve. Unknown rain/wind remain unknown.
   Keep approximate/stale/observation-unavailable semantics in quiet status/source text.
2. Add focused rendering regressions for rounding, final bucket, partial gaps, fallback,
   metric units, long windows and DST. Observe failures against the original renderer.
   Update module feature metadata in the same PR.
3. Run scoped tests and the static gate; keep draft PR #3739 against `main` now that #3737 merged.
   Exercise real Profile → chat → forecast → reload on a disposable test copy using
   `3736-weather-card-design-a.uat.spec.ts`; attach live proof and report to coordinator
   `w1:p1E`, then stop.

Determinism: all card content comes from the saved record; no model jobs, prompt changes,
chat injection, requests or saved-setting changes.

Kill gate: if the snapshot cannot supply a required number, stop and report to the coordinator;
do not expand the data/API contract. Ben/coordinator decides any further scope.

## Verification

Commands are unpiped; expected exit 0 except the original-renderer regression run (expected 1):

- `pnpm exec vitest run tests/unit/weather-forecast-card.test.tsx`
- `scripts/run-gate.sh start --gate verify:static`, then `scripts/run-gate.sh wait --follow`.
- Browser DOM/layout assertions at 390px and desktop in light, dark and sage are fixture checks.
- `JARVIS_UAT_CLAIMED_WEB_PORT=<claimed port> MOSS_UAT_CAPTURE_OFF=1 pnpm test:uat 3736-weather-card-design-a.uat.spec.ts`
  runs the real UI/live-data path in the isolated provisioned stack (expected exit 0).
- Merge requires that real UI/live-data UAT evidence on the PR per the live-path gate.
  Until that exists the product status is **code-complete, unverified**; do not merge or mark Done.

## Review follow-up

PR #3737 merged; rebase the renderer branch onto `main`. Restore the approximate-place
correction hint, which was omitted unintentionally, and verify that exact locations omit it.
The hint names the city/region correction path and explains that Settings are not saved;
the Weather feature metadata describes the same behavior.
