# Classifier gate 2.3: `calendar.listVisibleEvents` opts in

Issue: #2883 (Part of #2864). Parent plan: `2026-10-01-classifier-gate-for-chat.md`, section 2.3 only.
Branch: `cg-2-3-calendar`. Worktree: `~/Jarv1s/.claude/worktrees/cg-2-3-calendar`.
Ruling applied: plan ruling 2, "First built-in tool: calendar only." `tasks.create` does not opt in.

## Scope and kill gate

One bounded deliverable: `calendar.listVisibleEvents` carries a complete classifier declaration, an
owner-scoped reply for a small "today" result, and app-map/feature-truth updates that say plainly
that the gate is not releases and nothing runs live. No execution path is activated: release
eligibility (4.2) and the marker replacement (3.6) are later slices, and `ClassifierGate` consults
`isReleased` only in `on` mode.

Depends on: the tool opt-in SDK (`classifier.ts`, landed), the loaded-menu shape the gate consumes
(`GateTool`, landed), and the decision engine (`classifier-gate.ts`, landed, fixtures only).

Kill gate: if `calendarListVisibleEventsExecute` cannot return a bounded, deterministic "today"
summary from its real result without a second model call, stop and report — do not invent a
template that only works on fixtures. Owner: this lane. Call: coordinator with Ben.

## Seams check (verified on this branch, commit `fe6c51777`)

| Assumed capability                                        | Evidence                                                                                                                                                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool opt-in is optional and absent means off              | `packages/module-sdk/src/classifier.ts:196` `checkClassifierEligibility` returns `eligible:false` for no declaration; `:145` `checkArguments`                                                                                          |
| Manifest field exists                                     | `packages/module-sdk/src/index.ts:652` `readonly classifier?: ModuleAssistantToolClassifier`                                                                                                                                           |
| Candidate hook contract                                   | `classifier.ts:50` `ClassifierCandidateProvider(scopedDb, ctx, {signal})`, bounded by `CLASSIFIER_LIMITS.candidates` (50) and validated by `normalizeClassifierCandidates`                                                             |
| Reply template only names plain result fields             | `classifier.ts:116` `checkTemplate` walks `outputSchema.properties`; `:128` rejects object placeholders                                                                                                                                |
| Loaded menu carries the declaration to the gate           | `packages/chat/src/live/classifier-gate-arguments.ts:26` `classifier?: ModuleAssistantToolManifest["classifier"]`; `classifier-gate.ts:375` uses `tool.classifier!.description`                                                        |
| Gate passes the result's `structuredData` to the template | `classifier-gate.ts:517` `outcome.response.ok ? outcome.response.structuredData : undefined`; `renderReplyTemplate` (`classifier-gate-arguments.ts:229`) returns null on any missing placeholder                                       |
| Calendar tool and its result shape                        | `packages/calendar/src/manifest.ts:306` `calendar.listVisibleEvents`, risk `read`, no `executionPolicy`; `packages/calendar/src/tools.ts:13` `calendarToolEventsOutputSchema` (`events[]`, `accounts[]`, `gaps[]`), handler at `:146`  |
| Envelope `structuredData` matches that schema             | `packages/ai/src/gateway/gateway.ts:645-658` sanitizes the handler result; the OSS `ok` envelope's `structuredData` is the tool `data`                                                                                                 |
| Actor timezone reaches the handler                        | `packages/module-sdk/src/index.ts:101` `ToolContext.localTimezone`; already consumed at `packages/calendar/src/tools.ts:224` in the sibling write tool                                                                                 |
| Source contains an explicit truncation signal             | `packages/connectors/src/source-context/types.ts:128` `CalendarContextResult.truncated`; the calendar tool's structural interface (`tools.ts:100`) does not narrow it today, and the source defaults `limit` to 50 (`calendar.ts:243`) |
| Where the menu is built (broader slices)                  | `docs/superpowers/plans/2026-10-01-classifier-gate-for-chat.md` sections 2.3, 3.5; not this lane                                                                                                                                       |
| App-map rule for manifest features                        | `docs/DEVELOPMENT_STANDARDS.md:53` App Map Truthfulness; core help line for Classifier lives in `CORE_APP_SETTINGS.id="aiproviders"` (`packages/shared/src/app-map-core.ts:199-286`)                                                   |

Gaps I could not cite and therefore did not assume:

- No production code builds the gate's tool menu from installed manifests. That wiring is 3.5 and
  is out of scope here; this lane proves the declaration-to-menu path with an explicit test.
- No component renders a request to see today's calendar through the gate. The live-path proof is
  therefore not a UI walk in this slice; the honest PR status is code-complete, unverified against
  the live gate. Section 3.5/4.3 carries the UI proof.

## Decisions

1. **The window is one declared enum argument, resolved in code.** The gate allows at most one
   `candidates` argument (`classifier-gate-arguments.ts:87`) and passes a candidate's **id** — not
   extra fields — to the tool (`:134`), so candidates cannot carry ISO instants. The existing gate
   fixture for this exact case is a `window` enum of `today`/`tomorrow`
   (`tests/unit/chat-classifier-gate.test.ts:56-72`). `calendar.listVisibleEvents` gains an optional
   `window` input property with that enum and declares `arguments: { window: { kind: "enum" } }`.
   `startsAfter`/`startsBefore`/`limit` stay undeclared, so the classifier supplies them never.
2. **Timezone-aware resolution lives in the handler, not the model.** When `window` is present the
   handler derives the concrete `[start, end)` instants for the actor's local civil day from
   `ctx.localTimezone ?? DEFAULT_TIMEZONE`; it never accepts an instant from the classifier.
3. **The reply is a single code-authored `summary`.** The SDK template checker cannot address an
   array element (`events[0].title` and `events.0.title` both resolve to `undefined`; probe recorded
   in the PR), so no event title/time can be a template placeholder. Instead the handler builds one
   deterministic `summary` string from the validated result and the template is `"{summary}"`. This
   is the same shape the gate fixture uses (`chat-classifier-gate.test.ts:69`) and the pattern the
   tasks module already ships (`packages/tasks/src/manifest.ts:98-104`, `tools.ts:196`).
4. **Overflow declines by omission.** `calendarToolEventsOutputSchema` gains an optional
   `summary: { type: "string" }`. When the source reports `truncated: true` the handler omits
   `summary`; `renderReplyTemplate` then returns null and the gate declines (`read_failed`,
   `classifier-gate.ts:515`). An optional property keeps the existing default-model path valid
   (all current calls lack it) while the gate needs it present.
5. **The summary is bounded and truthful.** It states the count and the day; it lists at most three
   event titles, each capped in length, and appends one sentence when any account used cached or
   unavailable data. No arbitrary result detail is dumped.
6. **No authority widening.** Risk stays `read`, no `executionPolicy` is added, no services change.
7. **Truthful app map.** The calendar manifest gains one feature describing the capability and
   naming its current unavailability; the core map's Classifier help line gains the same sentence.
   No claim of live availability or releases.

## Phase 1: bounded today reply (`packages/calendar`)

**Owns:** `packages/calendar/src/tools.ts`, `packages/calendar/src/classifier-window.ts` (new),
`tests/unit/calendar-classifier-tool.test.ts` (new).

### Decisions

- New file `packages/calendar/src/classifier-window.ts` (server-side; imports the existing tz helpers
  from `./focus-time.js`):
  ```ts
  export const CALENDAR_CLASSIFIER_WINDOWS = ["today", "tomorrow"] as const;
  export type CalendarClassifierWindow = (typeof CALENDAR_CLASSIFIER_WINDOWS)[number];
  export interface ClassifierWindowRange {
    readonly startsAfter: Date;
    readonly startsBefore: Date;
    readonly label: "today" | "tomorrow";
  }
  export function classifierWindowRange(
    window: CalendarClassifierWindow,
    now: Date,
    timeZone: string
  ): ClassifierWindowRange;
  export function summarizeCalendarEvents(
    events: readonly { readonly title: string }[],
    options: { readonly label: string; readonly degraded: boolean; readonly truncated: boolean }
  ): string | null;
  ```
  `classifierWindowRange` resolves the local civil day with the existing `localWallClockToUtc`/
  `localDateString`/`addDaysLocal` math in `focus-time.ts` (export a thin `localDayStart(at, tz)` if
  needed rather than duplicating the offset logic). `summarizeCalendarEvents` returns `null` when
  `truncated`, so the caller omits the field.
- `calendarToolEventsOutputSchema` gains one optional top-level property `summary: { type: "string" }`.
  The existing `required: ["events","accounts","gaps"]` and `additionalProperties:false` stay. An
  optional (not required) property is deliberate: the gateway's `sanitizeToolOutputObject` omits a
  declared-but-absent key, and it throws if a **required** key is absent
  (`packages/ai/src/gateway/output-validation.ts:139-153`) — so a truncated result must omit an
  optional key, never a required one.
- `calendarListVisibleEventsExecute` stays the single exported handler. Spread into the source call:
  1. when `input.window` is a valid window value, pass the resolved `windowStart`/`windowEnd` ISO
     instants and compute `label` from it; otherwise behave exactly as today (`startsAfter`/
     `startsBefore`/`limit`);
  2. read `truncated` from the source result (widening the structural interface in `tools.ts` to
     expose `truncated?: boolean`; the source already returns it,
     `packages/connectors/src/source-context/calendar.ts:378`);
  3. compute `degraded = accounts.some(source === "cache" || degradedReason !== null) || gaps.length > 0`;
  4. set `summary = summarizeCalendarEvents(events, { label, degraded, truncated }) ?? undefined`,
     omitting the key entirely when it returns null.

### Tests (behavior + why each fails on a broken build)

`tests/unit/calendar-classifier-tool.test.ts`, calling the real handler with a stub `sourceContext`
(pattern: `tests/unit/calendar-tools-source-context.test.ts`):

1. `window: "today"` in `America/Los_Angeles` and in `Asia/Tokyo` sends different `windowStart`/
   `windowEnd` for the same clock — fails if the range is hardcoded to UTC.
2. `window` `"today"` vs `"tomorrow"` sends consecutive local days and the summary names the right
   day — fails if the label is the raw ISO instant or always "today".
3. `truncated: true` from the source omits `summary` (and `renderReplyTemplate("{summary}", data)`
   returns null) — fails if summary is unconditional.
4. a cache-sourced account and a non-empty `gaps` each make the summary mention cached/unavailable
   data; a fully live read does not — fails if `degraded` is hardcoded false.
5. a zero-event day yields a truthful "No events today." summary and the `{summary}` template
   renders — fails if a placeholder is required-absent.
6. at most three titles appear, each length-capped, for a 10-event day — fails if the summary dumps
   every title.
7. the handler still rejects a non-data-context handle (`assertDataContextDb`) — unchanged invariant.

### Verification

```bash
pnpm exec vitest run tests/unit/calendar-classifier-tool.test.ts > /tmp/cg23-calendar-unit.log 2>&1; echo "EXIT=$?"
```

Expected exit 0. Never piped.

## Phase 2: declaration opt-in (`packages/calendar`)

**Owns:** `packages/calendar/src/manifest.ts`.

### Decisions

- Add to `calendar.listVisibleEvents`'s `inputSchema.properties`:
  ```ts
  window: {
    type: "string",
    enum: ["today", "tomorrow"],
    description: "A named day resolved in the user's timezone; when set it wins over startsAfter/startsBefore"
  }
  ```
  `window` is **not** added to `required`, so existing callers are unchanged.
- Add to the tool (`manifest.ts:306`):
  ```ts
  classifier: {
    description: "Read the user's calendar for today (or tomorrow) and answer with a short list.",
    arguments: { window: { kind: "enum" } },
    replyTemplate: "{summary}"
  }
  ```
  `CLASIFIER_LIMITS.templateChars` is 200 and `descriptionChars` 200: both strings are well under.
- No change to `risk`, `executionPolicy`, `requiresServices`, `permissionId`, or `actionFamilyId`.
  No candidate hook is needed (the window set is static).

### Tests

- Extend `tests/unit/calendar-list-visible.test.ts`:
  1. `checkClassifierEligibility` on the real manifest tool returns `{ eligible: true }` — fails if
     the enum argument or `summary` template field is missing.
  2. the `window` property's enum is exactly `["today","tomorrow"]` and `window` is not required —
     fails if the classifier could reach an ISO argument or the default path is broken.
  3. `gateEligibilityProblem(tool, "choice_only")` returns `null` — fails if the declaration is
     rejected for a choice-only classifier.
- New `tests/unit/calendar-classifier-menu.test.ts`: build a `GateTool` from the real manifest tool
  and assert the plan is exactly one non-required enum `window`, and that `renderReplyTemplate` on a
  `{ summary: "..." }` result returns that text (declaration → menu → reply path without 3.5 wiring). 4. a variant with `summary` removed from `structuredData` makes `renderReplyTemplate` return null —
  fails if the overflow-decline path is weakened.

### Verification

```bash
pnpm exec vitest run tests/unit/calendar-list-visible.test.ts tests/unit/calendar-classifier-menu.test.ts > /tmp/cg23-menu.log 2>&1; echo "EXIT=$?"
```

Expected exit 0.

## Phase 3: truthful manifest feature and UAT (`packages/calendar`)

**Owns:** `packages/calendar/src/manifest.ts`,
`tests/uat/specs/classifier-tool-menu.uat.spec.ts` (new), `.claude/skills/coordinate/uat-trigger-map.tsv`.

### Decisions

- Add to the calendar manifest `features` array (`manifest.ts:493`) one entry:
  - `id: "calendar.list_visible_events_classifier"`
  - `description`: reads as — Today's calendar can be answered by the classifier gate instead of the
    main model, for a short "today"/"tomorrow" window only; it reports how many events and a bounded
    preview, declines when there are too many to state, and says when any account used cached or
    unavailable data; it is not released for live use yet, so messages still go to the main model.
  - `errors`: `classifier_gate_not_released` (`prerequisite`) with `remediationRef`.
  - `remediations`: `calendar.classifier_gate_unavailable` → "Nothing to do yet; the classifier gate
    is not switched on for any tool. Messages are answered by the main model." path
    `/settings?section=aiproviders`.
- **No `packages/shared/src/app-map-core.ts` change, deliberately.** The App Map Truthfulness rule
  puts module-owned behavior in the owning manifest's `features` (`docs/DEVELOPMENT_STANDARDS.md:61-64`),
  and the build merges manifest features/errors/remediations into the artifact
  (`scripts/build-app-map.ts:59-64`). No core screen or setting changed. The Classifier core help at
  `CORE_APP_SETTINGS.id="aiproviders"` describes a gate state that slice 1.2 owns and that does not
  exist yet, so writing about it now would be a map lie and would collide with that lane. The
  capability is declared once, truthfully, in the calendar manifest feature above.
- The UAT spec is named by plan section 2.3's exit ("tests/uat/specs/classifier-tool-menu.uat.spec.ts"),
  but the live gate cannot be asserted this slice (the menu wiring is 3.5). It asserts what IS
  reachable and honest now: installed Calendar module
  and `calendar/listVisibleEvents` route respond; the module settings screen loads; a chat turn still
  goes to the main model (no classifier request). If a chat-capable model is not configured on the
  UAT target, mark the chat assertion `test.fixme` with the #1121 reason (pattern:
  `.claude/skills/coordinate/uat-trigger-map.tsv:46-50`).
- Add trigger row: `packages/calendar/**` → `tests/uat/specs/classifier-tool-menu.uat.spec.ts`
  (blocking).

### Verification

```bash
pnpm test:uat -- classifier-tool-menu.uat.spec.ts > /tmp/cg23-uat.log 2>&1; echo "EXIT=$?"
```

Expected exit 0 through the real UI on a live dev instance, after the verify-gate procedure.
Attach the run, exit code and the bounded assertions to the PR as the live-path proof, and state that
the gated execution path itself is not proven here.

## Cross-cutting verification (PR gate)

```bash
pnpm typecheck > /tmp/cg23-typecheck.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/cg23-lint.log 2>&1; echo "EXIT=$?"
pnpm format:check > /tmp/cg23-format.log 2>&1; echo "EXIT=$?"
pnpm check:file-size > /tmp/cg23-filesize.log 2>&1; echo "EXIT=$?"
pnpm build:app-map > /tmp/cg23-appmap.log 2>&1; echo "EXIT=$?"
```

Each expected exit 0, each unpiped. Full suite through `scripts/run-gate.sh` (verify-gate skill) at
wrap-up; never bare, never piped.

## Determinism boundary

- The reply renders from the tool result record only; there is no model-authored text.
- The classifier supplies one window choice and nothing else; the raw message is never a tool input.
- The model's only jobs in this slice are the existing gate jobs (area pick, tool pick, argument pick);
  no prompt grows, and no default-model path changes.
- Every failure (missing result, overflow, cache-only, unknown window) is a decline to the main model.

## Out of scope

- Wiring the gate menu from installed manifests and any shadow/live execution (3.5, 4.1-4.3).
- `tasks.create`, integrations, lights and timers (ruling 2 explicitly defers them).
- The reply marker (superseded by ruling 11); the model activity log (3.6).

## Rulings ledger addition

| Fact or decision                                                                                                   | Evidence                                                                                          |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| The gate allows at most one `candidates` argument and passes the candidate's **id**, not extra fields, to the tool | `packages/chat/src/live/classifier-gate-arguments.ts:87`, `:129-135`                              |
| The gate's own fixture for the calendar case is a `window` enum plus a `{summary}` template                        | `tests/unit/chat-classifier-gate.test.ts:54-72`                                                   |
| A reply template cannot name an array element (`events[0]`) under the current SDK checker                          | `packages/module-sdk/src/classifier.ts:88` `PATH_SEGMENT`, `:105-113` `placeholderType`           |
| The gateway omits a declared-but-absent optional output key and throws on an absent required one                   | `packages/ai/src/gateway/output-validation.ts:139-153`                                            |
| The calendar tool's structural `sourceContext` interface drops `truncated` today                                   | `packages/calendar/src/tools.ts:100-110` vs `packages/connectors/src/source-context/types.ts:128` |
| `limit` default is 50 at the source but the tool advertises a hard max 20 for cross-tool use                       | `packages/connectors/src/source-context/calendar.ts:243`; `packages/calendar/src/manifest.ts:326` |
