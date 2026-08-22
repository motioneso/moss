# Plan: job-search board.tsx runtime-validates matches.list's wire shape

**Issue:** #1336 (bug tier, epic #1280, not blocking)
**Branch:** `1336-jobsearch-wire-validation` (already checked out)

## Problem, restated plainly

The board screen asks the server for the list of job matches and currently trusts whatever comes
back has every field it expects (id, title, company, fit, want, state, url, etc). It only checks
that the response is a list at all. If one row from the server is missing a field — most
concretely `url`, which becomes the "Open posting" link — the screen renders that row anyway, with
a blank/broken spot, and nothing tells anyone something is wrong.

## Scope decision

The issue's own body raises a wider design question — where should this module validate wire
shapes generally, across all its screens. That question is explicitly framed as bigger than a
one-off fix and is not required by this issue (epic #1280, "not blocking"). This plan scopes to
exactly what #1336 names: the `matches.list` response consumed by `board.tsx` (via
`read-board.ts`) and its concrete failure mode in `inspector.tsx`'s "Open posting" link.

`job-search.match.get` (`board.tsx:477-480`) has the same unchecked-cast pattern and is a natural
next case, but is out of scope here — left for a follow-up issue, consistent with
`docs/superpowers/specs/2026-08-16-post1632-groupC-nullable-object-output-schema.md` (#1337),
which is already working the server-side half of that exact call's output schema.

## Seams check

- `readWholeBoard` (`external-modules/job-search/src/web/read-board.ts:37-56`) is the only place
  that calls `job-search.matches.list` and builds the `BoardMatch[]` the whole board renders from.
  Confirmed: it only checks `Array.isArray(result?.items)` (line 45), no per-item check.
- `BoardMatch` fields are declared at `external-modules/job-search/src/web/board-types.ts:22-37`:
  `id`, `title`, `company` (strings), `fit`, `want` (`number | null`), `outsideFrame` (boolean),
  `state` (`MatchState` — one of `"unscored" | "new" | "seen" | "dismissed"`), `url`, `location`,
  `source` (strings), `postedAt` (`string | null`).
  `board-types.ts` is already imported by both `board.tsx` and `inspector.tsx` and is the shared
  home for this module's wire shapes, per its own file header — the natural place to add a
  validator so it never has to be duplicated in either screen file.
- `board.tsx:361-380`'s `readWholeBoardIntoState` already distinguishes "ready" from "error", and
  already renders a non-blocking notice keyed off a boolean the read function reports
  (`matchesState.truncated`, rendered at `board.tsx:854-858`). Adding a second boolean/count for
  "some rows were dropped for being malformed" follows an existing, working pattern rather than
  inventing a new one.
- `inspector.tsx:204` renders `href={match.url}` directly off the `BoardMatch` prop passed down
  from `board.tsx` — once `read-board.ts` only ever returns rows that passed validation,
  `inspector.tsx` needs no change: it can go on trusting its prop, which is now actually true.

## Design: filter invalid rows, don't fail the whole board

A response with 24 good rows and 1 malformed one should show 24 rows and say plainly that one
role couldn't be shown, not lose all 25 to one bad element, and not silently render the broken
row. This mirrors the existing `truncated` notice, which already tells the user something was
left off rather than pretending the count is exact.

## Task 1 — add the validator and wire it into the read path

**File:** `external-modules/job-search/src/web/board-types.ts`

Add, near the `BoardMatch` interface:

```ts
const MATCH_STATES: ReadonlySet<MatchState> = new Set(["unscored", "new", "seen", "dismissed"]);

/** True only when `value` has every field BoardMatch claims, with the right runtime type. This is
 * the module's one runtime check on job-search.matches.list's wire shape (#1336) — every field is
 * required and type-checked; nothing here guesses or substitutes a default for a missing field,
 * because a substituted default would hide the exact drift this check exists to catch. */
export function isBoardMatch(value: unknown): value is BoardMatch {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.company === "string" &&
    (typeof v.fit === "number" || v.fit === null) &&
    (typeof v.want === "number" || v.want === null) &&
    typeof v.outsideFrame === "boolean" &&
    typeof v.state === "string" &&
    MATCH_STATES.has(v.state as MatchState) &&
    typeof v.url === "string" &&
    typeof v.location === "string" &&
    typeof v.source === "string" &&
    (typeof v.postedAt === "string" || v.postedAt === null)
  );
}
```

**File:** `external-modules/job-search/src/web/read-board.ts`

Change `BoardPageResult` to also report a count of dropped rows, and filter each page through
`isBoardMatch`:

```ts
export interface BoardPageResult {
  readonly items: BoardMatch[];
  readonly truncated: boolean;
  /** Rows the server sent that didn't have the shape BoardMatch requires — dropped, not
   * rendered broken (#1336). Zero on every normal read. */
  readonly invalidCount: number;
}
```

In `readWholeBoard`, replace the current unchecked cast:

```ts
const rawBatch = Array.isArray(result?.items) ? result!.items : [];
const batch = rawBatch.filter(isBoardMatch);
invalidCount += rawBatch.length - batch.length;
```

accumulate `invalidCount` across pages, and return it alongside `items`/`truncated` in both the
early return and the `truncated: true` fallthrough at the end of the loop.

**Test file:** `tests/unit/job-search-web-board.test.tsx` (existing `matches.list` mocking already
present at line ~139 and ~664) — add cases:

1. A response with one row missing `url` (string field absent) — asserts the returned `items`
   array excludes that row, and `invalidCount` is 1. Fails today because the row currently passes
   through with `url: undefined`.
2. A response with one row whose `state` is an unrecognized string — same assertion. Fails today
   for the same reason.
3. A response where every row is well-formed — asserts `invalidCount` is 0 and behavior is
   unchanged, guarding against a validator that's too strict.

## Task 2 — surface the drop to the person using the board

**File:** `external-modules/job-search/src/web/screens/board.tsx`

- Extend `MatchesState`'s `"ready"` branch with `invalidCount: number`, set from
  `readWholeBoard`'s new return field at `board.tsx:365-366`.
- Next to the existing `matchesState.truncated` notice (`board.tsx:854-858`), add a sibling notice
  rendered when `matchesState.invalidCount > 0`, reusing the same `jsm-queue-notice`/`role="status"`
  pattern:
  `${invalidCount} role(s) couldn't be shown — the server sent something the board didn't
recognize.` (singular/plural handled the same way the existing "new role(s)" search-finished
  copy already does at `runNotice`'s `"finished"` case, `board.tsx` ~line 215).

**Test file:** `tests/unit/job-search-web-board.test.tsx` — one case asserting the notice text
renders when `readWholeBoard` reports `invalidCount > 0`, and does not render when it's 0.

## Verification

```bash
pnpm --filter <job-search-web-test-target-or-root> vitest run tests/unit/job-search-web-board.test.tsx > /tmp/1336-unit.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, including the new cases.

```bash
pnpm format:check > /tmp/1336-format.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/1336-lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/1336-typecheck.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0` on all three.

Full gate before wrap-up per the `verify-gate` skill (not run ad hoc).

## Live-path proof

This is a rendering-path change with no way to make the real server send a malformed row on
demand. Proof plan: run the app on the dev instance, open the job-search board with real data
(unchanged rows — proves no regression), and separately run the new unit tests showing the dropped
row and the notice, with output pasted on the PR. If a live malformed-row scenario can be staged
cheaply (e.g. a temporary local mock), do that too; otherwise state plainly that the malformed-row
path is unit-proven, not live-proven, and that the unaffected-board path is live-proven.

## Kill gate

Single small task, one phase. If the validator's false-positive rate turns out non-zero against
real data (a legitimate row gets dropped), that's the stop condition — check by running against a
live board before merging, not just synthetic test fixtures.

## Not in scope (named, not silently dropped)

- `job-search.match.get` / `MatchDetail` validation — same pattern, different call site
  (`board.tsx:477-480`), left for a follow-up issue.
- Any other module screen's `invokeTool`/`runQueue` call sites (`profile.tsx`, `use-search-run.ts`,
  `settings.tsx`, etc) — the issue's own "design question" section names this as needing its own
  decision, not a side effect of #1336.
- `job-search.match.get` / `MatchDetail` validation is tracked as its own issue: #1835.

## Coordinator additions (2026-08-22, approved with these conditions)

- A dropped row is not just quietly filtered — the board must visibly say a count of rows it
  could not show, so nobody loses sight of a real match. (Task 2's notice already covers this;
  restated here because it's load-bearing, not optional polish.)
- A dropped row must be logged with enough detail to diagnose which field was wrong, on the
  server side, without ever putting the row's actual content (title, company, url, etc) in that
  log. See Task 3.
- One malformed row must never blank the whole board — already true by construction (Task 1
  filters per-row, the rest of the page still renders).

## Task 3 — server-side diagnosable log, no content

Researched: there is no client-to-server error-reporting call anywhere in this repo (checked
`external-modules/*/src/web`, `packages/shared`, `apps/web`) — building one is new infrastructure,
out of scope for this issue. There is also no logger available on `ModuleWorkerContext`, and
`createModuleLogger` (`packages/module-sdk/src/logger.ts`) needs a host `FastifyBaseLogger` no
module worker process currently receives — wiring that is also out of scope here.

What already exists and already reaches a real server-side log: `packages/module-sdk/src/worker.ts:332`'s
own `console.error` on a failed handler — the file's own comment confirms stderr is captured by
the host runtime, redacted for known secrets, and logged as "external module worker output". This
is the sanctioned diagnostic channel a module has today.

**File:** `external-modules/job-search/src/worker/handlers/matches.ts`

Right now `createMatchesListHandler` builds each `BoardMatch` from `match` + `posting` and trusts
the DB-sourced posting fields (`title`, `company`, `url`, `location`, `source`) are non-empty
strings — if one of them were ever null/empty at the database layer despite the type saying
`string`, today's code either renders a blank cell (falsy-but-truthy-typed value) or throws inside
`truncateText` and fails the whole page. Add one check between building a row and pushing it:

```ts
const REQUIRED_NONEMPTY_FIELDS = ["id", "title", "company", "url", "location", "source"] as const;
const KNOWN_STATES: ReadonlySet<string> = new Set(["unscored", "new", "seen", "dismissed"]);

/** Field names only — never call this with anything that logs the item itself. */
function malformedBoardMatchFields(item: BoardMatch): string[] {
  const bad: string[] = [];
  for (const field of REQUIRED_NONEMPTY_FIELDS) {
    if (typeof item[field] !== "string" || item[field].length === 0) bad.push(field);
  }
  if (!KNOWN_STATES.has(item.state)) bad.push("state");
  return bad;
}
```

In the build loop, after constructing `item` and before `items.push(item)`:

```ts
const badFields = malformedBoardMatchFields(item);
if (badFields.length > 0) {
  // #1336: field names only, never posting/job content (title, company, url, etc) — the
  // point of this log is diagnosing which field drifted, not a second copy of private data.
  console.error(
    `job-search matches.list: dropping match ${item.id} — invalid fields: ${badFields.join(", ")}`
  );
  continue;
}
items.push(item);
```

This is defense in depth alongside Task 1's client-side check, not a replacement for it — the
client check is the one guaranteed to catch drift introduced anywhere between this handler and the
browser (schema/output-sanitization layer included), which this server-side check cannot see.

**Test file:** `tests/unit/job-search-match-handler.test.ts` — one case with a posting whose
`location` is an empty string (store test double), asserting: the row is excluded from `items`,
`console.error` was called exactly once, its message contains the match id and `"location"`, and
does **not** contain the posting's title/company/url. Fails today because the row is currently
either pushed with the empty field or crashes the handler.
