# Plan — chat transcript archive, backend half (#1951)

Spec: comment starting `SPEC` on issue #1951 (first slice of #1368). Parent spec: comment
starting `SPEC` on issue #1368. Prior seam research: relay handoff at
`fleet-lane-1368` worktree, `docs/superpowers/plans/1368-relay-handoff.md` (all facts below
re-verified live on this branch before writing this plan; drift noted where found).

**Scope for this slice**: backend only. No settings UI (that is a separate issue). No
reconciliation-on-enable job (not in #1951's own spec text — only in the parent's; deferred to
whichever slice adds the settings UI, since only that slice makes "turn on mid-day" reachable by a
real user).

## Determinism boundary

No model call anywhere in this slice. Every write is a pure function of stored data: which
messages exist, in what order, for which user, on which day. No AI-authored content, no chat
turn injected by this code. Nothing here needs the four-guard model-boundary treatment.

## Verified seams (file:line, re-checked live on this branch, 2026-08-25)

- Settings preference pattern: `packages/settings/src/yolo-routes.ts` (`registerYoloRoutes`,
  line 26) — GET/PUT via `ProfilePreferencesPort.get`/`.upsert`, plain string preference keys, no
  schema migration.
- Route schema pattern: `packages/shared/src/yolo-api.ts` (DTOs + AJV schemas,
  `additionalProperties: false`).
- Registration site: `packages/settings/src/routes.ts:254` (`registerNotesSourceRoutes` call) —
  add `registerChatArchiveRoutes` the same way, imported at top with the others (line ~50-51).
- Chat-turn hook point: `packages/chat/src/live/persistence.ts:293-308` — existing
  `if (this.boss && result && !thread.incognito) { ... sendJob(...) ... }` block inside
  `recordTurn`. Add a third `sendJob` call here, gated on the archive-enabled preference.
- Generic preferences port already available in that class: `localePreferences?: PreferencesPort`
  (`persistence.ts:72`, wired in `packages/module-registry/src/index.ts:1558` as
  `new PreferencesRepository()` — this is the same key-agnostic repository used for the `"locale"`
  key at `persistence.ts:390`). No new constructor dependency needed — read
  `"chat-archive.enabled"` / `"chat-archive.folder"` off the same port.
- Local-day derivation: `packages/shared/src/time.ts:54` `localDay(input, timeZone)` — "the only
  sanctioned way to derive a calendar day from an instant" (its own doc comment). Timezone via
  `extractTimezone` (`packages/chat/src/locale-utils.ts:4`), same pattern already used at
  `persistence.ts:395`.
- Incognito / stored-turn filter: `packages/chat/src/repository.ts:41`
  (`.where("incognito", "=", false)`), `status: "stored"` set at lines 231/243. No existing method
  lists messages across threads by date — new repository method needed.
- pg-boss job pattern: `packages/chat/src/jobs.ts:44-59` (`CHAT_EMBED_TURN_QUEUE`,
  `CHAT_QUEUE_DEFINITIONS`, `EmbedTurnJobPayload extends ActorScopedJobPayload`),
  `registerChatJobWorkers` at line 301, `registerDataContextWorker` calls at 315+. Wired into
  `packages/module-registry/src/index.ts:1529` (`queueDefinitions: CHAT_QUEUE_DEFINITIONS`) — no
  module-registry edit needed beyond extending `CHAT_QUEUE_DEFINITIONS`.
- Payload allowlist: `packages/jobs/src/pg-boss.ts:86-99` `ALLOWED_PAYLOAD_KEYS` — a fixed set;
  `assertMetadataOnlyPayload` (line 135) throws on any key outside it. Must add `"localDate"`.
- Notes-source resolution + path safety: `packages/notes/src/write-tools.ts` — `resolveSource`
  (line 68, currently private, throws `HttpError(409, ...)` if no Notes source configured),
  `assertInside`/`recheckInside` (lines 96/104, private, TOCTOU-safe via
  `packages/notes/src/path-guard.ts`), full-overwrite branch pattern at lines 204-211
  (`recheckInside` then `writeFile(file, content, "utf-8")`), folder auto-create via
  `mkdir(dirname(file), { recursive: true })` (line ~200-202).
- Notes-sync enqueue after write: `packages/notes/src/notes-sync-routes.ts:45`
  (`sendJob(dependencies.boss, NOTES_SYNC_QUEUE, payload, ...)`) — the raw job-based call to reuse
  directly from a worker (not a tool call, no `ToolServices` object available).
- Module isolation direction: `packages/chat/package.json` already depends on `@moss/notes`
  (confirmed in `dependencies`); `packages/notes/package.json` does **not** depend on `@moss/chat`.
  So the archive worker (needs `ChatRepository`) must live in `packages/chat`, and it calls a
  writer function **exported from `@moss/notes`'s public API** (`packages/notes/src/index.ts`) to
  do the actual vault write. Notes never reaches into chat's tables — chat reaches into notes'
  declared API, same direction as the existing `NotesSyncToolService` / `NotesRecallPort` seams.

## Open design decision: file-collision fallback naming

Resolved here (was flagged unresolved in the #1368 handoff):

- Primary deterministic path: `<folder>/<YYYY-MM-DD>.md`.
- Every file this writer creates starts with a marker line: `<!-- moss-chat-archive:v1 -->`
  (first line, exact string). A rebuild reads the existing file's first line before overwriting;
  if it matches, the file is Moss's and gets overwritten. If the primary path exists with a
  different (or missing) first line, it is a real user file — leave it untouched and write to the
  fallback path instead: `<folder>/<YYYY-MM-DD> (moss).md`, itself marker-checked the same way.
- If the fallback path is *also* occupied by a non-marker file, the job throws (surfaces in
  pg-boss's own failure/retry accounting — no unbounded suffix search). This is a real but rare
  edge case (two independent naming collisions same day); acceptable for phase 1, not silently
  swallowed.

## Tasks

### 1. `packages/shared/src/chat-archive-api.ts` (new file)
- `export interface ChatArchiveSettingsResponse { readonly enabled: boolean; readonly folder: string }`
- `export interface PutChatArchiveSettingsRequest { readonly enabled: boolean; readonly folder: string }`
- `export function validateChatArchiveFolder(input: unknown): string` — pure, no I/O. Rejects:
  non-string, empty, leading `/`, any path segment equal to `..`, embedded null byte, trailing
  whitespace-only. Allows nested folders. Throws `Error` with a plain-English message on
  rejection (caller wraps in `HttpError(400, ...)` at the route; the writer calls it defensively
  before writing and treats a thrown error as "no-op, do not write" rather than crashing the
  worker).
- `export const getChatArchiveSettingsRouteSchema = {...} as const` /
  `export const putChatArchiveSettingsRouteSchema = {...} as const` — copy the shape of
  `getYoloSettingsRouteSchema`/`putYoloSelfRouteSchema` (`additionalProperties: false`,
  `errorResponseSchema` reuse).
- Test: `tests/unit/chat-archive-folder-validation.test.ts` — cases: default `"Moss/Chats"` valid,
  nested valid, leading slash rejected, `..` segment rejected, empty rejected, null byte rejected.
  Each case would fail against a validator that only checks non-empty (i.e. assert the specific
  rejection reason surfaces, not just "throws").

### 2. `packages/settings/src/chat-archive-routes.ts` (new file)
- `export const CHAT_ARCHIVE_ENABLED_PREF_KEY = "chat-archive.enabled"`
- `export const CHAT_ARCHIVE_FOLDER_PREF_KEY = "chat-archive.folder"`
- `export const CHAT_ARCHIVE_DEFAULT_FOLDER = "Moss/Chats"`
- `export function registerChatArchiveRoutes(server: FastifyInstance, deps: { dataContext: DataContextRunner; resolveAccessContext: (req: FastifyRequest) => Promise<AccessContext>; preferencesRepository: ProfilePreferencesPort }): void`
  - `GET /api/me/chat-archive` → `{ enabled: pref ?? false, folder: pref ?? CHAT_ARCHIVE_DEFAULT_FOLDER }`.
  - `PUT /api/me/chat-archive` → validate `folder` via `validateChatArchiveFolder` (400 on
    reject), upsert both keys, return the new state (same read-back pattern as
    `registerYoloRoutes`'s PUT).
- Register in `packages/settings/src/routes.ts:254` area:
  `registerChatArchiveRoutes(server, { ...dependencies, preferencesRepository });`
- Test: `tests/unit/settings-chat-archive-routes.test.ts` (model:
  `tests/unit/settings-yolo-routes.test.ts`) — cases: GET with no prior PUT returns
  `{ enabled: false, folder: "Moss/Chats" }` (off-by-default); PUT with a bad folder returns 400
  and does not write either preference key; PUT with a good folder persists both keys and GET
  reflects them.

### 3. `packages/notes/src/write-tools.ts` (edit — export three existing private functions)
- Change `function resolveSource` → `export async function resolveSource` (line 68, no behavior
  change).
- Change `function assertInside` → `export function assertInside` (line 96).
- Change `function recheckInside` → `export async function recheckInside` (line 104).
- Add these three to the `export { ... } from "./write-tools.js"` block in
  `packages/notes/src/index.ts`.
- No new test — behavior-preserving export change; existing `tests/integration/notes-write-tools.test.ts`
  covers the underlying behavior and must stay green.

### 4. `packages/notes/src/daily-archive-writer.ts` (new file)
- `export interface ChatArchiveSession { readonly threadId: string; readonly messages: readonly ChatArchiveMessage[] }`
- `export interface ChatArchiveMessage { readonly role: "user" | "assistant"; readonly body: string; readonly createdAt: string }`
- `export interface WriteDailyChatArchiveResult { readonly written: boolean; readonly path: string | null; readonly reason?: "no-notes-source" | "no-sessions" | "bad-folder" }`
- `export async function writeDailyChatArchive(scopedDb: DataContextDb, actorUserId: string, localDate: string, folder: string, sessions: readonly ChatArchiveSession[], notesSync: NotesSyncToolService): Promise<WriteDailyChatArchiveResult>`
  - No sessions → `{ written: false, reason: "no-sessions" }`, no I/O (off-by-default and
    empty-day cases both land here).
  - `validateChatArchiveFolder(folder)` throws → `{ written: false, reason: "bad-folder" }`
    (defense in depth; the settings route already rejects bad folders at write time, this
    protects against a value written before the validator existed or edited directly in the DB).
  - `resolveSource(scopedDb)` throws (no Notes source) → catch, `{ written: false, reason: "no-notes-source" }`
    — "leave the completed chat turn intact while exposing only bounded owner-visible status" per
    parent spec; never throws the job into a failed/retried state for a config problem.
  - Otherwise: build Markdown (marker line, then one `## <session start time>` heading per
    session in array order, then each message as `**<role>:** <body>` in array order — the caller
    is responsible for chronological ordering, this function does not sort), resolve the primary
    then fallback path per the collision rule above (reading existing file's first line for the
    marker check), `mkdir(dirname(file), { recursive: true })`, `assertInside` + `recheckInside`,
    `writeFile`, then `notesSync.enqueue(actorUserId, sourcePath)`.
- Export from `packages/notes/src/index.ts`.
- Test: `tests/unit/daily-archive-writer.test.ts` (real temp dir as the Notes root, no DB) —
  cases: single session writes marker + heading + messages; two sessions in given order both
  appear, session order preserved; empty `sessions` array writes nothing; missing Notes source
  (mock `resolveSource` to throw) returns `no-notes-source` and touches no file; primary path
  occupied by a marked Moss file gets overwritten; primary path occupied by an unmarked foreign
  file is left untouched and fallback path is used; both primary and fallback occupied by foreign
  files throws.

### 5. `packages/chat/src/repository.ts` (edit — add one method)
- `async listStoredMessagesInRange(scopedDb: DataContextDb, actorUserId: string, rangeStartUtcIso: string, rangeEndUtcIso: string): Promise<Array<{ threadId: string; threadFirstMessageAt: string; role: "user" | "assistant"; body: string; createdAt: string }>>`
  — joins `app.chat_threads`/`app.chat_messages`, filters `incognito = false`, `status = 'stored'`,
  `role in ('user','assistant')`, `created_at` within range, ordered by thread's first message
  time then `created_at` (same ordering shape as `listMessages`, `repository.ts:88`).
- Test: covered by the integration test in task 6 below (repository method has no independent
  unit test — it is only meaningful wired through the job; a standalone mock-Kysely test would
  pass while no real caller exists, which is exactly the "wired, not just defined" trap this repo
  has hit before).

### 6. `packages/chat/src/jobs.ts` (edit)
- `export const CHAT_ARCHIVE_DAY_QUEUE = "chat.archive-day"`, add to `CHAT_QUEUE_DEFINITIONS`
  with `{ retryLimit: 2, deleteAfterSeconds: 600 }` (same shape as the embed-turn entry).
- `export interface ArchiveDayJobPayload extends ActorScopedJobPayload { readonly localDate: string }`
- New worker function, registered inside `registerChatJobWorkers` alongside the embed-turn worker,
  that: reads `chat-archive.enabled`/`chat-archive.folder` off the preferences port (double-check
  — the dispatch site in task 7 already gates on this, this is defense against a stale/manual job)
  → if disabled, no-op; else resolves the UTC range for `localDate` (generous window, filter with
  `localDay` per message — same approach the #1368 handoff already worked out, since there is no
  UTC-range-for-local-day helper in `time.ts`) → calls `chat.listStoredMessagesInRange` → groups
  rows into `ChatArchiveSession[]` by `threadId` (session order = each session's own
  `threadFirstMessageAt`, ascending) → calls `writeDailyChatArchive` from `@moss/notes`.
- Test: `tests/integration/chat-archive-day-job.test.ts` (real DB, via the worker function
  directly, not through pg-boss) — cases: two threads same day both appear as separate sessions in
  thread-start order; an incognito thread's messages are excluded; messages outside the local day
  window are excluded (DST-adjacent boundary case using a non-UTC timezone); disabled preference
  means the function no-ops without calling the writer.

### 7. `packages/jobs/src/pg-boss.ts` (edit)
- Add `"localDate"` to `ALLOWED_PAYLOAD_KEYS` (line ~86-99).
- No new test — covered by the dispatch test in task 8 (a payload with `localDate` must actually
  send without `assertMetadataOnlyPayload` throwing).

### 8. `packages/chat/src/live/persistence.ts` (edit)
- Inside the existing `if (this.boss && result && !thread.incognito) { ... }` block
  (lines 293-308): read `chat-archive.enabled` off `this.localePreferences` (same port, new key)
  and, if enabled, read `chat-archive.folder` is **not** needed here (the worker re-reads folder
  itself) — just read `enabled` to decide whether to dispatch at all. Compute `localDate` via
  `extractTimezone` + `localDay`, same pattern as `getThreadContext` (line 390-395), reusing the
  turn's own locale lookup rather than adding a second DB round trip if one is already in scope
  for this call — confirm at implementation time whether `recordTurn` already fetches locale in
  this code path; if not, one extra `this.localePreferences?.get(scopedDb, "locale")` call is
  acceptable (single extra read, not per-message).
  `sendJob(this.boss, CHAT_ARCHIVE_DAY_QUEUE, { actorUserId, localDate })`.
- Test: extend `tests/integration/chat-live.test.ts` (or a new
  `tests/integration/chat-archive-dispatch.test.ts` if the existing file is already large) —
  cases: archive enabled + non-incognito turn → job sent with today's local date; archive disabled
  → no job sent; incognito thread → no job sent (falls under the existing `!thread.incognito`
  guard, confirm it still holds for the new job too).

### 9. Dev/prod config
- No new required env var — this feature uses existing preference-key storage (no new setting
  that fails closed without a value; `enabled` defaults to `false` when absent). Confirm at build
  time that no compose/env file needs a new mandatory key; if one does turn out to be needed
  (unexpected), add it to both dev and prod configs in this same PR per the hard invariant.

### 10. Release note
- `Category: N/A` (backend-only, nothing user-visible yet — matches #1951's own spec text).

## Verification

```bash
pnpm --filter @moss/shared typecheck > /tmp/tc-shared.log 2>&1; echo "EXIT=$?"
pnpm --filter @moss/notes typecheck > /tmp/tc-notes.log 2>&1; echo "EXIT=$?"
pnpm --filter @moss/settings typecheck > /tmp/tc-settings.log 2>&1; echo "EXIT=$?"
pnpm --filter @moss/chat typecheck > /tmp/tc-chat.log 2>&1; echo "EXIT=$?"
```
Each expected `EXIT=0`.

Full scoped test run (via the `verify-gate` skill — never run `pnpm verify:foundation` or any
DB-touching test command outside it):
- unit: `chat-archive-folder-validation`, `settings-chat-archive-routes`, `daily-archive-writer`
- integration: `chat-archive-day-job`, `chat-archive-dispatch` (or the extended `chat-live` test),
  plus the existing `notes-write-tools` suite (must stay green — task 3 touches shared code)

Expected: all listed suites pass, exit 0, run through the skill's recipe only.

## Kill gate

Phase 1 is this entire slice (it is already the smallest useful cut — settings without a writer
do nothing, a writer without dispatch never runs). If, while building task 4 or 6, the collision
naming rule or the local-day windowing turns out to need real user data to validate (i.e. it
cannot be proven correct with synthetic test fixtures), that is the signal to stop and escalate
via `fleetctl blocked` rather than guessing — a bad marker convention shipped now is a live user
file silently at risk of being overwritten. Owner of that call: whoever is running this lane.

## Live-path proof plan

Per #1951's own exit criteria: manual run of the background job on the dev instance producing the
correct daily file. Concretely: enable the two preferences directly via the new PUT route (no UI
yet) for the dev test user, hold one short chat turn on the live dev instance, confirm the job
fires (log line or direct DB/file check) and a dated Markdown file appears in the configured
folder with the marker line and the turn's content. Record this as the `LIVE-PATH PROOF` PR
comment.
