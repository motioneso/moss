# Plan — #1869 date/time context and timezone-safe meal writes

**Task issue:** #1869 (bug, task, sev:major — Part of #926)
**Spec:** `docs/superpowers/specs/2026-08-30-1869-date-time-context.md` (approved 2026-08-30)
**Branch/worktree:** per fleet assignment; slices share one worktree and one PR (slices are
session-sized, not PR-sized).
**Size:** four build slices, each one agent session: 1, 2, 3A, 3B. Order: 1 first (kill gate),
then 2, 3A, 3B; 3B depends on 3A; 2 and 3A are independent of each other and of 1's outcome.

Slice 1 was reassessed for a split and stays one session: it adds one small pure module
(~40 lines), edits two existing files at already-cited seams, and extends two existing test
files — well inside one session; splitting it would separate the formatter from the only code
that calls it.

## Slice ownership (exclusive file sets — no two slices touch the same file)

| Slice | Files owned |
|---|---|
| 1 | `packages/chat/src/live/time-context.ts` (new), `packages/chat/src/live/engine-text.ts`, `packages/chat/src/live/chat-session-manager.ts`, `tests/unit/chat-engine-text.test.ts`, `tests/unit/chat-session-manager.test.ts` |
| 2 | `packages/chat/src/current-time-tool.ts` (new), `packages/chat/src/manifest.ts`, `packages/chat/src/index.ts`, `tests/unit/chat-current-time-tool.test.ts` (new) |
| 3A | `packages/module-sdk/src/time.ts`, `tests/unit/module-sdk-time.test.ts` |
| 3B | `external-modules/food/src/domain/meal.ts`, `external-modules/food/src/tools/meals.ts`, `external-modules/food/jarvis.module.json`, `tests/unit/external-module-food-handlers.test.ts`, `tests/unit/external-module-food-domain.test.ts` |

## Seams check (file:line citations, current `origin/main` @ e947239ea)

Chat turn path:

- `packages/chat/src/live/engine-text.ts:35-40` — `buildEngineText(deps, actorUserId, text,
  surface)` returns `{ text, pendingItems }`; `engine-text.ts:42-44` is the early return the spec
  names: when passive recall, cross-tool read, and notes retrieval are all absent it returns the
  raw user text, bypassing everything — including any time context added inside the try block.
- `engine-text.ts:46-49` — `getThreadContext` is already read (with `listPriorTurns`) when
  retrieval is configured; `engine-text.ts:51` already samples `new Date().toISOString()` for
  cross-tool reasoning; `engine-text.ts:143` prefixes hidden context blocks ahead of the user
  text; `engine-text.ts:144-145` — the catch returns raw text on any retrieval failure.
- `packages/chat/src/live/persistence.ts:402-420` — `getThreadContext` resolves
  `localTimezone` from the persisted actor locale (`localePreferences.get(scopedDb, "locale")` +
  `extractTimezone`), under the actor's scoped data context. This is the persisted-timezone
  authority the spec's decision 2 names.
- `packages/chat/src/live/chat-session-manager.ts:418-429` — `runTurn` calls `buildEngineText`
  with `this.deps.*`; `chat-session-manager.ts:550-552` — `recordTurn` persists the **original**
  `text`, not the engine text, so generated blocks are never stored or replayed. Replay uses
  stored messages (`listPriorTurns`, `chat-session-manager.ts:250`).
- `packages/chat/src/live/persona.ts:68-81` — `renderPersona` writes static persona text only
  (userName token substitution); nothing date-bearing exists in it today, and this plan adds
  nothing to it (prompt-cache discipline).
- Test seams: `tests/unit/chat-engine-text.test.ts` (buildEngineText behaviour) and
  `tests/unit/chat-session-manager.test.ts` (manager with fake engines capturing submitted engine
  text) both exist.

Clock tool path:

- `packages/chat/src/manifest.ts:202-210` — `chat.getCurrentView`: the exact built-in
  assistant-tool template (name, `permissionId: "chat.view"`, `risk: "read"`, empty strict
  `inputSchema`, `outputSchema`, `execute`). The new tool is a sibling entry.
- `packages/chat/src/current-view-tool.ts:86` — executor shape `ToolExecute = (scopedDb, input,
  ctx, services)`; exported via `packages/chat/src/index.ts:20`.
- `packages/module-sdk/src/index.ts:90-97` — `ToolContext.localTimezone?: string` (IANA, absent
  when no locale); populated by the gateway from the injected resolver
  (`packages/ai/src/gateway/gateway.ts:185-190`), which chat wires to the same locale preferences
  (`packages/chat/src/gateway-services.ts:221`). So the tool inherits decision 2's authority order
  with zero new plumbing.
- Result transport: gateway output-schema projection and the existing first-party MCP transport
  need no change for a plain structured result.

Time primitives and Food:

- `packages/module-sdk/src/time.ts` — `isValidTimeZone` (line 18), `localDayKey` (44),
  `timeZoneOffsetMinutes` (64, the proven `Intl` offset logic), `resolveLocalDay` (95). The new
  strict converter lives beside these. `packages/module-sdk/package.json:13` exports the `./time`
  subpath, and Food already imports through it
  (`external-modules/food/src/domain/meal.ts:13`), so no `index.ts` change is needed.
- `tests/unit/module-sdk-time.test.ts` — the existing SDK time test file; Slice 3A extends it.
- `external-modules/food/src/tools/meals.ts:255-257` — `resolveTimeZone(ctx, fromInput)` =
  `ctx.localTimezone ?? fromInput ?? "UTC"` (#1789's precedence, kept as is);
  `meals.ts:317-346` — `food.meals.log` parses `consumedAtRaw` with `new Date(consumedAtRaw)`
  (the defect: offset-less values are interpreted in the module process's timezone) and defaults
  to `new Date()` when omitted (kept, decision 10); `meals.ts:338` derives
  `resolveMealLocalDate(consumedAt, timeZone)`; idempotent `store.createMeal` at 341-351.
- `meals.ts:554-583` — `food.meals.correct`: same `new Date(consumedAtRaw)` defect; the
  no-zone-anywhere path falls back to the existing meal's stored `timezoneOffset` +
  `localDateAtFixedOffset` (comment at 555-559 explains why not UTC — preserved).
- `external-modules/food/src/domain/meal.ts:121` — `resolveMealLocalDate`, the module's existing
  wrapper over SDK time; the shared Food parser lives beside it.
- `external-modules/food/jarvis.module.json:176-181` and `:239-244` — `consumedAt` / `timeZone`
  input-schema entries for log and correct are bare `{"type":"string"}` today; descriptions go
  here (guard 1 of 4).
- `ModuleWorkerContext.localTimezone` reaches Food from the host: declared at
  `packages/module-sdk/src/worker.ts:97`, validated at `worker.ts:306-307`, resolved by the
  worker via `resolveLocalTimezone` (`apps/worker/src/worker.ts:472`,
  `apps/worker/src/external-module-invoke.ts:245`).
- Food test seams: `tests/unit/external-module-food-handlers.test.ts` (log/correct handlers,
  #1789 precedence), `tests/unit/external-module-food-domain.test.ts` (domain helpers).
  `tests/unit/external-module-food-manifest.test.ts` validates the manifest and must stay green
  after the schema-description edit (run as a gate in 3B, not edited by any slice).
- Dev-deploy trap (from memory, verified against `docs/DEVELOPMENT_STANDARDS.md` → "Redeploying an
  external module on dev"): editing `jarvis.module.json` changes the manifest/package hash, which
  disables the module on reconcile by design — redeploy on dev only via
  `scripts/redeploy-external-module.sh food`.

## Slice 1 — fresh `<current_time_context>` on every turn

**Files:** exactly the Slice 1 row of the ownership table.

New pure formatter in `packages/chat/src/live/time-context.ts` (deterministic, no I/O):

```ts
export function renderCurrentTimeContext(instant: Date, timezone: string | null): string;
```

Renders a bounded block: UTC ISO instant always; local date, local clock time, and UTC offset
minutes (derived via `@moss/module-sdk/time`) only when `timezone` is a resolvable IANA zone;
plus one fixed sentence stating the timestamp is authoritative for this turn and supersedes any
earlier date context. Total fixed guidance text stays well under the 150-word budget (target: two
sentences).

`buildEngineText` restructure (decisions, not bodies):

- `EngineTextDeps` gains optional `now?: () => Date` (defaults to `() => new Date()`); the
  existing `localNow` sample at `engine-text.ts:51` switches to it so one clock serves both uses.
- The instant is sampled and the block is rendered **before** the retrieval early-return and
  **outside** the retrieval try/catch: the no-retrieval return (`engine-text.ts:42-44`) becomes
  "time block + user text", and the catch (`engine-text.ts:144-145`) returns "time block + user
  text" — a retrieval or locale failure can remove the local representation, never the UTC
  instant (spec decisions 5-6).
- Timezone source: when retrieval runs, reuse the already-fetched `getThreadContext` result; when
  it does not, one standalone `getThreadContext` call wrapped in its own catch (failure →
  `timezone: null`). No new port is added.
- `ChatSessionManagerDeps` gains optional `now?: () => Date`, passed through to `buildEngineText`
  — this is the injectable clock seam the reused-session test drives.
- Persisted turn text is untouched: `recordTurn` already stores the original user text
  (`chat-session-manager.ts:550-552`); assert this stays true.

Tests (behaviour + why they would fail against a broken implementation):

1. With no retrieval deps at all, the returned text starts with the time block and ends with the
   user text — fails against current `main` (early return strips everything) and against any fix
   placed inside the try block.
2. With a retrieval dep that throws, the block survives — fails if the block is rendered inside
   the shared try/catch.
3. With `getThreadContext` rejecting, the block contains the UTC instant and no local date —
   fails if locale failure aborts the block or fabricates a local date.
4. Pure-formatter cases at a local-midnight boundary and across a DST transition with fixed
   inputs — fail if derivation uses process-local time instead of the supplied zone.
5. Manager-level reused-session test in `tests/unit/chat-session-manager.test.ts` (fake engine,
   existing pattern): two `runTurn` calls on one session with `now` advanced across the user's
   local midnight; the two submitted engine texts carry different, correct local dates, and no
   relaunch occurred — this is exit criterion 1 made deterministic; fails against any
   launch-time-only date mechanism.
6. Persona byte-stability: the persona content passed to `renderPersona` is identical across both
   turns of test 5 — fails if anyone routes time through the persona.

**Slice 1 verification (unpiped, expected exit codes):**

```bash
pnpm test:unit tests/unit/chat-engine-text.test.ts tests/unit/chat-session-manager.test.ts > /tmp/1869-s1-test.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
npx tsc --noEmit > /tmp/1869-s1-tsc.log 2>&1; echo "EXIT=$?"                                                                               # expect EXIT=0
npx eslint packages/chat/src/live/time-context.ts packages/chat/src/live/engine-text.ts packages/chat/src/live/chat-session-manager.ts tests/unit/chat-engine-text.test.ts tests/unit/chat-session-manager.test.ts --max-warnings=0 > /tmp/1869-s1-lint.log 2>&1; echo "EXIT=$?"  # expect EXIT=0
pnpm format:check > /tmp/1869-s1-fmt.log 2>&1; echo "EXIT=$?"                                                                              # expect EXIT=0
```

## Slice 2 — `chat.getCurrentTime` tool

**Files:** exactly the Slice 2 row of the ownership table; test file modeled on
`tests/unit/chat-response-style-tool.test.ts`.

Contracts in `packages/chat/src/current-time-tool.ts`:

```ts
export const chatGetCurrentTimeOutputSchema: /* strict object schema */;
export function createChatGetCurrentTimeExecute(now?: () => Date): ToolExecute;
export const chatGetCurrentTimeExecute: ToolExecute; // = createChatGetCurrentTimeExecute()
```

Output fields (spec decision 8, exactly): `utcInstant` (ISO string), `timezone` (effective IANA
zone; `"UTC"` when `ctx.localTimezone` is absent or invalid), `localDate` (`YYYY-MM-DD`),
`localTime` (`HH:mm:ss`, 24-hour), `utcOffsetMinutes` (integer). Derivation uses
`resolveLocalDay` / `timeZoneOffsetMinutes` / `isValidTimeZone` from `@moss/module-sdk/time`; the
executor samples `now()` once per invocation, touches no database table for time, performs no
network I/O, and caches nothing. Errors propagate as tool failures (never a cached or fabricated
value).

Manifest entry (sibling of `chat.getCurrentView`, `manifest.ts:202`): `name:
"chat.getCurrentTime"`, `permissionId: "chat.view"`, `risk: "read"`, empty strict `inputSchema`,
the output schema above, description of one to two sentences ("Read the server's current time and
the user's timezone... use when unsure of the current date or time") — this description is the
tool's entire prompt contract; no persona text is added. Export the executor from
`packages/chat/src/index.ts` beside the current-view export (`index.ts:20`).

Tests (`tests/unit/chat-current-time-tool.test.ts`, new):

1. Fake clock advanced between two calls returns two different `utcInstant` values — proves
   per-invocation sampling (exit criterion 4); fails against launch-time caching.
2. `ctx.localTimezone: "America/Los_Angeles"` at a fixed instant yields the known local
   date/time/offset — fails if derivation ignores the zone.
3. Absent/invalid `ctx.localTimezone` yields `timezone: "UTC"`, offset 0 — fails if the tool
   guesses or throws.

**Slice 2 verification (unpiped, expected exit codes):**

```bash
pnpm test:unit tests/unit/chat-current-time-tool.test.ts > /tmp/1869-s2-test.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
npx tsc --noEmit > /tmp/1869-s2-tsc.log 2>&1; echo "EXIT=$?"                                             # expect EXIT=0
npx eslint packages/chat/src/current-time-tool.ts packages/chat/src/manifest.ts packages/chat/src/index.ts tests/unit/chat-current-time-tool.test.ts --max-warnings=0 > /tmp/1869-s2-lint.log 2>&1; echo "EXIT=$?"  # expect EXIT=0
pnpm format:check > /tmp/1869-s2-fmt.log 2>&1; echo "EXIT=$?"                                            # expect EXIT=0
```

## Slice 3A — strict wall-clock conversion in the SDK

**Files:** exactly the Slice 3A row of the ownership table. No Food file is touched; the `./time`
subpath export already exists (`packages/module-sdk/package.json:13`), so nothing else changes.

SDK contract in `packages/module-sdk/src/time.ts` (beside `resolveLocalDay`, reusing
`timeZoneOffsetMinutes`, no new dependency):

```ts
export class LocalTimeConversionError extends Error {
  readonly kind: "invalid_format" | "nonexistent_local_time" | "ambiguous_local_time";
}
export function instantFromLocalWallClock(localDateTime: string, timeZone: string): Date;
```

Semantics (spec decisions 9 and 11): input is a strict offset-less ISO local date-time
(`YYYY-MM-DDTHH:mm[:ss[.sss]]`). Candidate instants are generated from plausible zone offsets and
verified by round-tripping through the existing `Intl` offset logic; exactly one surviving
candidate is returned. Zero candidates → `nonexistent_local_time` (DST spring-forward gap); two →
`ambiguous_local_time` (fall-back fold); syntax failure → `invalid_format`. No silent choice.

Tests (extend `tests/unit/module-sdk-time.test.ts`):

1. `("2026-08-22T20:14:00", "America/Los_Angeles")` → `2026-08-23T03:14:00.000Z` — fails if the
   process-local zone leaks in.
2. A positive-offset zone (e.g. `Asia/Tokyo`) and a `UTC`-zone input round-trip correctly —
   fails on offset-sign errors.
3. DST gap `("2026-03-08T02:30:00", "America/Los_Angeles")` throws `nonexistent_local_time`;
   fold `("2026-11-01T01:30:00", ...)` throws `ambiguous_local_time` — fail if either is silently
   resolved.
4. Malformed strings (`"yesterday"`, date-only `"2026-08-22"`, offset-bearing `"...Z"` input) and
   an invalid zone throw typed/bounded errors — fail if the function falls back to `new Date()`.

**Slice 3A verification (unpiped, expected exit codes):**

```bash
pnpm test:unit tests/unit/module-sdk-time.test.ts > /tmp/1869-s3a-test.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
npx tsc --noEmit > /tmp/1869-s3a-tsc.log 2>&1; echo "EXIT=$?"                                      # expect EXIT=0
npx eslint packages/module-sdk/src/time.ts tests/unit/module-sdk-time.test.ts --max-warnings=0 > /tmp/1869-s3a-lint.log 2>&1; echo "EXIT=$?"  # expect EXIT=0
pnpm format:check > /tmp/1869-s3a-fmt.log 2>&1; echo "EXIT=$?"                                     # expect EXIT=0
```

## Slice 3B — Food parser, log/correct wiring, manifest (depends on 3A)

**Files:** exactly the Slice 3B row of the ownership table. Do not start until 3A's verification
is green on the shared branch.

Food parser, shared by both write paths (decision 13), beside `resolveMealLocalDate`
(`domain/meal.ts:121`):

```ts
export function parseConsumedAtInstant(raw: string, effectiveZone: string): Date;
```

Dispatch: a `Z` or numeric-offset suffix → parse as exact instant (validity-checked; never
reinterpreted through the zone); offset-less ISO local → `instantFromLocalWallClock(raw,
effectiveZone)`; anything else → validation error. `LocalTimeConversionError` is translated to
Food's `InputError` with a bounded message naming the required fix (e.g. "supply an explicit UTC
offset").

Handler changes (decisions only):

- `food.meals.log` (`meals.ts:317-346`): omitted `consumedAt` keeps `new Date()` (decision 10);
  supplied `consumedAt` goes through `parseConsumedAtInstant` with the `resolveTimeZone` result.
  Derivation and persistence order unchanged: `resolveMealLocalDate(instant, zone)` then the
  single idempotent `createMeal` — parse failures occur before any write and create no row.
- `food.meals.correct` (`meals.ts:554-583`): supplied `consumedAt` goes through the same parser
  when an effective IANA zone exists (host locale, then input — the existing precedence at
  `meals.ts:560`). The existing no-zone-anywhere fallback to the stored meal's fixed offset is
  preserved (comment at 555-559); for offset-less input on that path the wall clock is converted
  with that fixed offset (a fixed offset has no DST, so the conversion is exact and unambiguous).
  `consumed_at`, `local_date`, and `timezone_offset` continue to be written together in one patch;
  description-only and item-only corrections still leave time fields untouched.
- `jarvis.module.json` (176-181, 239-244): add `description` strings to `consumedAt` and
  `timeZone` on both tools stating the contract with one worked example (offset-less local time +
  IANA zone → stored instant). This plus the tool description is the model-facing contract
  (guards 1-2 of 4); the strict parser is the boundary validator (guard 3); the returned meal
  record rendered back to the user is the per-item acceptance surface (guard 4). Bump the module
  version per its existing versioning convention;
  `tests/unit/external-module-food-manifest.test.ts` must stay green (run below, not edited).

Tests (each stated with the failure it catches):

1. Spec criterion 6 verbatim: log `consumedAt: "2026-08-22T20:14:00"` with effective zone
   `America/Los_Angeles` → stored instant `2026-08-23T03:14:00.000Z`, `localDate: "2026-08-22"`,
   offset `-420`. Fails against current `main` (value parsed in process-local time).
2. Criterion 7: the equivalent `...T20:14:00-07:00` and `...T03:14:00Z` inputs store the same
   instant — fails if offset-bearing input is reinterpreted through the zone.
3. Criterion 9: malformed strings, an invalid fallback zone, a DST-gap local time, and a DST-fold
   local time each raise a bounded validation error and write no row — fails if any path silently
   guesses.
4. Criterion 10: correct with the same offset-less input updates all three time columns together;
   a description-only correction leaves them untouched — fails if the parser is wired to log only.
5. Criterion 8 and 11: omitted `consumedAt` still stores the invocation instant; existing #1789
   precedence, UTC fallback, idempotency, and estimation tests stay green unmodified.

**Slice 3B verification (unpiped, expected exit codes):**

```bash
pnpm test:unit tests/unit/external-module-food-handlers.test.ts tests/unit/external-module-food-domain.test.ts tests/unit/external-module-food-manifest.test.ts > /tmp/1869-s3b-test.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
npx tsc --noEmit > /tmp/1869-s3b-tsc.log 2>&1; echo "EXIT=$?"                                      # expect EXIT=0
npx eslint external-modules/food/src/domain/meal.ts external-modules/food/src/tools/meals.ts tests/unit/external-module-food-handlers.test.ts tests/unit/external-module-food-domain.test.ts --max-warnings=0 > /tmp/1869-s3b-lint.log 2>&1; echo "EXIT=$?"  # expect EXIT=0
pnpm format:check > /tmp/1869-s3b-fmt.log 2>&1; echo "EXIT=$?"                                     # expect EXIT=0
```

## Determinism boundary

Every piece of time the user or model relies on renders from server-authored values: the per-turn
block and the tool result are computed by Moss code from its own clock and the persisted locale —
never from model output or web content. The model has exactly two jobs: (1) call
`chat.getCurrentTime` when it needs to re-check the time, (2) supply `consumedAt` when the user
states a meal time. Total new fixed guidance (time-block sentence + tool description + schema
descriptions) stays under the 150-word budget — if truthful behaviour seems to need more words,
the design is wrong; stop and revisit. Model-authored `consumedAt` crossing into user data has all
four guards, enumerated in Slice 3B. Personas stay byte-stable (Slice 1 test 6).

## Full gate

Before PR-ready (after 3B), the full isolated gate via the `verify-gate` skill only; expected
exit 0. Known local-only failure: module-sdk-worker tests fail locally and are green in CI — do
not bisect the branch over them.

## Live-path proof (exit criterion — user-facing, required before merge/Done)

On the live dev instance (`http://192.168.50.36:5173`), through the real UI, after redeploying
Food with `scripts/redeploy-external-module.sh food`:

1. Ask the assistant for the current date and time; evidence that `chat.getCurrentTime` was
   invoked and its answer matches the server clock and the user's timezone (bounded log/DOM
   evidence, no screenshots).
2. Log a meal stating a local time on the other side of the UTC day boundary from "now" (e.g. an
   evening Pacific time while UTC has rolled over); then verify in the database that the stored
   instant, `local_date`, and offset match the spec's criterion-6 arithmetic.
3. Start a fresh live conversation only if the drawer restored an old one — a restored
   conversation can answer from last run's transcript without doing the work (known trap).

Evidence posted as a `gh pr comment` per the Live-Path Gate. Exit criterion 1 (midnight rollover
in a reused session) is proven by the deterministic Slice 1 manager test; the live run proves the
assembled path, not the clock arithmetic.

## Release note

Category: Fixed. Title: "The assistant always knows today's date, and meals land on the right
day". Description: the assistant now gets the current date and time fresh on every message and can
check a reliable clock on demand, and meal times given as local times are now saved under the
correct day for your timezone.

## Kill gate

Slice 1 ships and is evaluated before Slices 2, 3A, and 3B are built. Ending observation: a live
dev conversation where the per-turn block degrades the assistant (echoing the block back,
misreading it as user text, or a measurable prompt-cache/latency regression traced to it), or any
persona byte-instability. Decision owner: Ben. If Slice 1 is killed, 3A+3B (meal write safety)
still stand on their own and proceed, and Slice 2's tool becomes the sole fresh-time source — Ben
decides scope at that point.

## Open questions

None blocking. One recorded decision beyond the spec's letter: `food.meals.correct`'s existing
stored-offset fallback (no zone anywhere) is preserved and made exact for offset-less input via
fixed-offset arithmetic, per the in-code rationale at `meals.ts:555-559`; the spec's
host > input > UTC order governs whenever any IANA zone exists.
