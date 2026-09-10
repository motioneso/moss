# Slice 4: Plan-grounded briefings and evidence

**Goal:** Connect saved evening intent and current day-plan facts to the existing briefing runtime,
with real source evidence and refresh/history behavior. **Dependencies:** slices 1–3 contracts;
application results from slice 2 for committed-state narratives.

Read [backend exploration](../../research/2026-09-10-today-briefings-backend-exploration.md) and the
[shared plan](2026-09-10-today-briefings.md). Existing definitions/runs/workers remain authoritative.

## Files

`packages/briefings/src/compose-shared.ts`, `compose.ts`, `compose-evening.ts`, `repository.ts`,
`jobs.ts`, `schedule.ts`, `signals.ts`, `trust-boundary.ts`, `freshness.ts`, `action-rows.ts`,
`routes.ts`, `manifest.ts`; `packages/shared/src/briefings-api.ts` and the existing structured-payload
schema; `packages/module-registry/src/index.ts` wiring. Proposed new focused composition helper:
`packages/briefings/src/plan-context.ts`. Do not grow existing large composers/registry files by
pasting new orchestration into them; extract only the cohesive new work.

## Task 1: Inject and project current plan context

- [ ] Add a narrow `ComposeDeps` plan-read/preview port supplied by the composition root. Calendar
      owns its tables; Tasks/Connectors services are likewise injected through public contracts.
- [ ] Resolve the plan for the run's actor, target local date and timezone. Read saved evening
      intent, corrected facts, selected priorities/capacity and actual/proposed block states.
- [ ] Preserve slice 2's post-commit contract: composition returns facts/automatic intents and does
      not perform calendar-provider writes. Persist the run snapshot and reserved pending operations
      before worker application; consume subsequent committed/partial results through the plan port.
      Never pass the run-generation transaction's `DataContextDb` to post-commit apply or overwrite the
      immutable run to pretend an automatic effect had already succeeded during composition.
- [ ] Preserve the existing same-day morning-to-evening signal comparison. Add the missing saved
      evening-to-next-morning direction without pretending those two different handoffs are equivalent.
- [ ] Extend the versioned structured payload compatibly with plan id/revision, typed schedule and
      source/material references, and editorial sections from slice 3. Keep existing email suggested
      action rows/catch-up semantics intact; a time-block proposal is not a suggested-task acceptance.
- [ ] Store a bounded sanitized snapshot/reference in immutable run metadata. Never overwrite an
      old report's provenance with the mutable current plan or expose private data through shared
      briefing definitions; run content remains owner-only.

## Task 2: Ground morning/evening prose

- [ ] Morning: prepared priority/capacity, current schedule, changes since saved intent, preparation,
      travel, risks and eligible News/Sports summaries. No evening plan means no fictional interview.
- [ ] Evening: observed accomplishments, user corrections, open commitments, newly captured tasks,
      and tomorrow's intent. A meeting occurring is not evidence a follow-up was sent/completed.
- [ ] Explain proposed versus committed effects using structured facts. A pending/partially failed
      batch must not produce “everything is scheduled” prose. Zero task blocks is a valid day shape.
- [ ] Add short News/Sports prose after operational content with followed teams first and factual
      score/tonight references. Preserve author-supplied source exclusions before synthesis and display.
- [ ] Use existing capability/model routing, trust-boundary sanitization and deterministic fallback.
      Source/model failure should retain useful facts and a specific gap, not fail the whole day.
- [ ] Preserve per-source freshness/availability. Generated prose cannot upgrade a stale source or
      invent unseen email, weather, stories, teams or preparation documents.

## Task 3: Refresh, history, and daytime reconciliation

- [ ] Reuse manual-run enqueue, idempotency and run listing for refresh/history. Bind retries to
      actual run/operation state; don't add another cron engine or poll remote sources from components.
- [ ] Return/resolve the refreshed run identity and status so UI can distinguish pending, failed,
      new, and old results. Preserve existing scheduled local-period deduplication and ready notifications.
- [ ] Provide dated earlier-run access through current owner-scoped run APIs. Old reports are
      read-only; an action from an old source must load/revalidate the current plan before application.
- [ ] For source/task changes during the day, recompute the affected plan projection and show its
      revision/time. Reuse existing invalidation/events where available; do not build a general live
      report patch engine or send unsolicited notifications merely because content changed.
- [ ] Protect open review drafts from refreshed facts. Return a current-version conflict/diff for
      review, never silently rebase a calendar mutation onto new appointments.
- [ ] Bind evidence/material links to real source identities and access checks. Avoid exposing raw
      connector message URLs/identifiers where an existing opaque reference is required.
- [ ] Update Briefings manifest features/errors/remediations for reader, history, refresh, source
      gaps and plan handoff. Keep metadata consistent with routes actually available at this slice.

## Verification and stop

- [ ] Unit: morning/evening composition, both handoff directions, no evening intent, user correction,
      source trust/freshness, incompatible structured payload versions, source opt-outs, and numeric
      sports facts. Existing `briefings-compose`, `briefings-schedule` and action-row suites remain green.
- [ ] Protected integration: run ownership despite shared definitions; local-day/DST boundaries;
      refresh/run deduplication; saved evening intent across process/reload; old-run immutable snapshot;
      applied/partial/pending block narratives; scheduled generation with configured source services.
- [ ] Static checks for touched files and root/test type coverage. Record commands/exit codes.

Session checkpoints: first plan port + versioned payload, then synthesis/fallback, then refresh and
history proof. Stop with real typed data ready for UI; no copied HTML study or new scheduler.
