# #1707 — Cross-Conversation History Search

**Date:** 2026-08-19

**Status:** Draft — pending Ben's approval

**Issue:** [#1707](https://github.com/motioneso/moss/issues/1707)

## Context

Moss's assistant can only see today's conversation history. The one relevant tool,
`chat.listTodaysTurns` (`packages/chat/src/tools.ts`), has no date-range input at all: it scans the
20 most-recently-active threads, pulls every turn from the last 36 hours, and returns at most 40
turns. A user cannot ask "what did we discuss last week about X" — that history is invisible past
the current day.

`chat.listTodaysTurns` is also not a clean "today" filter in isolation. Its 36-hour window
deliberately over-includes turns so it never drops something from the current local day; the
authoritative narrowing happens downstream, in three separate callers that each apply their own
`withinLocalDay` filter (from `packages/briefings/src/compose-shared.ts`) against the tool's
`createdAt` field:

- `packages/briefings/src/compose.ts` (morning briefing "THE DAY'S CHATS" section)
- `packages/briefings/src/compose-evening.ts` (evening briefing "THE DAY'S CHATS" section)
- `packages/briefings/src/routes.ts` (evening briefing's default tool list, `defaultToolNamesFor`)

None of these three carries a timezone into the tool itself — the tool's 36-hour window is a
timezone-agnostic guess, and each caller narrows to the right local day afterward. The tool's
20-thread scan cap and 40-turn result cap are both sized for that narrow window; they are too small
and the wrong shape for scanning weeks or months of history.

Given this, extending `chat.listTodaysTurns` with a date range is not a one-line widen. Reusing its
scan cap, its result cap, or its windowing logic risks breaking the three existing callers' local-day
filtering, which depends on the tool over-including rather than precisely bounding.

## Goals

1. Let the assistant search a user's own chat history across an explicit date range, not just today.
2. Take an explicit timezone as input, rather than guessing or over-including like the current tool.
3. Return enough of a turn (role, excerpt, thread title, timestamp) for the assistant to answer "what
   did we discuss about X" without a second lookup.
4. Keep the existing `chat.listTodaysTurns` tool and its three callers unmodified and unaffected.

## Non-Goals

- Full-text/semantic search ranking across chat history. This spec scopes to a bounded date-range
  fetch, not a search-relevance engine.
- Automated end-of-conversation summaries written into the vault. The issue names this as a possible
  alternative mechanism; per the issue's own scope note, that is a separate decision this spec does
  not re-litigate or design.
- Changing `chat.listTodaysTurns`, its 36-hour window, its scan/result caps, or any of its three
  callers.
- Cross-user search. History search stays scoped to the requesting actor's own threads.
- Searching incognito threads. The existing tool skips them; the new tool does too.
- A dedicated chat-history UI surface. This is an assistant tool, matching how the existing today-tool
  is exposed.

## Resolved Decisions

| Decision                      | Choice                                                                                   | Reason                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Approach                      | Add a new tool, `chat.searchHistory`, rather than extend the existing tool               | Reusing the existing tool's window/cap logic risks the three callers whose day-filtering depends on it.   |
| Input shape                   | Explicit `startDate`, `endDate` (inclusive, local calendar dates) and `timeZone` (IANA)  | The current tool has no timezone input at all; explicit input removes the need to over-include and guess. |
| Scope                         | Requesting actor's own non-incognito threads only                                        | Matches the existing tool's actor- and incognito-scoping; no new privacy surface.                         |
| Caps                          | New, independently-sized scan and result caps, not reused from `chat.listTodaysTurns`    | The existing caps (20 threads, 40 turns) assume a 36-hour window; a multi-day range needs its own sizing. |
| Relationship to existing tool | `chat.listTodaysTurns` is left as-is; its three callers are out of scope for this change | Isolates this feature from an already-fragile-by-design tool without a full audit of those callers.       |

## Architecture

### New tool: `chat.searchHistory`

Add a new assistant tool alongside `chatListTodaysTurnsExecute` in `packages/chat/src/tools.ts`,
registered in `packages/chat/src/manifest.ts` next to the existing `chat.listTodaysTurns` entry, with
the same `permissionId: "chat.view"` and `risk: "read"`.

**Input:**

- `startDate` — required, `YYYY-MM-DD`, local calendar date.
- `endDate` — required, `YYYY-MM-DD`, local calendar date, inclusive, must be on or after `startDate`.
- `timeZone` — required, IANA timezone name, used to convert the local calendar range into the UTC
  instant bounds applied to `created_at`.
- `query` — optional free-text substring to filter turn bodies. Out of scope to make this fuzzy or
  ranked; a bounded substring/ILIKE-style filter is enough for the MVP.

**Behavior:**

- Reject a range wider than a fixed maximum (proposed: 90 days) with a clear tool error, rather than
  silently truncating — the assistant should tell the user to narrow the range.
- Scan threads by activity (`listThreadsByActivity`, or a repository method that accepts a bound
  appropriate to a multi-day range) up to a new, independently-tuned scan cap. This cap should be
  proven against realistic multi-week thread volume, not copied from `MAX_THREADS_SCANNED = 20`.
- Skip incognito threads and non-`stored` messages, matching the existing tool.
- Filter turns to those whose `created_at`, converted via `timeZone`, falls within
  `[startDate, endDate]` inclusive.
- Return a new, independently-tuned result cap (not the existing `MAX_TURNS = 40`), plus a signal in
  the response indicating whether the result was capped, so the assistant can tell the user results
  may be incomplete and suggest narrowing the range.
- Turn shape mirrors the existing tool's output: `role`, `excerpt` (same `EXCERPT_CHARS` truncation
  behavior or its own constant), `threadTitle`, `createdAt`.

### Relationship to `chat.listTodaysTurns` and its callers

No changes to `packages/chat/src/tools.ts`'s existing export, `packages/chat/src/manifest.ts`'s
existing `chat.listTodaysTurns` entry, or the three current callers
(`packages/briefings/src/compose.ts`, `compose-evening.ts`, `routes.ts`). This spec's tool is
additive.

If a future spec wants briefings or another caller to use `chat.searchHistory` instead of
`chat.listTodaysTurns`, that requires its own review of those three callers' `withinLocalDay`
assumptions — explicitly out of scope here.

## Security and Privacy

- Scoped to the requesting actor's own threads via the same `scopedDb` mechanism the existing tool
  uses; no cross-user access.
- Incognito threads remain excluded, matching current behavior.
- No new persisted data, no schema/migration change — this tool only reads existing chat tables.
- The optional `query` filter must be applied through parameterized queries, never string-interpolated
  SQL.
- Response payload is chat content already visible to the user in-app; no additional redaction beyond
  what the existing tool applies (turn excerpts, not full bodies with attachments).

## Open Questions

1. What should the maximum date-range width and the new scan/result caps actually be? This spec
   proposes 90 days and flags that the caps need sizing against real thread volume, but the exact
   numbers need a decision (or an experiment) before or during implementation.
2. Should `chat.searchHistory` support an unbounded end date (e.g. "everything since `startDate`,
   through now") as well as a closed range, or is a closed range sufficient for the assistant's
   actual use cases?
3. Does the assistant need a distinct "no results in range" vs. "range too wide, narrow it" response,
   or is a single capped/error response enough for the MVP?
4. Is the optional `query` substring filter worth including in the MVP, or should the first version
   ship as a pure date-range fetch with filtering left to the assistant's own reasoning over returned
   turns?
5. Should this spec's tool eventually replace `chat.listTodaysTurns` inside the three briefing
   callers (making "today" just a one-day range), or should the two tools stay permanently separate?
   This spec takes no position beyond noting the callers need their own review first.

## Verification

### Focused automated checks

1. `chat.searchHistory` returns only turns whose `created_at` falls within the requested
   `[startDate, endDate]` range once converted through the supplied `timeZone`, excluding turns
   outside it.
2. Incognito threads and non-`stored` messages are excluded, matching `chat.listTodaysTurns`.
3. A range wider than the configured maximum is rejected with a clear tool error rather than silently
   truncated.
4. Results are capped at the tool's own result cap, with a capped-results signal present when the cap
   is hit.
5. The tool is scoped to the requesting actor only — a second actor's threads are never returned.
6. `chat.listTodaysTurns` and its three existing callers pass their current test suites unmodified,
   proving no regression from adding the new tool.

### Required live-path proof

On the exact implementation head, exercise the assistant with a request that requires history from a
prior day (for example, "what did we discuss three days ago about X" where a matching turn was seeded
outside today's window). Confirm the assistant's response reflects turns returned by
`chat.searchHistory` rather than `chat.listTodaysTurns`, and that a request for a too-wide range
produces the tool's rejection rather than a silent truncation. Record the exact exit code and teardown
evidence on the PR.

## Exit Criteria

- `chat.searchHistory` exists as a registered assistant tool, scoped to the requesting actor's own
  non-incognito threads, taking explicit `startDate`, `endDate`, and `timeZone` input.
- The tool uses its own scan cap and result cap, independent of `MAX_THREADS_SCANNED` and `MAX_TURNS`
  in `chat.listTodaysTurns`.
- `chat.listTodaysTurns` and its three callers (`compose.ts`, `compose-evening.ts`, `routes.ts`) are
  unchanged and their existing tests remain green.
- A too-wide date range is rejected with a clear error rather than silently truncated.
- Focused tests, repository static checks, CI, and the live-path proof above are green.

## Hard Invariants Honored

- Spec before build: this document must be approved before an implementation plan is written.
- Private by default: the tool is scoped to the requesting actor's own non-incognito history; no
  cross-user access is introduced.
- Module isolation: the new tool lives inside the chat module alongside its existing tools and
  repository, with no new cross-module table access.
- No admin bypass, no new secret handling, no migration, no pg-boss payload change.
