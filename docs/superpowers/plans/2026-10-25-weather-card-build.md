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
3. Run scoped tests and the static gate; open a draft PR against `design/weather-card-mockups`.
   Report to coordinator `w1:p1E`, then stop. Retarget after #3737 merges.

Determinism: all card content comes from the saved record; no model jobs, prompt changes,
chat injection, requests or saved-setting changes.

Kill gate: if the snapshot cannot supply a required number, stop and report to the coordinator;
do not expand the data/API contract. Ben/coordinator decides any further scope.

## Verification

Commands are unpiped; expected exit 0 except the original-renderer regression run (expected 1):

- `pnpm exec vitest run tests/unit/weather-forecast-card.test.tsx`
- `scripts/run-gate.sh start --gate verify:static`, then `scripts/run-gate.sh wait --follow`.
- Browser DOM/layout assertions at 390px and desktop in light, dark and sage are fixture checks.
- Merge requires separate real UI/live-data UAT evidence on the PR per the live-path gate.
  Until that exists the product status is **code-complete, unverified**; do not merge or mark Done.
