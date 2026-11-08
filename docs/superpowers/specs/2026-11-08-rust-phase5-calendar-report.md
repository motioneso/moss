# Rust Phase 5: Calendar scope checkpoint

Task JS-48, Card 525. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027).
Release note Category: N/A.

**Status: discovery only; the Calendar port is not implemented.** This checkpoint records the
existing behavior and recommends smaller build tasks. It does not claim package, privacy,
parity, UI or second-device verification. The full rewrite remains the approved goal.

## Why this checkpoint exists

The task branch started at Phase 0a and was rebased onto main `1ff33decd`. That main contains
the Phase 4b host, shared module SDK, transactional queries and module-frame toolkit. The
brief requires stopping at a clean commit if the work would need more than one compaction.
The full Calendar port, including its day-plan execution system and assembled UI proof,
exceeds that limit. No implementation slice has been silently substituted for the brief.

At this revision, `packages/calendar/src/` contains 32 non-test TypeScript/TSX files with
8,981 lines, plus seven colocated test files with 1,904 lines. The seven files under
`apps/web/src/calendar/` add 1,118 lines. These counts exclude shared contracts, integration
tests, connector adapters and chat composition. Calendar also owns fifteen legacy SQL files.
These are source-inventory counts, not estimates of equivalent Rust size.

## Existing behavior to retain

| Area                   | Reference and required behavior                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Event storage          | `packages/calendar/src/repository.ts`: cached event identity, connector-scoped lookup/upsert, ordered visible events, overlapping-event context, mirror reconciliation and follow-through matching.                                                                                                    |
| Event responses        | `packages/calendar/src/serialize.ts`: preserve explicit `jarvisCreated: false`, the legacy focus-block ID fallback, mirror read-only status, unconfirmed state, all-day metadata and nullable fields.                                                                                                  |
| Event references       | `packages/calendar/src/event-resolver.ts`: UUID-v4 Moss IDs versus connector-scoped external IDs; missing, invalid and inaccessible references retain their current outcomes.                                                                                                                          |
| Calendar screens       | `apps/web/src/calendar/`: Day/Week/Month, saved view choice, timezone/time format, Today navigation, responsive grids, event peek, external-calendar status, loading/error/retry behavior and retained events after a failed refresh.                                                                  |
| Settings               | `packages/calendar/src/settings/index.tsx` and `routes.ts`: lookahead, prep-task and time-block modes, legacy preference fallback, retained confirmed values after failed saves, and the action-policy implications of automatic writeback.                                                            |
| Saved day plans        | `day-plan-model.ts`, `day-plan-repository.ts` and related routes: actor-owned plans and blocks, revision checks, evening intent, task references, drafts and explicit removal disclosure. Draft changes do not write provider events.                                                                  |
| Preview and execution  | `day-plan-preview.ts`, `day-plan-apply.ts`, `day-plan-execute*.ts`, `day-plan-change-approval.ts`: live preview, reserved batches, provenance, idempotency, current authority, approval, partial results, retry and recovery.                                                                          |
| Automation             | `day-plan-auto.ts`, `follow-through.ts`, `monitor-provider.ts` and `heartbeat.ts`: automatic planning, follow-through identity, owner-filtered heartbeat windows, freshness/revision/boundary semantics and monitoring.                                                                                |
| Provider writes        | `calendar-write-service.ts` defines the injected public write contract; the concrete composition lives outside Calendar. Retain create/delete/reschedule/readback semantics and current confirmation/attendee/scope rules. A direct database write is not equivalent to a provider write.              |
| People and Tasks links | Use declared public interfaces. `modules/people/PUBLIC_API.md` describes the intended People contract but explicitly says its package handlers are still being implemented. Day-plan task reachability currently uses an injected public lookup; do not replace it with another module's table access. |

The current thirteen HTTP declarations are:

- `GET /api/calendar/events`
- `GET /api/calendar/events/:id`
- `GET /api/calendar/briefing-settings`
- `PATCH /api/calendar/briefing-settings`
- `GET /api/calendar/day-plan`
- `POST /api/calendar/day-plans`
- `PATCH /api/calendar/day-plans/:id/draft`
- `POST /api/calendar/day-plans/:id/preview`
- `POST /api/calendar/day-plans/:id/apply`
- `GET /api/calendar/day-plans/:id/operations/:operationId`
- `POST /api/calendar/day-plans/:id/operations/:operationId/retry`
- `POST /api/calendar/day-plans/:id/operations/:operationId/recover`
- `POST /api/calendar/day-plans/:id/operations/:operationId/confirm`

The six chat tools are `calendar.heartbeatWindow`, `calendar.listVisibleEvents`,
`calendar.createEvent`, `calendar.deleteEvent`, `calendar.rescheduleEvent` and
`calendar.dayPlanDraft`. Preserve the manifest's separate chat app-action rules: confirmation
and settings that promote authority remain blocked on that path.

The two job kinds in `packages/calendar/src/jobs.ts` are `calendar.cache-evict-event` and
`calendar.day-plan-apply`. The latter reloads its reserved batch from metadata IDs and fails
closed without its injected execution service. Its provider calls deliberately run outside
one ambient database transaction. Queue retry/retention behavior also belongs in parity.

## Data and privacy obligations

Calendar's storage includes `app.calendar_events`, `app.day_plans`, `app.day_plan_blocks`,
`app.day_plan_operations` and `app.day_plan_operation_items`. The original manifest's short
`ownedTables` list names only events; it is insufficient as the Rust package inventory.
The module registry's migration directory discovers all fifteen files under
`packages/calendar/sql/`, including the day-plan migrations.

The event policies evolve across several migrations. `0020` adds explicit event shares;
`0066` includes worker access and connector-scope checks; `0087` strengthens update checks.
Event reads allow owner or explicit view access; updates allow owner or explicit manage
access, subject to their current checks. Events remain private by default. Cache deletion is
worker-only; the misleadingly named `0126_app_runtime_calendar_events_delete.sql` deliberately
adds no application DELETE grant. The day-plan tables use owner-only rules. Do not replace
these distinct rules with one generated generic policy.

These statements describe the checked SQL source. No database policy was exercised here.
Implementation acceptance still requires:

- Keep existing SQL byte-for-byte in its current directory, package it against the compiled
  hash inventory and retain the `core-legacy` ledger. Never edit applied migrations.
- Exercise owners A/B, an unrelated administrator and missing actor through actual Rust
  module calls and runtime-role queries. Check reads, mutation, forged owner/connector
  identity, pooling reuse and every Calendar-owned table.
- Test event view/manage sharing and revocation separately from owner-only day plans. An
  event share must not grant access to a day plan.
- Observe the privacy assertions failing after deliberately removing their protection in a
  disposable gate fixture, then passing with the protection restored.
- Recheck current actor/resource/approval state in jobs. Keep private titles, bodies,
  prompts and provider credentials out of queue payloads.

## Shared integration still needed

`rust-spike/module-host/EXTENDED_HOST.md` explicitly says its APIs do not connect module
screens to the authenticated shell. Inspection of `rust-spike/shell/app/src/main.rs` and its
Cargo manifest confirms that its private router currently serves shell, Today and chat,
without the module-host dependency or dispatch/frame/asset assembly.

HTTPS and sign-in already exist in `rust-spike/network/`; rebuilding them inside Calendar
would duplicate shared infrastructure. A shared integration owner must connect the module
host behind that existing boundary. The Calendar builder should consume that additive
integration on main and own only Calendar package files and its verification/report files.

The existing side-by-side harness can compare HTTP, runtime SQL, jobs and final rows. Its
default launcher builds the Phase 0b Tasks server, and its TypeScript fixture starts Tasks
workers. Calendar needs a scoped launcher/fixture that runs the real Calendar guest and
workers; running the existing Tasks cases would not prove Calendar parity.

## Recommended build split

This is a proposal, not approval to reduce the original acceptance criteria. Keep the final
Calendar acceptance open until every slice and the combined live proof pass.

1. **Package and data path.** Create `modules/calendar/` using section 7 of the package spec:
   manifest, native/Wasm crate, SDK-only host access, exact legacy SQL inventory and a real
   signed install. Port event reads, serialization, settings and saved-plan storage. Add
   matching harness cases and failing-first database privacy controls for all five tables.
2. **Tools, automation and execution.** Port the six tools, two jobs, provider-write public
   service seam, focus scheduling, heartbeat/monitoring, plan preview, approval, apply,
   retry/recovery and follow-through. Prove response, row and job parity with the real guest.
   Preserve public People/Tasks dependencies and current action-policy boundaries.
3. **Screens and assembled proof.** Port existing screens and settings with the shared
   Leptos kit and opaque-frame bridge. Update package navigation/settings/features alongside
   the surfaces they actually serve. Exercise sign-in, package activation, Calendar reads
   and writes, chat actions and failure recovery in the real Rust UI, then on a second
   device through configured HTTPS and trusted origins.

Each slice needs its own bounded build brief and independent review. No new build agents,
global installs, server processes, database runs, pushes or merges were started here.
Workshop and Food remain excluded.

## Verification and remaining work

This commit changes documentation only. Verification is limited to source inspection,
inventory counts, Markdown formatting and whitespace checks; the actual command outcomes
are recorded in the task chat. No product app-map declaration is changed because no product
behavior or screen is added.

Everything in the original implementation and proof request remains outstanding. This
checkpoint must not be presented as a completed module, a passing privacy test, parity
evidence, an independently reviewed implementation or a Ready-to-Playtest build.
