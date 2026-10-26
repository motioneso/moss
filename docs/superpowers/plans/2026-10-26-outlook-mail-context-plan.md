# Outlook work mail as context: build plan

Date: 2026-10-26. Part of #3766.

- Spec: `docs/superpowers/specs/2026-10-26-outlook-mail-context-design.md` (PR #3767)
- Mockups: `docs/superpowers/specs/outlook-mail-mockup/` (PR #3768)
- Depends on: #3570 (per-user Outlook setup, draft PR #3571) for slice 6 only
- Seams verified against `origin/main` at `84cb79660`

Written to the `plan-build` skill. Contracts, DDL and test behaviour only; no function bodies.

## 0. Gates

| Gate                       | State                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| Spec approved              | Approved by Ben 2026-10-26; spec header says approved. PR #3767 still open. Merge it first. |
| Mockups approved           | Approved per Ben (relayed). PR #3768 still open. Merge it first.                            |
| Task issue                 | #3766, open                                                                                 |
| Live tests before building | L1 to L5 below must pass before slice 2 starts. L6 before slice 4.                          |

## 1. Seams check

Every capability the plan relies on, with evidence. Paths are relative to `~/Jarv1s`.

### 1.1 Server-window collector

| Capability                                                                                                                | Evidence                                                                                                 | Consequence for this plan                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Calendar job runs every 5 minutes on one queue, `exclusive` policy, no retries                                            | `packages/connectors/src/outlook-calendar-jobs.ts:23-29`, `:182`                                         | Mail runs inside the same job handler, after the calendar sync, so the two never overlap (ruling R1). |
| Job payload is `{ actorUserId, kind }` only                                                                               | `outlook-calendar-jobs.ts:30-32`, `:177-181`; allow-list `packages/jobs/src/pg-boss.ts:100`              | Mail adds no payload keys.                                                                            |
| Binding is operator env, one owner per install                                                                            | `packages/connectors/src/outlook-calendar-config.ts:215-232`                                             | Mail inherits it. Other users wait for #3570 (slice 6).                                               |
| Calendar collector needs exactly one page whose path starts `/calendar/`; any trusted input or URL change aborts the scan | `packages/connectors/src/outlook-calendar-browser.ts:279-297`, `:314-331`                                | A second tab on `/mail/` does not count as a calendar page, so mail can use its own tab (ruling R2).  |
| Sign-in detection by login-host pages                                                                                     | `outlook-calendar-browser.ts:287-295`                                                                    | Mail reuses the same check.                                                                           |
| Health stored per account in `app.preferences`                                                                            | `outlook-calendar-jobs.ts:51`, `:115-125`                                                                | Mail health uses the same store under its own key.                                                    |
| Error codes carry no labels or upstream text                                                                              | `packages/connectors/src/outlook-calendar-source.ts:13-21`                                               | Mail error class copies this rule.                                                                    |
| Feature grants `{ email, calendar }` per account; connect writes `email: false`                                           | `packages/connectors/src/feature-grants.ts:16-40`; `outlook-calendar-routes.ts:121-124`                  | The "Email access" switch already has a home.                                                         |
| Effective grant also needs an email scope                                                                                 | `feature-grants.ts:48-57`, `:73-78`                                                                      | Outlook account needs a mail scope added (ruling R6).                                                 |
| Email sync only picks `google` and `imap` provider types                                                                  | `packages/connectors/src/email-refresh.ts:139-143`                                                       | An Outlook mail grant does not pull the account into email sync.                                      |
| Granted-email account set feeds the email monitor, filtered by stored messages                                            | `packages/connectors/src/feature-grant-service.ts:26-45`; `packages/email/src/monitor-provider.ts:59-70` | Harmless, since no Outlook mail is stored. Slice 1 adds a test that proves it.                        |
| Worker registration site has AI adapters and runs connectors workers                                                      | `packages/module-registry/src/index.ts:1985-1992`                                                        | Ports for memory, people and vault are wired here, not imported by connectors.                        |
| Connectors routes and manifest                                                                                            | `packages/connectors/src/routes.ts:99`; `packages/connectors/src/manifest.ts:133-165`, `:337-390`        | New routes and features are declared here.                                                            |
| Browser collector unit test fakes the CDP transport                                                                       | `tests/unit/outlook-calendar-browser.test.ts:6`                                                          | Mail reader tests use a local fixture page instead (see slice 2).                                     |

### 1.2 Mail seam

| Capability                                                                   | Evidence                                                                         | Consequence                                                                                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `EmailReadProvider` lists keys and fetches `ParsedEmail` for the email store | `packages/connectors/src/email-read-provider.ts:22-30`; `email-extract.ts:57-68` | Not used. It exists to feed stored mail, and this feature stores none (ruling R3). The pipeline borrows the field names only. |

### 1.3 AI, memory, people, vault

| Capability                                                     | Evidence                                                                                                                                                                                                          | Consequence                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Structured calls route by service id, no model name            | `packages/ai/src/structured/generate-structured.ts:209`; precedent `packages/connectors/src/extract-deps.ts:62`, `:149-171`                                                                                       | New service `module.connectors.work-mail`, with `requireExplicitBinding: true` like the extract step.              |
| Activity history title per structured service                  | `manifest.ts:394-397`                                                                                                                                                                                             | Add `structured.connectors.work-mail`.                                                                             |
| Prompt cap 65,536 bytes                                        | `packages/ai/src/structured/schema-bounds.ts:4`, `:23-30`                                                                                                                                                         | Body capped at 24,000 characters (D3).                                                                             |
| Memory facts with category `preference`                        | `packages/memory/src/facts-repository.ts:5`, `:70`; exported `packages/memory/src/index.ts:92`                                                                                                                    | Preferences are read from here. Facts carry no "mail" tag, so all active preference facts are passed, capped (D4). |
| Vault chunk search                                             | `packages/memory/src/retrieval.ts:12-19`; exported `index.ts:84`                                                                                                                                                  | Candidate notes come from here.                                                                                    |
| People lookup by query                                         | `packages/people/src/service.ts:25`                                                                                                                                                                               | Sender context.                                                                                                    |
| Vault I/O and the notes-folder root                            | `packages/vault/src/vault-context.ts:31-49`, `:63-70`; `packages/vault/src/index.ts:11-30`; precedent `packages/module-registry/src/index.ts:2969-2990`; `packages/settings/src/notes-source-routes.ts:24`, `:43` | Writes go through `withVaultContextAt` on the notes folder.                                                        |
| `@moss/connectors` depends on neither memory, people nor vault | `packages/connectors/package.json` deps; `pnpm check:package-deps`                                                                                                                                                | Pipeline takes injected ports (ruling R4).                                                                         |
| A user-marked private note                                     | Not found. Only generated private exports exist (`packages/notes/src/private-note-export.ts:7`)                                                                                                                   | Ruling B6.                                                                                                         |

### 1.4 Add-on, pairing, hosting

| Capability                                                                            | Evidence                                                                                                            | Consequence                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Companion pairing service, three-secret design                                        | `packages/auth/src/companion-pairing.ts:21-83`; tables `infra/postgres/migrations/0238_companion_devices.sql:13-75` | Steelmanned and not chosen (fork F3).                                           |
| Hashing helpers exported                                                              | `packages/auth/src/index.ts:96-100`                                                                                 | Reused for code and token digests.                                              |
| Unauthenticated requests to a module route reach the handler, which does its own auth | `packages/module-registry/src/route-guard.ts:316-322`                                                               | Add-on upload can be a normal connectors manifest route with bearer-token auth. |
| Per-route rate limits                                                                 | `apps/api/src/companion-routes.ts:76-81`                                                                            | Pairing redeem and upload get their own limits.                                 |
| SECURITY DEFINER precedent in module SQL                                              | `packages/ai/sql/0145_jarvis_error_log.sql`                                                                         | Token lookup before the owner is known.                                         |
| Owner-only RLS pattern                                                                | `packages/connectors/sql/0022_connectors_owner_only.sql:11-40`                                                      | Copied for new tables.                                                          |
| Spike add-on: MV3, `activeTab` + `scripting`, network blocked by CSP                  | `spikes/o365-firefox-preview-prototype/manifest.json`; results `README.md:244-437`                                  | Product add-on starts from the reader code, not from this manifest.             |
| Hosted file download from Moss                                                        | Only data export (`packages/settings/src/data-export-async-routes.ts:76`)                                           | Slice 5 adds a static download route.                                           |
| Microsoft sign-in (Graph) connector                                                   | Not found in `packages/connectors/src` or `apps`                                                                    | Ruling B1. Screen 02 is built disabled.                                         |

### 1.5 Web and app map

| Capability                                       | Evidence                                                                                                      | Consequence                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Account picker (Google, IMAP)                    | `apps/web/src/settings/settings-personal-data-panes.tsx:221-240`                                              | Outlook added here.                                               |
| Account row with "Email access" switch           | `settings-personal-data-panes.tsx:110-211`                                                                    | Outlook row reuses it.                                            |
| Outlook calendar shown as a separate panel today | `apps/web/src/settings/settings-connections-pane.tsx:82`; `apps/web/src/calendar/outlook-calendar-status.tsx` | Folded into the Outlook row in slice 3.                           |
| Connections entry in the app map                 | `packages/shared/src/app-map-core.ts:196-261`                                                                 | Updated in slices 3, 4, 5.                                        |
| Outlook feature entry in the manifest            | `manifest.ts:349-390`                                                                                         | Updated in slices 2 and 4.                                        |
| Connector e2e specs use a mocked API             | `tests/e2e/connect-google.spec.ts`, `tests/e2e/mock-connectors-api.ts`                                        | e2e tests follow this; live proof is separate and uses real data. |

## 2. Live tests before building

Run on the dedicated server browser against mail already in Ben's inbox. No test messages are sent (ruling B3). Record counts and pass or fail only. No mail text, subject or sender leaves the browser or enters any log, note or report.

| #   | Question                                                    | Pass                                                                                                                                                                                       | Blocks                |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| L1  | Does Outlook's own "Mark as unread" restore state reliably? | 5 of 5 unread messages opened by script and marked unread again still show unread after a page reload and on a second client                                                               | Slice 2               |
| L2  | Inbox sort. Is the sort a mailbox-wide setting?             | Record the default. Change it in the dedicated window and check a second client. Moss never changes it either way (ruling B4); this test only records whether a non-date sort is possible. | Slice 2               |
| L3  | Row time format                                             | Record what the row shows for today, yesterday and older mail, and whether the opened message shows a full date and time                                                                   | Slice 2 marker design |
| L4  | Focused Inbox                                               | Record whether "Other" exists on the account and whether Moss must read both                                                                                                               | Slice 2               |
| L5  | A second tab on `/mail/` in the same profile                | Calendar job stays `current` across 3 runs while a mail tab opens and closes; no sign-out                                                                                                  | Slice 2 (ruling R2)   |
| L6  | Can the add-on be installed on Ben's managed work browser?  | Unsigned temporary load succeeds on Firefox and in Chrome developer mode                                                                                                                   | Slice 4 timing        |

Owner: Ben runs L6 on his laptop. A build agent runs L1 to L5 through the dedicated browser. For L1, use messages that are already unread; if fewer than 5 exist, test every unread message present and record the count.

## 3. Design forks

### F1. Where the server-window mail read runs

| Option                                            | For                                                                                                | Against                                                                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Same job, after the calendar sync (chosen)** | The queue's `exclusive` policy already serialises everything in that browser. No cross-queue lock. | A long mail read delays the next calendar tick. Fixed by a 120-second budget per run.                                                                            |
| B. Own queue, enqueued when the calendar job ends | Separate retry and timeout settings. Failures stay apart.                                          | Nothing stops the next calendar run starting mid-read. The calendar scan aborts on any URL change (`outlook-calendar-browser.ts:329`). Needs a new browser lock. |

### F2. Which tab reads mail

| Option                                                       | For                                                                                                                              | Against                                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **A. Open a new tab, close it after (chosen, pending L5)**   | Never touches the calendar page. The calendar filter ignores non-calendar pages. "Mail view not found" cannot harm the calendar. | A crash leaves a stray tab. Harmless to the calendar filter; the next run closes stray mail tabs. |
| B. Navigate the calendar tab to Mail and back (spec wording) | One tab, which is what the spec describes.                                                                                       | Any failure mid-read leaves the calendar collector broken until repair.                           |

The spec's goal is that the calendar keeps its single page. Option A meets it more strongly. Listed for Ben as R2.

### F3. Add-on pairing

| Option                                                         | For                                                                                                                                                              | Against                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Connector-owned code and token tables (chosen)**          | Matches the approved mockup (code on screen). Owned by connectors, so no change to platform auth or the route-guard allow-list. Token can only call mail routes. | New tables, new token code. Still needs the Moss address typed into the add-on (ruling B5).                                              |
| B. Reuse companion pairing with a new `browser-addon` platform | Proven three-secret flow, rate limits, expiry. The Android app already solves "type the address, approve in Moss" with no code.                                  | Changes platform auth owned by no module. Companion credentials carry device and recording semantics. Diverges from the approved screen. |

### F4. Ordering

The spec calls the add-on the first route. This plan builds the server window first. The server window reuses a collector already running for Ben, needs no store, signing or pairing, and puts real mail through the pipeline one slice after the kill gate. Ben's employer may also block add-ons (L6). Listed as R7.

## 4. Determinism boundary

- Every status line renders from records. "Last read 2:40 PM", health dot, problem lines and the pairing state come from stored health, never from model output.
- No chat turns. Mail processing never posts into chat.
- The model gets exactly two jobs.
  1. Decide whether a message matters to this user, given their preferences, the sender's People context and candidate notes.
  2. Write the entry text and pick its destination from a numbered list Moss supplies.
- Guidance budget is 150 words. If preferences cannot be applied inside it, the design is wrong.
- Code, not the model, controls the rest.
  - Entry header (date, sender, subject, received time) is built by code.
  - Destination is an index into the candidate list or `default`. A free path is rejected.
  - Quote ceiling. The longest run copied verbatim from the body is at most 200 characters.
  - Entry length at most 600 characters.
  - Private notes are skipped before the model sees them as candidates.
- The four guards for model output reaching user notes:
  1. Schema field descriptions on every field.
  2. Prompt contract with one worked example.
  3. Boundary validator for the rules above.
  4. Append-only check. The note after the write must start with the exact bytes it had before. Anything else aborts the write.

## 5. Slices

Builders are Codex gpt-6.1-sol at medium effort, one session per slice.

| PR   | Slices  | Ships to users                                                         |
| ---- | ------- | ---------------------------------------------------------------------- |
| PR A | 1, 2, 3 | Server-window mail for the operator-bound owner, with its settings row |
| PR B | 4       | Add-on route (developer-loaded), pairing, upload                       |
| PR C | 5       | Signed add-on download from Moss                                       |
| PR D | 6       | Other users, after #3570 merges                                        |

Each PR fills the app map in the same PR and the Release note section of the template.

---

### Slice 1. Shared mail pipeline (fixtures only)

Worktree and branch shared with slices 2 and 3 (`feat/outlook-mail-context`).

**Files**

- `packages/connectors/src/work-mail/types.ts`
- `packages/connectors/src/work-mail/cursor.ts` (marker and dedupe)
- `packages/connectors/src/work-mail/judge.ts` (schema, prompt, validator)
- `packages/connectors/src/work-mail/pipeline.ts`
- `packages/connectors/src/work-mail/entry.ts` (code-built header, append-only write check)
- `packages/module-registry/src/work-mail-ports.ts` (memory, people, vault adapters)
- `packages/connectors/src/manifest.ts` (Activity title `structured.connectors.work-mail`)
- Tests listed below

**Contracts**

```ts
export const WORK_MAIL_BODY_MAX_CHARS = 24_000;
export const WORK_MAIL_MAX_PER_RUN = 25;
export const WORK_MAIL_SEEN_MAX = 500;

export interface CapturedMailMessage {
  readonly sender: string;
  readonly subject: string;
  readonly receivedAt: string; // ISO 8601
  readonly threadHint: string | null;
  readonly body: string;
  readonly bodyTruncated: boolean;
}

export interface WorkMailMarker {
  readonly receivedAt: string;
  readonly key: string; // HMAC-SHA256(salt, sender|subject|receivedAt), base64url
}

export interface WorkMailCursor {
  readonly marker: WorkMailMarker | null;
  readonly seen: readonly string[];
  readonly salt: string;
}

export interface WorkMailNoteCandidate {
  readonly index: number;
  readonly path: string; // relative to the notes root
  readonly title: string;
  readonly excerpt: string;
}

export interface WorkMailJudgement {
  readonly decision: "nothing" | "note";
  readonly target?:
    { readonly kind: "candidate"; readonly index: number } | { readonly kind: "default" };
  readonly entry?: string;
  readonly reason: string;
}

export interface WorkMailPorts {
  readonly preferences: {
    list(db: DataContextDb, ownerUserId: string): Promise<readonly string[]>;
  };
  readonly people: {
    senderContext(db: DataContextDb, ownerUserId: string, sender: string): Promise<string | null>;
  };
  readonly notes: {
    candidates(
      access: AccessContext,
      query: string,
      limit: number
    ): Promise<readonly WorkMailNoteCandidate[]>;
    append(
      access: AccessContext,
      path: string | "default",
      entry: string
    ): Promise<"written" | "private" | "unavailable" | "changed">;
  };
  readonly judge: (
    db: DataContextDb,
    input: WorkMailJudgeInput,
    signal?: AbortSignal
  ) => Promise<WorkMailJudgement>;
  readonly now: () => Date;
}

export type WorkMailOutcome =
  | { readonly kind: "nothing" }
  | { readonly kind: "noted" }
  | { readonly kind: "duplicate" }
  | {
      readonly kind: "failed";
      readonly reason: "ai-unavailable" | "ai-invalid" | "vault-unavailable";
    };

export function isNewerThanCursor(cursor: WorkMailCursor, message: CapturedMailMessage): boolean;

export async function ingestWorkMail(
  dataContext: DataContextRunner,
  access: AccessContext,
  messages: readonly CapturedMailMessage[],
  ports: WorkMailPorts,
  signal?: AbortSignal
): Promise<{
  readonly processed: number;
  readonly stoppedAt: number | null;
  readonly cursor: WorkMailCursor;
}>;
```

**Storage.** No migration. `app.preferences`, owner-scoped.

- `outlook_mail.cursor` holds `WorkMailCursor`. Keyed per user, not per account, so both routes share one marker.
- No sender, subject or body is stored. The marker keeps only the received time and a salted hash.

**Rules**

- Messages are sorted oldest first. The cursor advances after each message that finishes.
- On an AI failure the batch stops, and the cursor stays at the last finished message.
- A vault write that returns `changed` (the user edited the note mid-write) re-reads once, then counts as `vault-unavailable`.
- The default note is `Work mail notes.md` at the notes-folder root. With no notes folder linked, it is `Work mail notes.md` in the private Moss vault (ruling B7).

**Tests (behaviour, and why a broken build fails them)**

| File                                             | Behaviour                                                                                                                                                                                                                                 | Fails if                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `tests/unit/work-mail-cursor.test.ts`            | Same received time but a different hash counts as new. Seen hashes are skipped. The seen list drops the oldest past 500.                                                                                                                  | Marker compares by time alone, or the list grows without bound            |
| `tests/unit/work-mail-judge.test.ts`             | Validator rejects a free path, an index out of range, a 601-character entry, and a 201-character verbatim run from the body                                                                                                               | Any guard is missing                                                      |
| `tests/unit/work-mail-entry.test.ts`             | Append-only check refuses a write whose result does not start with the original bytes                                                                                                                                                     | The writer rewrites the file                                              |
| `tests/unit/work-mail-pipeline.test.ts`          | Fixture batch of 6. Message 4's AI call fails. Cursor ends at message 3 and messages 5 and 6 are not judged.                                                                                                                              | Cursor advances past a failure                                            |
| same                                             | A preference "Never write anything about HR mail" reaches the judge input                                                                                                                                                                 | Preferences are not read                                                  |
| same                                             | A private candidate never reaches the judge input                                                                                                                                                                                         | Private filter runs after the model                                       |
| `tests/integration/work-mail-no-storage.test.ts` | Run the pipeline with a canary string in subject, sender and body. Then search every `app` table's text and JSON columns and the captured logger output for the canary. Zero hits, except inside the vault note the entry was written to. | Message text lands in preferences, AI telemetry, Activity history or logs |
| same                                             | With the Outlook account's email grant on, the email monitor and briefing sources return no Outlook items                                                                                                                                 | The grant leaks the account into email features                           |

The no-storage test must be seen failing with a deliberate leak added (write the subject into the cursor), per the security-claims rule.

**e2e.** None for UI. The exit test is `tests/integration/work-mail-no-storage.test.ts` run and observed passing.

**Verification**

```bash
pnpm test:unit tests/unit/work-mail-cursor.test.ts tests/unit/work-mail-judge.test.ts tests/unit/work-mail-entry.test.ts tests/unit/work-mail-pipeline.test.ts > /tmp/wm1-unit.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
pnpm verify:static > /tmp/wm1-static.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
```

Integration and the full gate run only through the `verify-gate` skill. Expect exit 0.

**Kill gate 1 (owner: Ben; coordinator prepares the evidence)**

Run the judge against the configured model on a fixture set of 20 invented messages: 10 that should produce an entry, 10 plain. Use four preference facts. One prompt revision is allowed, inside 150 words.

Stop the feature if any of these hold:

- more than 2 of the 10 plain messages produce an entry
- more than 3 of the 10 important messages produce nothing
- the guidance needs more than 150 words to get there
- the no-storage test finds any canary

Ben reads the 20 outcomes, not a summary.

---

### Slice 2. Server-window route

Needs L1 to L5 passed.

**Files**

- `packages/connectors/src/outlook-mail-browser.ts` (reader)
- `packages/connectors/src/outlook-mail-jobs.ts` (run after calendar sync, health)
- `packages/connectors/src/outlook-mail-routes.ts`
- `packages/connectors/src/outlook-calendar-jobs.ts` (call mail after the calendar sync in the worker handler)
- `packages/connectors/src/outlook-calendar-routes.ts` (connect adds the mail scope)
- `packages/connectors/src/feature-grants.ts` (recognise `outlook-mail.read`)
- `packages/shared/src/outlook-mail-api.ts`
- `packages/connectors/src/manifest.ts` (routes, feature `connectors.outlook_browser_mail` with errors and remediations)
- `tests/fixtures/outlook-mail/` (invented inbox pages)

**Contracts**

```ts
export class OutlookMailSourceError extends Error {
  constructor(readonly code: "source-changed" | "sign-in-needed" | "partial");
}

export interface OutlookMailScan {
  readonly messages: readonly CapturedMailMessage[];
  readonly openFailures: number;
  readonly restoreFailures: number;
  readonly complete: boolean;
}

export async function readOutlookMail(
  binding: OutlookBrowserBinding,
  cursor: WorkMailCursor,
  limits: { readonly maxMessages: number; readonly deadlineMs: number }
): Promise<OutlookMailScan>;

export type OutlookMailState =
  | "off" | "collecting" | "current" | "partial" | "sign-in-needed" | "source-changed";

export interface OutlookMailHealth {
  readonly state: OutlookMailState;
  readonly route: "server-window" | "addon";
  readonly lastReadAt?: string;
  readonly attemptedAt?: string;
  readonly failures?: number;
  readonly restoreFailures?: number; // consecutive runs with a failed restore
}

export const outlookMailHealthKey = (accountId: string): string =>
  `connector.${accountId}.outlook_mail_health`;

export async function runOutlookMailRead(
  dataContext: DataContextRunner,
  binding: OutlookCalendarBinding,
  ports: WorkMailPorts,
  read?: typeof readOutlookMail
): Promise<void>;
```

**Routes** (connectors manifest, `permissionId` as the calendar routes)

| Method | Path                                   | Chat access             |
| ------ | -------------------------------------- | ----------------------- |
| GET    | `/api/connectors/outlook-mail`         | read                    |
| POST   | `/api/connectors/outlook-mail/refresh` | blocked, self_authority |

```ts
export interface OutlookMailStatus {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly route: "server-window" | "addon" | null;
  readonly state: OutlookMailState;
  readonly lastReadAt: string | null;
}
```

**Rules**

- Runs only when the calendar sync in the same job did not end in `sign-in-needed` or `source-changed`, the email grant is on, and 30 minutes have passed since the last attempt.
- Budget is 120 seconds and 25 messages. Leftovers wait for the next run.
- Before opening a row, record whether it is unread. After capture, mark it unread again if it was. A failed restore counts and the read continues.
- Never sends, moves, deletes or flags. Never changes the inbox sort (ruling B4). If the list is not sorted newest first, the read stops with `source-changed`.
- The mail tab is closed in `finally`. Stray mail tabs from a crashed run are closed at the start of the next run.
- Reader rows are parsed in an isolated world, like the calendar input guard.

**Tests**

| File                                            | Behaviour                                                                                                                                                                                       | Fails if                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `tests/unit/outlook-mail-browser.test.ts`       | Headless Chromium on a local fixture inbox, reached through a real CDP endpoint. Reads only rows newer than the cursor. Restores unread on rows that started unread, and leaves read rows read. | Restore is skipped, or applied to read rows |
| same                                            | Calendar page URL and DOM are unchanged after the read                                                                                                                                          | Reader touches the calendar tab             |
| same                                            | Fixture with no message list gives `source-changed`. A login page gives `sign-in-needed`.                                                                                                       | Wrong state reported                        |
| same                                            | The reader never clicks a control whose label is Delete, Move, Flag, Reply or Forward. A spy on the fixture records clicks.                                                                     | Any write control is used                   |
| `tests/unit/outlook-mail-jobs.test.ts`          | With a calendar sync ending `sign-in-needed`, the mail read does not run. With the grant off it does not run. Inside 30 minutes it does not run.                                                | Ordering or gating is wrong                 |
| `tests/integration/outlook-mail-routes.test.ts` | Another user's GET sees `available: false`; refresh is 403 for anyone but the bound owner                                                                                                       | Owner binding is bypassed                   |

**e2e.** `tests/e2e/outlook-mail-status.spec.ts` drives `/settings?section=connections` with the mocked API returning each `OutlookMailState`. Slice 3 extends it.

**Verification**

```bash
pnpm test:unit tests/unit/outlook-mail-browser.test.ts tests/unit/outlook-mail-jobs.test.ts > /tmp/wm2-unit.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
pnpm verify:static > /tmp/wm2-static.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
```

**Live checkpoint (owner: Ben).** One week on Ben's own mailbox through the server window. Ben judges whether the entries are worth having. This is a second stop point, not a substitute for kill gate 1.

---

### Slice 3. Outlook in the add-account flow (server-window part)

Use the `design-system` skill before writing UI.

**Files**

- `apps/web/src/settings/settings-outlook-connect.tsx` (connect page, `gflow` layout)
- `apps/web/src/settings/settings-outlook-row.tsx` (account row with calendar and mail lines)
- `apps/web/src/settings/settings-personal-data-panes.tsx` (Outlook in the picker; Outlook row in the list)
- `apps/web/src/settings/settings-connections-pane.tsx` (drop the separate calendar panel)
- `packages/shared/src/app-map-core.ts` (Connections entry)
- `packages/connectors/src/manifest.ts` (feature text)

**Screens built** (from the approved mockup)

| Mockup       | Built in this slice                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 01 picker    | Yes                                                                                                                                           |
| 02 sign-in   | Yes, disabled. "Sign in with Microsoft" shows as unavailable with the line "Not available yet" (ruling B1). The browser choices sit below it. |
| 03 blocked   | The "Use the server window" link only, shown when `available` is true for this user. Add-on steps come in slice 4.                            |
| 04 connected | Yes. Status line reads "Server window" for this route.                                                                                        |
| 05 problems  | Sign-in needed and page changed. "Add-on not seen" comes in slice 4.                                                                          |

**Tests**

| File                                              | Behaviour                                                                                                                                                  | Fails if                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `tests/e2e/outlook-mail-status.spec.ts`           | Picker shows Outlook. Connected row shows "Last read" from the status record. Turning "Email access" on calls the feature-grants route with `email: true`. | Switch is not wired, or text comes from anywhere but the record |
| same                                              | At 390px no control overlaps its neighbour (bounding-box check)                                                                                            | Crowding                                                        |
| `tests/unit/app-map-integrity.test.ts` (existing) | Passes with the new Connections text                                                                                                                       | App map not updated                                             |

**Live proof (Live-Path Gate).** On a dev instance bound to the dedicated browser, using mail already in Ben's inbox (ruling B3): turn on Email access, wait one run, see "Last read" update, open the note and find any entry, and confirm messages that were unread before the run are still unread in Outlook. The PR records counts only, never mail content. Recorded on PR A. Without it PR A stays code-complete, unverified.

**Verification**

```bash
pnpm test:e2e tests/e2e/outlook-mail-status.spec.ts > /tmp/wm3-e2e.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
pnpm verify:static > /tmp/wm3-static.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
```

Then the full gate through `verify-gate`, expect exit 0.

**Release note (PR A).** Category Added. Title "Outlook work mail". Description: "Moss can now read new work mail in your Outlook account and add anything important to your notes, without keeping a copy of the mail."

---

### Slice 4. Browser add-on, pairing and upload

Needs L6 passed. Address shown beside the code (ruling B5). New PR (PR B), new worktree.

**Files**

- `apps/outlook-mail-addon/` (one MV3 code base: `src/background.ts`, `src/outlook-reader.ts`, `src/popup.ts`, `manifest.base.json`, `build.ts`)
- `packages/connectors/sql/<next free number>_outlook_mail_addon.sql` (number checked with `pnpm check:migration-numbers` at build time)
- `packages/connectors/src/outlook-mail-addon-pairing.ts`
- `packages/connectors/src/outlook-mail-addon-routes.ts`
- `packages/shared/src/outlook-mail-api.ts` (add-on contracts)
- `apps/web/src/settings/settings-outlook-connect.tsx` (add-on steps, code, New code, waiting state)
- `apps/web/src/settings/settings-outlook-row.tsx` (Browser add-on line, Revoke, "Add-on not seen")
- `packages/shared/src/app-map-core.ts`, `packages/connectors/src/manifest.ts`

**DDL**

```sql
INSERT INTO app.connector_definitions (provider_id, provider_type, display_name, status, default_scopes)
VALUES ('outlook-mail-addon', 'email', 'Outlook mail (browser add-on)', 'available', ARRAY['outlook-mail.read']::text[])
ON CONFLICT (provider_id) DO NOTHING;
-- seeded under a temporary migration-owner policy, as in 0331

CREATE TABLE app.connector_mail_addon_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  code_digest   text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  redeemed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX connector_mail_addon_codes_one_open
  ON app.connector_mail_addon_codes (owner_user_id) WHERE redeemed_at IS NULL;

CREATE TABLE app.connector_mail_addon_tokens (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id        uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  connector_account_id uuid NOT NULL REFERENCES app.connector_accounts(id) ON DELETE CASCADE,
  token_digest         text NOT NULL UNIQUE,
  browser              text NOT NULL CHECK (browser IN ('firefox', 'chrome', 'edge')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_used_at         timestamptz,
  revoked_at           timestamptz
);

-- Owner-only RLS on both tables for jarvis_app_runtime, as in 0022.

CREATE FUNCTION app.redeem_outlook_mail_addon_code(p_code_digest text, p_token_digest text, p_browser text)
  RETURNS uuid -- owner_user_id, or NULL when unknown, expired or used
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp;

CREATE FUNCTION app.resolve_outlook_mail_addon_token(p_token_digest text)
  RETURNS TABLE (owner_user_id uuid, connector_account_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp;
  -- active, not revoked; stamps last_used_at

-- EXECUTE on both granted to jarvis_app_runtime only.
```

Codes: 6 characters from a 31-character alphabet, 10-minute life, single use, one open code per user. Tokens: 32 random bytes, stored as a SHA-256 digest only.

**Routes**

| Method | Path                                          | Auth                               | Chat                    |
| ------ | --------------------------------------------- | ---------------------------------- | ----------------------- |
| POST   | `/api/connectors/outlook-mail/addon/code`     | session                            | blocked, self_authority |
| POST   | `/api/connectors/outlook-mail/addon/pair`     | code in body; rate limit per IP    | blocked                 |
| GET    | `/api/connectors/outlook-mail/addon/cursor`   | bearer token                       | blocked                 |
| POST   | `/api/connectors/outlook-mail/addon/messages` | bearer token; rate limit per token | blocked                 |
| POST   | `/api/connectors/outlook-mail/addon/revoke`   | session                            | blocked, self_authority |

```ts
export interface AddonPairRequest {
  readonly code: string;
  readonly browser: "firefox" | "chrome" | "edge";
}
export interface AddonPairResponse {
  readonly token: string;
}
export interface AddonCursorResponse {
  readonly after: { readonly receivedAt: string; readonly key: string } | null;
  readonly salt: string;
}
export interface AddonMessageRequest {
  readonly message: CapturedMailMessage;
} // exactly one
export type AddonMessageResponse =
  | { readonly status: "processed"; readonly cursor: AddonCursorResponse }
  | { readonly status: "retry"; readonly retryAfterSeconds: number };
```

**Rules**

- One message per request. Processing finishes inside the request within 90 seconds, or Moss answers `retry`, stores nothing and leaves the cursor alone.
- Request bodies are never logged. The route sets a body limit of 64 KB.
- The add-on asks for its Moss host permission at pairing time only (`optional_host_permissions`) and calls only that origin.
- The add-on reads only when an Outlook mail tab is open. It restores unread state the same way the server reader does.
- Revoke sets `revoked_at`. The next add-on call gets 401 and the add-on clears its token.
- Data export and account deletion: token and code digests are excluded from user exports.

**Tests**

| File                                                   | Behaviour                                                                                                               | Fails if                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `tests/integration/outlook-mail-addon-pairing.test.ts` | A code works once. An expired code fails. A second code replaces the first. User B cannot see user A's codes or tokens. | Reuse, expiry or RLS is broken       |
| same                                                   | A revoked token gets 401 on the next upload                                                                             | Revoke does not take effect          |
| `tests/integration/outlook-mail-addon-upload.test.ts`  | A judge that exceeds 90 seconds yields `retry` and the cursor does not move                                             | Partial state is stored              |
| same                                                   | Canary search as in slice 1, through the HTTP route and the request logger                                              | Body leaks to logs or tables         |
| `apps/outlook-mail-addon/src/outlook-reader.test.ts`   | Reader against the same fixture inbox as slice 2. Restores unread.                                                      | Reader drifts from the server reader |
| `tests/e2e/outlook-mail-addon-flow.spec.ts`            | Blocked screen shows the code, New code replaces it, the row shows Browser add-on and Revoke                            | Screens not wired                    |

**Live proof.** Ben loads the developer build in his own browser, pairs with a dev instance, and leaves Outlook open on his existing inbox (no test sends). The row shows the read time and the note gets the entry. Recorded on PR B.

**Verification**

```bash
pnpm test:e2e tests/e2e/outlook-mail-addon-flow.spec.ts > /tmp/wm4-e2e.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
pnpm verify:static > /tmp/wm4-static.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
```

Integration through `verify-gate`, expect exit 0.

**Release note (PR B).** Category Added. Title "Outlook mail through a browser add-on". Description: "If your organisation blocks the usual Outlook sign-in, you can pair a small browser add-on so Moss can read new work mail while Outlook is open."

---

### Slice 5. Add-on download and signing

PR C.

**Files**

- `apps/outlook-mail-addon/build.ts` (Firefox and Chrome packages from one source)
- `.github/workflows/outlook-mail-addon-release.yml` (build, sign Firefox through the add-ons site's unlisted signing, attach to a release)
- `packages/connectors/src/outlook-mail-addon-download.ts` (serves the signed Firefox package and its update manifest)
- `apps/web/src/settings/settings-outlook-connect.tsx` (Download button picks the package for the browser in use)

**Routes**

| Method | Path                                                  | Auth                   |
| ------ | ----------------------------------------------------- | ---------------------- |
| GET    | `/api/connectors/outlook-mail/addon/download/firefox` | session                |
| GET    | `/api/connectors/outlook-mail/addon/updates.json`     | none; static file only |

**Rules**

- Moss serves the signed file bundled in the image. It never builds or signs at run time.
- Signing keys live in CI secrets only.
- Chrome and Edge get the unlisted store link once it exists. Until then the Download button offers Firefox, and Chrome users see only the server-window link.

**Tests**

| File                                                    | Behaviour                                                                                                       | Fails if                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `tests/integration/outlook-mail-addon-download.test.ts` | Download needs a session, returns the bundled file with the right type, and its hash matches the release record | Unsigned or wrong file served |
| `tests/e2e/outlook-mail-addon-flow.spec.ts`             | Download button links to the Firefox package on Firefox and to the store or the server link on Chrome           | Wrong offer per browser       |

**Live proof.** A clean Firefox profile installs the add-on from a dev instance's Download button with no warning beyond Firefox's normal install prompt.

**Release note (PR C).** Category Added. Title "Download the Outlook add-on from Moss". Description: "Moss now offers its Outlook add-on for download, ready to install in Firefox."

---

### Slice 6. Other users (blocked on #3570)

Starts only after #3570's managed collector and Settings onboarding merge. Planned in detail then; listed here so the dependency is visible.

- The mail read moves from the env binding to the per-user connection list #3570 introduces.
- The "Use the server window" link opens #3570's onboarding for any user.
- The mail grant stays separate from the calendar grant.
- Test: two users, two profiles, each user's mail read reaches only their own notes and cursor.

## 6. Dependencies

| Item                                              | Depends on #3570                                |
| ------------------------------------------------- | ----------------------------------------------- |
| Slices 1 to 3                                     | No. Operator-bound owner only.                  |
| Slices 4 and 5                                    | No. The add-on runs in each user's own browser. |
| Slice 6                                           | Yes.                                            |
| Server-window link for anyone but the bound owner | Yes. Hidden until then.                         |

## 7. Ben's rulings (2026-10-26)

| #   | Ruling                                                                                                                                 | Applies to               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| B1  | Keep the "Sign in with Microsoft" screen, but disabled, saying it is not available yet. No Microsoft sign-in connector is built.       | Slice 3                  |
| B2  | Build the server window first, then the add-on.                                                                                        | Order                    |
| B3  | Live tests and live proofs use mail already in Ben's inbox. No test messages are sent.                                                 | L1 to L5, slices 3 and 4 |
| B4  | Moss never changes the inbox sort.                                                                                                     | Slice 2                  |
| B5  | The blocked screen shows the Moss address beside the pairing code: "Enter this address and code in the add-on".                        | Slice 4                  |
| B6  | A note whose front matter has `private: true` is never a destination.                                                                  | Slice 1                  |
| B7  | Default destination is a "Work mail notes" note: in the notes folder when linked, else in the private Moss vault.                      | Slice 1                  |
| B8  | Read interval fixed at 30 minutes and cap at 25 messages. Free-text preferences steer only what counts as important and where it goes. | Slices 1, 2              |

No open questions remain for slices 1 to 5.

## 8. Rulings ledger

Facts and decisions found while planning, kept so nobody re-derives them.

| #   | Kind                 | Finding                                                                                                                                                                      | Evidence                                                                                   |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| R1  | Decision             | Mail runs in the calendar job handler after the sync, not on its own queue                                                                                                   | `outlook-calendar-jobs.ts:23-29`; `outlook-calendar-browser.ts:329`                        |
| R2  | Decision, pending L5 | Mail reads in a separate tab; the calendar filter ignores it                                                                                                                 | `outlook-calendar-browser.ts:279-286`                                                      |
| R3  | Decision             | `EmailReadProvider` is not used; it feeds stored mail                                                                                                                        | `email-read-provider.ts:15-30`                                                             |
| R4  | Decision             | Pipeline lives in connectors with injected ports; adapters live in module-registry                                                                                           | `packages/connectors/package.json`; `module-registry/src/index.ts:1985-1992`, `:2969-2990` |
| R5  | Decision             | Cursor is per user, stores time plus salted hash only, no sender or subject                                                                                                  | Spec "Privacy and rules"; app.preferences precedent `outlook-calendar-jobs.ts:51`          |
| R6  | Decision             | New scope `outlook-mail.read`, recognised by `accountHasEmailScope`; email sync still excludes the account by provider type                                                  | `feature-grants.ts:48-57`; `email-refresh.ts:139-143`                                      |
| R7  | Decision             | Server window before add-on                                                                                                                                                  | F4                                                                                         |
| R8  | Fact                 | Calendar runs every 5 minutes, not 30; mail keeps its own 30-minute gate inside that job                                                                                     | `outlook-calendar-jobs.ts:182`                                                             |
| R9  | Fact                 | Companion pairing exists and was not reused                                                                                                                                  | `packages/auth/src/companion-pairing.ts:21-83`; F3                                         |
| R10 | Fact                 | Module routes without a session reach their handler, so bearer auth works on a manifest route                                                                                | `route-guard.ts:316-322`                                                                   |
| R11 | Fact                 | Structured prompts are capped at 64 KB                                                                                                                                       | `schema-bounds.ts:4`                                                                       |
| R12 | Fact                 | Firefox unlisted signing needs a one-time developer account for the project, not for each user. Spec's "no store account" holds for users only.                              | Mozilla signing policy; not in the tree                                                    |
| R13 | Not cited            | Whether structured AI calls persist prompt text anywhere. No insert of prompt text found in a grep of `packages/ai/src`, but not proven. The slice 1 canary test settles it. | —                                                                                          |
| R14 | Not cited            | A user-marked private note                                                                                                                                                   | B6                                                                                         |
| R15 | Not cited            | A Microsoft sign-in connector                                                                                                                                                | B1                                                                                         |
