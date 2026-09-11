# Today briefings backend exploration

Date: 2026-09-10

Scope: research for the approved Today, morning briefing, and evening planning designs. This note
maps existing production seams to the requested behavior and calls out the smallest new contracts
that implementation planning must settle. It does not propose production edits or claim that the
preview artifacts are live evidence.

## Evidence and current end-to-end path

The briefing module already owns definitions, asynchronous runs, composition, persistence, and
schedule reconciliation. The HTTP surface is `GET/POST /api/briefings/definitions`, definition
patch, manual run, and run listing. Each route resolves an actor and executes repository work inside
`withDataContext`; a manual run enqueues a metadata-only pg-boss payload and returns `202`. [`routes.ts:56-124`](../../packages/briefings/src/routes.ts#L56-L124) [`routes.ts:158-215`](../../packages/briefings/src/routes.ts#L158-L215)
The worker validates that payload shape before minting a scheduled run ID. It invokes the repository
and only sends a metadata-only ready notification for a newly-created successful scheduled run.
The default worker dependencies are intentionally inert (no memory retrieval and no AI), while the
composition root injects the real dependencies in production. [`jobs.ts:106-157`](../../packages/briefings/src/jobs.ts#L106-L157) [`jobs.ts:159-180`](../../packages/briefings/src/jobs.ts#L159-L180)
`generateRun` captures one `now`, takes a transaction-scoped advisory lock for scheduled local-day
idempotency, rejects selected non-read tools, and for an evening run looks up same-local-day
morning metadata. It passes that metadata into composition and persists the result in one data
context transaction. [`repository.ts:200-269`](../../packages/briefings/src/repository.ts#L200-L269)
Persistence writes `summary_text` and `source_metadata`; the structured payload is nested under
`source_metadata.structuredPayload`. The definition's `last_run_at` is updated with the run. [`repository.ts:272-309`](../../packages/briefings/src/repository.ts#L272-L309)
Daily and weekly schedules are pg-boss schedules keyed by definition ID. Defaults are 07:00 for
morning, 19:00 for evening, and 09:00 Sunday for weekly review, all initially in UTC. Definition
reads self-heal only the actor's owned schedules, so a shared viewer cannot schedule another
owner's definition. [`schedule.ts:17-53`](../../packages/briefings/src/schedule.ts#L17-L53) [`schedule.ts:56-89`](../../packages/briefings/src/schedule.ts#L56-L89)
The web Today page independently fetches tasks, lists, calendar events, definitions, and morning
and evening runs. It chooses the first definition of each type, then the evening-mode helper
selects the latest run whose creation date is today in the effective briefing timezone. [`today-page.tsx:91-140`](../../apps/web/src/today/today-page.tsx#L91-L140) [`evening-mode.tsx:86-108`](../../apps/web/src/today/evening-mode.tsx#L86-L108)

Today switches from day to evening at the definition target time and refreshes the mode timer. The
existing wellness controls and generic module widgets are separate contributions and should remain
owned by their modules during any Today layout work.

## Existing composition plumbing

`composeBriefing` dispatches evening definitions to `composeEveningBriefing`; morning composition
gathers commitments, non-suggested tasks, calendar, actionable email, vault, chats, goals, sports,
and injected external-module contributions. Tool sections are selected by definition and are
formatted through explicit field allowlists. [`compose.ts:68-120`](../../packages/briefings/src/compose.ts#L68-L120) [`compose.ts:390-461`](../../packages/briefings/src/compose.ts#L390-L461)

`ComposeDeps` is already the intended module boundary. It accepts source behavior policy,
connector freshness, feature grants, live-first source context, calendar follow-through, and an
external briefing invoker/manifests without importing connector internals. `ComposeRunInput` has a
specific optional `sameDayMorningMeta` field because the repository, rather than the composer,
resolves the morning run. [`compose-shared.ts:40-116`](../../packages/briefings/src/compose-shared.ts#L40-L116)

`gatherToolSection` checks that a selected tool exists, injects actor-scoped services, reads the
declared array key, applies local-day filtering, caps each section at eight items and 1,200
characters, and converts failures to gaps. Only the formatter's explicitly named fields cross the
AI trust boundary. [`compose-shared.ts:318-352`](../../packages/briefings/src/compose-shared.ts#L318-L352)

The prompt boundary sanitizes external values and wraps them in `<external_source>` blocks. This
is reusable for any persisted planning context: store structured, owner-scoped values and sanitize
again at prompt construction rather than treating stored text as instructions. [`trust-boundary.ts:1-100`](../../packages/briefings/src/trust-boundary.ts#L1-L100)

Calendar and email source context are live-first. Active feature grants are checked; revoked,
unsupported, and authentication failures become explicit gaps. Transient non-auth provider errors
fall back to bounded cached rows and mark the account source as `cache`. [`compose-shared.ts:52-66`](../../packages/briefings/src/compose-shared.ts#L52-L66) [`source-context/calendar.ts:253-337`](../../packages/connectors/src/source-context/calendar.ts#L253-L337) [`source-context/email.ts:362-450`](../../packages/connectors/src/source-context/email.ts#L362-L450)

Freshness maps briefing sections to realtime, connector-sync, or vault-write timestamps and stores
the result in source metadata. Today displays source ages and an over-day stale banner, but it has
no briefing-specific refresh orchestration. [`freshness.ts:1-90`](../../packages/briefings/src/freshness.ts#L1-L90) [`briefing-freshness.tsx:15-75`](../../apps/web/src/today/briefing-freshness.tsx#L15-L75)

Calendar signal derivation already emits preparation and time-block suggestions. Injected
`calendarFollowThrough` can auto-create task/calendar artifacts according to calendar preferences;
this is distinct from chat write tools, which use confirmation-gated action requests. [`signals.ts:1-50`](../../packages/briefings/src/signals.ts#L1-L50) [`compose.ts:522-565`](../../packages/briefings/src/compose.ts#L522-L565) [`gateway.ts:715-780`](../../packages/ai/src/gateway/gateway.ts#L715-L780)

The reuse boundary is therefore:

| Area               | Reuse now                                             | Extend                         | Missing                              |
| ------------------ | ----------------------------------------------------- | ------------------------------ | ------------------------------------ |
| Runs and schedules | repository, worker, pg-boss, local-day idempotency    | read/refresh status contracts  | intent-to-run linkage                |
| Composition        | gatherers, trust boundary, freshness, fallback        | morning plan/context inputs    | structured plan narrative            |
| Interview          | seed route, chat sessions, action confirmation        | resume and save hooks          | durable typed answers                |
| Calendar/task plan | focus windows, task status, follow-through            | conflict/version checks        | block/proposal model and batch apply |
| Today/modules      | query orchestration, widget docking, wellness actions | report/review screens          | full report, adjust, accept/retry UI |
| News/sports        | briefing tools, manifests, sports widget              | defaults, prose, photo adapter | live news Today feed/photo contract  |

## Evening-to-morning seam: what exists and what is missing

The current seam is metadata-only and one-way. During evening generation, the repository finds the
same-local-day morning run and passes its entire `source_metadata` object as an optional input. [`repository.ts:245-265`](../../packages/briefings/src/repository.ts#L245-L265)

The evening composer extracts only up to six sanitized `summary` strings from morning
`calendarSignals` and `emailSignals`. It emits a context-only `morning_plan` section and records
`morningRunReferenced` in evening metadata. It does not read a morning body or a structured intent. [`compose-evening.ts:76-100`](../../packages/briefings/src/compose-evening.ts#L76-L100) [`compose-evening.ts:440-475`](../../packages/briefings/src/compose-evening.ts#L440-L475)

The evening interview route accepts only an optional `briefingRunId` and chat surface. The registry
resolves an owner-only evening run, passes its `summary_text` to `buildEveningInterviewSeed`, then
seeds a chat session and submits the fixed opening prompt “Prep me for tomorrow.” [`live-routes.ts:368-418`](../../packages/chat/src/live-routes.ts#L368-L418) [`module-registry/src/index.ts:3105-3113`](../../packages/module-registry/src/index.ts#L3105-L3113)

The seed instructs the model to ask reflection/planning questions and use normal action-request
proposals; it explicitly forbids direct record mutations. The seed embeds sanitized review text,
but no interview answer, selected priority, day shape, start time, or task placement is persisted
as an evening intent. [`live-routes.ts:535-547`](../../packages/chat/src/live-routes.ts#L535-L547)

Conclusion: a new durable planning record or equivalent owner-scoped persistence is necessary for
the approved handoff. Extending morning metadata alone cannot represent interview choices, review
edits, pending additions/moves/removals, or whether a choice was applied. A separate intent/plan
aggregate carrying typed intent and block state together is the cleaner seam because chat notes, a
briefing run's immutable snapshot, and an editable plan have different lifecycles. This can be one
Calendar-owned record with child block decisions rather than parallel intent and plan stores. Keep
the originating evening run and morning run IDs as provenance references.

Any new intent/plan read or write must run through `DataContextDb`, be owner-only, and avoid private
content in pg-boss payloads. Existing run rows are owner-only because their narrative and source
metadata contain private task, email, and calendar-derived data; definition sharing does not grant
run access. [`0085_briefing_runs_owner_only_select.sql:1-34`](../../packages/briefings/sql/0085_briefing_runs_owner_only_select.sql#L1-L34)

## Evening composition and plan implications

Evening already performs two task reads (recent done and open), partitions them into completed,
slipped, and carrying-forward lenses, and filters calendar data to the rest of today plus tomorrow.
Email is bounded to messages received today and actionable triage signals. [`compose-evening.ts:127-190`](../../packages/briefings/src/compose-evening.ts#L127-L190) [`compose-evening.ts:240-275`](../../packages/briefings/src/compose-evening.ts#L240-L275) [`compose-evening.ts:278-346`](../../packages/briefings/src/compose-evening.ts#L278-L346)

The evening report has six fixed sections and a deterministic fallback. Sports is integrated as
compact followed-team facts. News is an explicit `unwired` gap even when the approved design asks
for news and sports prose. [`compose-evening.ts:38-59`](../../packages/briefings/src/compose-evening.ts#L38-L59) [`compose-evening.ts:375-445`](../../packages/briefings/src/compose-evening.ts#L375-L445) [`compose-evening.ts:519-555`](../../packages/briefings/src/compose-evening.ts#L519-L555)

The existing structured action payload is for email-derived suggested-task rows. It does not model
time-block placement, proposal state, conflict state, or a batch decision. Today accepts or
dismisses these rows by updating task status, so it cannot implement the approved plan review by
itself. [`action-rows.ts:29-36`](../../packages/briefings/src/action-rows.ts#L29-L36) [`action-rows.ts:99-155`](../../packages/briefings/src/action-rows.ts#L99-L155) [`briefing-action-rows.tsx:45-105`](../../apps/web/src/today/briefing-action-rows.tsx#L45-L105)

Calendar focus-time helpers already resolve local part-of-day windows, clamp durations, and choose
conflict-aware slots. They are useful for a plan block proposal, but they do not provide durable
placement rows or the approved batch-apply transaction. [`focus-time.ts:126-161`](../../packages/calendar/src/focus-time.ts#L126-L161)

The plan contract should distinguish fixed calendar commitments, proposed task blocks, existing
scheduled task blocks, and unscheduled tasks. Removing a block must preserve the task and due date;
switching automatic scheduling to proposals must preserve existing blocks. A plan apply request
should carry expected versions or equivalent optimistic-concurrency markers so a moved meeting or
daytime task change cannot silently overwrite the user's calendar.

The approved flow requires conflict detection before applying any batch, with fixed meetings,
lunch, and travel protected. It also requires zero selected blocks, explicit unscheduling, retry
after a failed save, and a visible summary of additions, moves, proposal edits, and removals. None
of those states has a current briefing API contract. [`2026-09-10-evening-planning-flow.md:38-59`](../superpowers/specs/2026-09-10-evening-planning-flow.md#L38-L59) [`2026-09-10-morning-briefing-flow.md:24-57`](../superpowers/specs/2026-09-10-morning-briefing-flow.md#L24-L57)

## News, sports, and module composition

News already exports `news.topHeadlinesToday`, configured at boot with a dataset-backed service. Its
output is capped compact “Title — Source” facts and honors personalization exclusions. The tool is
declared in the news manifest but is absent from the current morning defaults; evening records news
as unwired. [`briefing-tool.ts:9-23`](../../packages/news/src/briefing-tool.ts#L9-L23) [`briefing-tool.ts:41-53`](../../packages/news/src/briefing-tool.ts#L41-L53) [`manifest.ts:310-326`](../../packages/news/src/manifest.ts#L310-L326) [`routes.ts:530-549`](../../packages/briefings/src/routes.ts#L530-L549)

Sports has the parallel `sports.followedFactsToday` briefing tool. It returns compact followed-team
facts only; rich scores, photos, and editorial prose belong to the sports module's Today widget or
future contribution contract. [`sports/briefing-tool.ts:8-23`](../../packages/sports/src/briefing-tool.ts#L8-L23) [`sports/briefing-tool.ts:39-51`](../../packages/sports/src/briefing-tool.ts#L39-L51)

Today's module widget docking is generic: web contributions are lazy-loaded, independently suspended,
and filtered by disabled module IDs. This is the correct preservation seam for Wellness medication
and check-in actions and future sports/news widgets. [`module-today-widgets.tsx:4-45`](../../apps/web/src/today/module-today-widgets.tsx#L4-L45)

The current `TodayFeed` is prop-driven. Its news item shape has source, title, dek, and meta but no
image URL, and `NewsDesk` renders a “Story image” placeholder. TodayPage does not fetch a news feed
itself. A real-photo requirement therefore needs a feed adapter or module contribution with an
explicit image URL, loading/error policy, and safe host/CSP handling. [`feed-source.ts:24-42`](../../apps/web/src/today/feed-source.ts#L24-L42) [`news-desk.tsx:7-33`](../../apps/web/src/today/news-desk.tsx#L7-L33) [`today-page.tsx:437-440`](../../apps/web/src/today/today-page.tsx#L437-L440)

The approved default-on news/sports behavior needs morning-specific preference persistence and a
clear precedence rule: explicit opt-out and disabled module state must suppress briefing inclusion;
existing source behavior settings currently cover email and calendar independently. Tool selection
alone is insufficient to express that preference safely.

## Recommended implementation slices

1. **Lock contracts and precedence.** Add shared DTOs for morning report, planning intent, plan
   blocks, source states, and apply results. Define empty, unavailable, delayed, disabled, conflict,
   and retry states before UI work. Define selected-tool defaults, independent list toggles, explicit
   empty-list semantics, and disabled-module precedence. Update app-map declarations with every new
   screen, action, error, and remediation as required by the development standards.

2. **Persist the day-plan aggregate.** Add one owner-scoped Calendar repository/API for the
   interview's typed choices, notes, and child block decisions. Link it to the evening run when
   present, tolerate unavailable evening runs, and make resume idempotent. Keep free-form notes
   separate from typed choices; use the normal AI gateway confirmation path for chat writes.

3. **Apply aggregate block batches.** Represent proposed, scheduled, unscheduled, moved, and
   removed states with task/calendar references, expected versions, and source intent in that same
   aggregate. Reuse focus time and calendar follow-through where their semantics fit. Implement
   conflict checking and a retryable apply operation with per-block outcomes.

4. **Build morning report and review reads.** Add owner-scoped endpoints that expose saved report,
   source evidence, materials, plan blocks, and pending edits. Support partial acceptance and
   accept-all while keeping the report open; reject stale/conflicting batches and preserve choices
   for retry. Return to Today by invalidating task/calendar/briefing queries.

5. **Complete source and module contributions.** Wire the news briefing tool into morning defaults
   behind selected-tool membership and define prose inputs and photo references separately. The
   implementation plan retains the actual News module widget, with no host feed adapter. Extend sports contributions
   only through its public manifest/widget seam; preserve compact facts for synthesis.

6. **Verify assembled paths.** Cover composition, metadata handoff, RLS ownership, idempotency,
   preference precedence, conflict/partial apply, source recovery, and disabled modules with focused
   unit/integration tests. Then exercise owner signup through Settings, scheduled/manual runs,
   evening interview resume, morning review, and Today refresh on a live dev instance. The preview
   scripts and captures are design references, not release evidence.

## Questions raised by exploration (resolved in the implementation plan)

- Does the single day-plan aggregate link to evening and morning runs by IDs and retain immutable
  plan versions? The current run is an immutable private narrative snapshot, so it should not own
  mutable interview or block state.
- Are plan blocks persisted as proposals, calendar event intents, or both? What is the stable ID
  used to reconcile retries and avoid duplicate external events?
- Is batch acceptance all-or-nothing, or does the API return partial success and a remaining draft?
  How are concurrent task/calendar edits surfaced?
- Which calendar fields identify protected meetings and travel, and what conflict algorithm owns
  that classification?
- Does refresh create a new briefing run, recompose the existing run, or enqueue a source refresh
  followed by a new run? When do daytime changes invalidate a morning report?
- What are the exact quiet, empty, unavailable, disabled, delayed-email, and skipped-evening copy
  contracts, including whether planning may proceed from raw tasks/calendar without a briefing?
- Which module owns Today news image URLs and article links, and what is the fallback when an image
  is absent or its host is not permitted?

## Bounded reconciliation: Calendar ownership and source selection

There is no module-ownership blocker to a single Calendar-owned day-plan aggregate. Calendar already
exports structural ports and the registry composes Calendar and Tasks repositories together for
follow-through; the same pattern can expose a day-plan port to Briefings while keeping Briefings
free of a Calendar package dependency. The aggregate must remain owner-only and store task IDs or
references, not query `app.tasks` from Calendar. Task reads/updates belong behind an injected Tasks
port in the registry. A bounded `HEAD..origin/main` diff showed no briefing or Calendar wiring change; only adjacent notification and News credential/fetch plumbing moved. [`follow-through.ts:1-22`](../../packages/calendar/src/follow-through.ts#L1-L22) [`module-registry/src/index.ts:1099-1179`](../../packages/module-registry/src/index.ts#L1099-L1179)
Current definition selection is sufficient for independent News/Sports opt-outs without a second
store. On create, omitted `selectedToolNames` uses type defaults; on patch, omitted names leave the
stored list unchanged. Explicit names are deduplicated and read-risk checked, and composition skips
unselected tools. The current schema/parser and SQL check reject explicit `[]`; the unnamed SQL check is expected to be PostgreSQL's generated `briefing_definitions_selected_tool_names_check`.
Composition handles `[]` safely by returning empty source sections and invoking no selected tools, but still performs preference/focus aggregation, persona construction, and configured economy-model synthesis (or deterministic fallback). [`routes.ts:336-365`](../../packages/briefings/src/routes.ts#L336-L365) [`routes.ts:404-429`](../../packages/briefings/src/routes.ts#L404-L429) [`briefings-api.ts:131-135`](../../packages/shared/src/briefings-api.ts#L131-L135) [`0015_briefings_module.sql:41-44`](../../packages/briefings/sql/0015_briefings_module.sql#L41-L44) [`compose-shared.ts:350-360`](../../packages/briefings/src/compose-shared.ts#L350-L360) [`compose.ts:261-327`](../../packages/briefings/src/compose.ts#L261-L327)
Smallest contract: add News to the morning default list (Sports is already there), preserve every
existing explicit list, and add morning Settings toggles that edit the persisted list. Settings
currently creates with every active read tool and only patches enabled/time, so the toggle path must
send `selectedToolNames` from the definition; adding a default affects callers that omit the list,
while Settings includes News automatically when its module is active. The implementation plan permits both controls off even for a definition selecting only those tools;
relax the shared schema, parser, and database check together so explicit `[]` means all-off while
omitted still means defaults. Composition must retain the selected-name gate plus active-module
gate; disabled modules win and stored names can survive re-enable. [`settings-module-subviews.tsx:107-142`](../../apps/web/src/settings/settings-module-subviews.tsx#L107-L142) [`repository.ts:113-149`](../../packages/briefings/src/repository.ts#L113-L149) [`compose.ts:435-461`](../../packages/briefings/src/compose.ts#L435-L461)
