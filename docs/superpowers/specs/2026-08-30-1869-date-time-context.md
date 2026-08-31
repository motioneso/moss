# Date/Time Context and Timezone-Safe Meal Writes

Status: Approved by Ben — 2026-08-30
Date: 2026-08-30
Issue: #1869

## Context

Dogfood testing found four meals silently filed under August 23 although they were eaten on
August 22. Three independent failures aligned:

1. A CLI session received a date when it launched and kept that value for the life of the session.
   `ChatSessionManager.ensureSession` reuses the live engine, while `launchSession` resolves and
   writes the persona only at launch. A conversation that crosses midnight therefore cannot rely
   on launch context for “today.”
2. The assistant had no trustworthy way to recheck time. Web search can be unavailable, stale, or
   disconnected, and is the wrong authority for a fact the Moss server already knows. The existing
   assistant-tool gateway can expose a zero-network, read-only clock just like
   `chat.getCurrentView`.
3. Food resolves the user's timezone correctly after #1789, but parses every supplied
   `consumedAt` with `new Date(consumedAtRaw)`. An offset-less value such as
   `2026-08-22T20:14:00` is interpreted in the module process's timezone before the supplied IANA
   timezone is considered. The timezone currently affects only the derived `localDate` and stored
   offset; it does not turn the user's local wall-clock value into the intended instant.

The chat turn path already has most of the needed facts. `buildEngineText` reads the current thread
and persisted locale, and already creates `new Date().toISOString()` for cross-tool reasoning.
However, it returns the raw user text when all retrieval features are absent, and the generated
timestamp is never shown to the model as general turn context. Food already receives the
host-resolved IANA timezone as `ModuleWorkerContext.localTimezone` and already has canonical local
day/offset helpers in `@moss/module-sdk/time`; only its input interpretation is unsafe.

## Goals

1. Give every assistant turn a fresh, server-authored current instant and the user's current IANA
   timezone, without restarting the conversation.
2. Give the assistant an explicit read-only tool that returns the same facts at invocation time,
   without web access or cached search content.
3. Make Food persist the intended UTC instant when `consumedAt` is supplied as a local wall-clock
   value plus a timezone.
4. Preserve #1789's authority order: host-resolved user timezone first, tool-input timezone second,
   UTC only when neither exists.
5. Fail visibly on malformed or inherently ambiguous date/time input instead of silently filing a
   meal under a guessed instant.

## Non-Goals

- Repairing or replacing the CLI/MCP reconnect mechanism. A disconnected clock call may fail, but
  it must never return cached time; fresh per-turn context remains the primary guarantee.
- Using public web search, an external time API, or a new date/time dependency.
- Operating an NTP service or correcting the host operating system's clock.
- Changing how historical meals are re-bucketed. A meal's persisted `localDate` and offset remain
  fixed unless the user explicitly corrects its consumed time.
- Changing locale settings, browser timezone detection, Food's day-view design, nutrition
  estimation, or meal idempotency.
- Adding timestamps to persona files or other static prompt prefixes.

## Resolved Decisions

| # | Decision | Choice | Why |
| --- | --- | --- | --- |
| 1 | Clock authority | The Moss server's current clock at the moment a turn or clock-tool call is built | The server already owns execution time; web results add latency, caching, and availability failure modes. |
| 2 | Timezone authority | Persisted actor locale, then explicit tool input, then UTC only if neither exists | This preserves the live-verified #1789 contract: the host value is a user fact; model input is a fallback. |
| 3 | Dynamic assistant context | Prepend a small `<current_time_context>` block to every submitted user turn | A per-turn block naturally refreshes inside a reused engine and obeys prompt-cache discipline. |
| 4 | Persona handling | Keep personas byte-stable; do not add dates, clocks, counters, or session values | Dynamic persona content would invalidate provider prefix caching and would still go stale after launch. |
| 5 | Retrieval independence | Current-time context is produced even when passive recall, cross-tool reads, and notes retrieval are all disabled or return nothing | Time correctness cannot depend on optional retrieval configuration. The existing early return must not bypass it. |
| 6 | Context failure behavior | Always provide the fresh UTC instant; include a local representation only when the persisted timezone was resolved successfully | A missing locale may reduce convenience, but it must not produce a false local date. |
| 7 | Explicit clock tool | Add `chat.getCurrentTime`, a zero-input `risk: read` tool under `chat.view` | It reuses the existing built-in manifest/gateway seam, performs no network I/O, and either returns a fresh value or an explicit error. |
| 8 | Clock result | Return UTC ISO instant, effective IANA timezone, local calendar date, local clock time, and UTC offset minutes | These are sufficient for both “what time is it?” and for constructing an offset-bearing timestamp without model arithmetic guesses. |
| 9 | `consumedAt` contract | Accept either an ISO instant with `Z`/numeric offset, or an offset-less ISO local date-time interpreted in the effective IANA timezone | Offset-bearing input is already unambiguous; local input finally makes its supplied timezone operational rather than decorative. |
| 10 | Missing `consumedAt` | Continue using the module clock at invocation time | “Log this meal” should record the actual save instant without requiring the model to manufacture a timestamp. |
| 11 | DST ambiguity | Reject offset-less local times that do not exist or occur twice; require an explicit offset to disambiguate | Silent adjustment or an arbitrary earlier/later choice recreates the class of corruption this issue fixes. |
| 12 | Shared conversion logic | Put the strict local-wall-clock-to-instant conversion beside the existing timezone primitives in `@moss/module-sdk/time` and reuse the proven `Intl` offset logic | The SDK already owns module-safe local-day arithmetic. One canonical boundary is smaller and safer than another Food-only timezone algorithm. |
| 13 | Food correction parity | Apply the identical timestamp parser to `food.meals.log` and `food.meals.correct` | A correction must not reintroduce the same corruption through a sibling write path. |
| 14 | Persistence | Store `consumed_at` as the resolved instant, then derive and persist `local_date` and `timezone_offset` from that same instant and effective zone | All three columns describe one event and cannot drift apart. Existing read behavior stays unchanged. |

## Architecture

### Fresh context on every assistant turn

```text
real UI turn
  -> ChatSessionManager.runTurn
  -> buildEngineText
       -> read current persisted actor timezone
       -> read current server clock
       -> render bounded <current_time_context>
       -> append optional retrieval blocks
  -> submit context + user text to the existing live engine
  -> persist only the original user text and assistant reply
```

The block identifies its timestamp as authoritative for the current turn and says it supersedes
older launch/replay date context. It contains no private content beyond the user's own configured
timezone. It is generated outside the retrieval token budget so an empty or oversized retrieval
result cannot remove it. Sampling the UTC instant and rendering the mandatory block also sit outside
the optional retrieval failure boundary: a locale/retrieval read failure can remove the local
representation, never the fresh instant. Earlier dynamic blocks may remain in the live CLI
transcript, but every new turn carries a later authoritative value; Moss replay continues to use the
stored original user messages rather than persisting these generated blocks.

Clock access should use the existing injectable/runtime clock seam where the calling layer already
has one; the formatter itself remains a pure function of `(instant, timezone)` so midnight and DST
behavior can be tested deterministically.

### Explicit clock check

```text
assistant calls chat.getCurrentTime
  -> AssistantToolGateway resolves ToolContext.localTimezone
  -> chat manifest executor reads server clock once
  -> @moss/module-sdk/time derives local date/time and offset
  -> bounded structured result returns through the existing first-party MCP transport
```

The tool does not query a database for time, contact the web, cache results, or reuse the value from
session launch. A transport failure is returned as a failure. The assistant can still use the fresh
current-turn block, so a failed optional recheck does not force a stale web fallback.

### Timezone-safe Food write boundary

```text
food.meals.log / food.meals.correct
  -> choose effective zone (host locale > input > UTC)
  -> parse consumedAt
       Z/offset present -> exact instant
       no offset        -> strict local wall clock + effective IANA zone -> exact instant
       DST gap/fold     -> validation error requiring explicit offset
  -> resolveLocalDay(exact instant, effective zone)
  -> persist exact instant + local date + offset atomically
```

The converter validates syntax and round-trips candidate instants through `Intl.DateTimeFormat`.
Exactly one candidate is accepted. Zero candidates means a spring-forward gap; two candidates mean
a fall-back fold. This uses platform `Intl` and the module SDK's existing offset logic, with no new
dependency. An offset-bearing instant is never reinterpreted through the IANA zone; the zone is used
only to derive its persisted local date and offset.

Food's existing idempotency order remains untouched: parsing happens before the single create or
correction write, and retries still return the existing meal rather than creating another row.

## Exit Criteria

1. In one reused live engine session, two turns on opposite sides of the user's local midnight
   receive different, correct `<current_time_context>` values without a relaunch.
2. The context appears when all optional retrieval services are absent, and retrieval failure does
   not remove the fresh UTC instant.
3. Persona files and persona text remain byte-stable across turns; no dynamic timestamp is written
   to them.
4. `chat.getCurrentTime` returns a newly sampled UTC instant plus correct local date, local time,
   IANA timezone, and offset for the actor. Successive deterministic-clock calls prove it is sampled
   per invocation, not cached.
5. The clock tool performs no web request and a tool/transport failure never substitutes cached web
   content.
6. Logging `consumedAt: "2026-08-22T20:14:00"` in `America/Los_Angeles` stores
   `2026-08-23T03:14:00.000Z`, local date `2026-08-22`, and offset `-420`.
7. An equivalent `Z` or numeric-offset timestamp stores the same instant without reinterpretation.
8. Omitting `consumedAt` still stores the invocation-time instant and derives the actor's local day.
9. Invalid timestamps, invalid fallback IANA zones, DST gaps, and DST folds without an explicit
   offset fail with bounded validation errors and create/update no meal row.
10. `food.meals.correct` uses the same conversion and updates `consumed_at`, `local_date`, and
    `timezone_offset` together; description-only and item-only corrections retain the old time
    fields.
11. #1789's host-over-input precedence, UTC final fallback, idempotency, and meal estimation tests
    remain green.
12. The focused unit/integration checks plus the repository verification gate pass, and live-path
    evidence records a meal through the real UI near a UTC/local day boundary with the expected
    stored instant and local date before #1869 is closed.

## Hard Invariants Honored

- **Prompt-cache discipline:** dynamic time is an explicit turn block after launch, never persona
  or static context-file content.
- **Private by default / no admin bypass:** locale resolution stays inside the actor's existing
  scoped preference read. The clock tool exposes only that actor's timezone and public clock facts.
- **Secrets never escape:** neither context nor tool output contains credentials, tokens, prompts,
  or private records.
- **Module isolation:** Food receives time through `ModuleWorkerContext` and uses public
  `@moss/module-sdk/time` primitives; it does not query Chat, Settings, or host tables directly.
- **`AccessContext` remains unchanged:** no workspace, timezone, or clock field is added to it.
- **Provider-agnostic AI:** no model/provider behavior is assumed or hardcoded.
- **Metadata-only jobs:** no new job or payload is introduced.
- **Applied migrations remain immutable:** this design needs no schema change and edits no
  migration.
- **Live-path gate:** this user-visible data-integrity fix is not Done until the real UI path has
  executable evidence.
