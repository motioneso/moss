# Rust Phase 5: Email and Connectors port plan

Part of https://github.com/motioneso/moss/issues/4027. This is a planning document. It builds
nothing. It follows the rules in `2026-11-06-rust-port-plan.md` (Phase 5, section 3.6) and
`2026-11-07-rust-module-packages-and-registry-design.md` (sections 5 and 7), and the pattern used
by `2026-11-08-rust-phase5-tasks-report.md`.

Every claim about the old TypeScript app was read from the files named below. Anything marked
**Guess** is my inference and needs checking before a builder relies on it.

## 1. Summary

- Two legacy packages make up this work. `packages/email` is small (about 1,400 lines of
  TypeScript) and owns the cached message list, two small settings and three chat tools.
  `packages/connectors` is large (58 source files, about 15,000 lines) and owns connected
  accounts, Google and IMAP sync, the Outlook calendar reader, email understanding (summaries,
  sorting, action tracking), the Today refresh button and the shared "source context" that
  briefings and chat read.
- Calendar is already ported and is waiting on this work. Its package calls a package named
  `connectors` for `createCalendarEvent`, `deleteCalendarEvent`, `rescheduleCalendarEvent` and
  `listCalendarContext` (`modules/calendar/src/provider_tools.rs`). Today those calls fail closed.
  Building Connectors unblocks the Calendar parts that need live provider writes and busy times.
- The Rust host's credential broker only speaks HTTP (header, basic-auth or body field). IMAP and
  SMTP are not HTTP, so they cannot go through it. The plan adds a host-side connector service
  that holds the secrets and does the raw mail protocols (section 4.3).
- The work splits into 13 parts (section 6). Part 1 needs no outside account and no new
  dependency. Parts that need new third-party Rust crates are flagged, because the box rule is
  that Ben approves new tools.

## 2. What the legacy modules do

Plain-language behaviour first, then the files each part lives in.

### 2.1 Connections (Settings, Connections)

People connect a mail and calendar account in one of three ways.

| Way           | What the person does                                                                                                                                                                            | Files                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google        | Makes their own "Desktop app" OAuth client, signs in, copies the failed `localhost` address back into Moss. Moss swaps the code for tokens on the server (ADR 0006)                             | `oauth.ts`, `google-connection.ts`, `google-capabilities.ts`, `routes.ts`, web `settings-google-connect.tsx`, `use-google-connect-flow.ts`, `onboarding/google-connector-step.tsx`, tool `startGoogleGuidance` |
| IMAP and SMTP | Picks a preset (Yahoo, Proton Bridge, iCloud, Fastmail) enters the account name and password, tests the connection, saves. Host, port and TLS come only from the preset, never from the request | `imap-presets.ts`, `imap-connection.ts`, `imap-probe-client.ts`, `imap-secret.ts`, `imap-capabilities.ts`, web `settings-imap-connect.tsx`                                                                     |
| Outlook web   | Binds a browser helper that reads the Outlook calendar page. Calendar only, no mail                                                                                                             | `outlook-calendar-*.ts` (browser, source, jobs, routes, config, availability), web `calendar/outlook-calendar-status.tsx`                                                                                      |

Each account has a safe summary (provider, status, last sync, error label) that the UI and admins
can see. The secret never leaves the server. Per account, a person can switch Email and Calendar
use on or off (feature grants, `feature-grants.ts`, `feature-grant-service.ts`). A missing grant
means on. People can revoke an account. Admins see a safe list of everyone's accounts, with no
secrets and no mail.

### 2.2 Sync

| Behaviour                                                                                                                                                                                                                                                  | Files                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google sync runs every 15 minutes per account and on demand. It walks Gmail (last 30 days, history id for later runs) and Google Calendar in chunks that hand off before the 840 second job limit. Transient rate limits retry. Permission refusals do not | `sync-jobs.ts`, `google-sync-phases.ts`, `google-sync-sweep.ts`, `google-sync-payload.ts`, `google-sync-history.ts`, `google-api-client.ts`, `google-schedule.ts` |
| IMAP sync runs every 15 minutes per account (the schedule key is the account, not the person)                                                                                                                                                              | `imap-sync-jobs.ts`, `imap-schedule.ts`, `imap-email-read-provider.ts`, `imap-message-key.ts`                                                                     |
| Sync records start, finish, counts, error detail and previous run on the account. Error detail keeps only a status and a short reason token, never a provider body                                                                                         | `google-sync-phases.ts` (`toSyncErrorDetail`), `sync-in-progress.ts`, `connection-diagnostics.ts`                                                                 |
| A sign-in-code email keeps no preview, so the code never lands in a column other readers use                                                                                                                                                               | `google-sync-phases.ts` (`cachedEmailInput`)                                                                                                                      |

### 2.3 Email understanding

Each synced message is read by the person's AI model through the router and stored with a short
summary and a set of signals. The summary is the only model-written prose kept, with a hard length
cap and a rule against copying the body verbatim.

| Behaviour                                                                                       | Files                                                                      |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Extract a summary and signals from a bounded body                                               | `email-extract.ts`, `extract-deps.ts`, `email-prompt-input.ts`             |
| Sort mail by six yes/no questions, with the answer turned into a verdict by code, not the model | `email-sorting.ts`, `email-sorting-live.ts`, `email-sorting-comparison.ts` |
| Second look that stops a "maybe owed" answer becoming an obligation without evidence            | `email-gate.ts`                                                            |
| Spot bulk and list mail as a hint, never a filter                                               | `email-bulk-rule.ts`                                                       |
| Settle the person's own sent mail                                                               | `own-sent.ts`                                                              |
| Hide action rows the person dismissed and resurface them when evidence changes                  | `action-suppression-repository.ts`, `action-row-relevance.ts`              |
| Give up on a message after repeated failed analysis, reset when Gmail revises it                | `google-sync-phases.ts`                                                    |
| Record triage feedback                                                                          | table `email_triage_feedback` (SQL 0141)                                   |

### 2.4 Today refresh and proactive checks

- The Today screen has a "refresh email" control. It asks every eligible account to sync now,
  shows per account progress, and lets the person retry a failed account
  (`email-refresh.ts`, `email-refresh-jobs.ts`, web `today/today-email-refresh.tsx`).
- Proactive monitors check email every 15 minutes and calendar every 30 minutes and raise cards or
  alerts, with a stored health record (`monitor-jobs.ts`, `monitor-schedule.ts`, email
  `monitor-provider.ts`).

### 2.5 What other modules and chat read (source context)

Briefings, chat and Calendar read mail and events through a shared "source context" service. It
lists the newest messages live per account, falls back to the cache, bounds the number of fresh
model triages per read and the time spent, and reports per account whether the answer was live or
cached and why it was degraded (`source-context/*.ts`, `email-read-provider.ts`,
`email-tasks.ts`, `email-action-links.ts`, email `thread-provider.ts`). Email also feeds "capture
tasks" mode, which turns mail into task suggestions (`/api/email/task-creation-mode`).

### 2.6 Email package

| Part                                                                                    | Files                                                                                    |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Cached message list and detail, owner-or-share rules                                    | `packages/email/src/repository.ts`, `routes.ts`, SQL 0012, 0021, 0067 to 0249            |
| Settings screen (briefing inclusion, task capture, thread summaries, send on my behalf) | `packages/email/src/settings/index.tsx`, `manifest.ts`                                   |
| Chat tools                                                                              | `tools.ts`                                                                               |
| Reply building (threading headers, plain text body)                                     | `reply-mime.ts` (threading headers), `email-write-service.ts`, `email-write-provider.ts` |
| Provider send                                                                           | `google-email-write-provider.ts`, `imap-email-write-provider.ts`                         |

### 2.7 Work mail capture

A separate small pipeline copies selected work mail into the person's notes, skipping any note
marked private in its front matter (`work-mail/*.ts`, feature id `structured.connectors.work-mail`).
**Guess** that this is a niche feature. It ports last and may be deferred (part 13).

## 3. Parity checklist

Each line becomes a test or a recorded proof in the part named in the last column.

### 3.1 Routes

| Route                                              | Part |
| -------------------------------------------------- | ---- |
| `GET /api/connectors/providers`                    | 1    |
| `GET /api/connectors/accounts`                     | 1    |
| `POST /api/connectors/accounts`                    | 1    |
| `PATCH /api/connectors/accounts/:id`               | 1    |
| `POST /api/connectors/accounts/:id/revoke`         | 1    |
| `GET /api/connectors/accounts/:id/feature-grants`  | 1    |
| `PUT /api/connectors/accounts/:id/feature-grants`  | 1    |
| `GET /api/admin/connectors/accounts`               | 1    |
| `GET /api/email/messages`                          | 3    |
| `GET /api/email/messages/:id`                      | 3    |
| `GET /api/email/briefing-settings`                 | 3    |
| `PATCH /api/email/briefing-settings`               | 3    |
| `GET /api/email/task-creation-mode`                | 3    |
| `PUT /api/email/task-creation-mode`                | 3    |
| `POST /api/connectors/imap/test-connection`        | 4    |
| `POST /api/connectors/imap/connect`                | 4    |
| `POST /api/connectors/google/authorize`            | 6    |
| `POST /api/connectors/google/complete`             | 6    |
| `POST /api/connectors/google/sync`                 | 7    |
| `POST /api/connectors/email-refresh`               | 9    |
| `GET /api/connectors/email-refresh/:refreshId`     | 9    |
| `GET /api/connectors/outlook-calendar`             | 12   |
| `POST /api/connectors/outlook-calendar/connect`    | 12   |
| `POST /api/connectors/outlook-calendar/refresh`    | 12   |
| `POST /api/connectors/outlook-calendar/disconnect` | 12   |

The status codes seen in `routes.ts` are 200, 201, 202 and 404 (not found, which also stands in
for "not yours"). Part builders re-read each handler for exact error bodies. **Guess** that no
route returns 403 for another person's account, since the 404 is the private-by-default shape.

### 3.2 Background jobs

| Queue                                 | What it does                               | Part |
| ------------------------------------- | ------------------------------------------ | ---- |
| `connectors.google-sync`              | One Google sync run for one person         | 7    |
| `connectors.google-sync-continuation` | Next chunk of a long Google sync           | 7    |
| `connectors.google-sync-sweep`        | Schedule reconciliation                    | 7    |
| `connectors.imap-sync`                | One IMAP sync for one account              | 5    |
| `connectors.email-refresh-dispatch`   | Start a Today refresh                      | 9    |
| `connectors.email-refresh-account`    | Refresh one account                        | 9    |
| `connectors.email-refresh-sweep`      | Clean up stale refreshes                   | 9    |
| `connectors.email-monitor`            | Email proactive check, every 15 minutes    | 10   |
| `connectors.calendar-monitor`         | Calendar proactive check, every 30 minutes | 10   |
| `connectors.outlook-calendar`         | Outlook page scan                          | 12   |

Payloads stay metadata only (person id, account id, kind, key). The IMAP password and tokens never
appear in any payload.

### 3.3 Settings and preferences

- Email module settings: include in briefings, capture tasks (mode), thread summaries, send on my
  behalf, skip sign-in-code emails, keep receipts out of the briefing, flag only real obligations,
  answered conversations, proactive current-access check (parts 3 and 8).
- Per-account feature grants for Email and Calendar (part 1).
- Connection health, with the exact values `connection-diagnostics.ts` emits. Mail accounts use never-synced, healthy, sync-partial, sync-failed, error and revoked. Outlook uses healthy, partial, stale, collecting, disconnected, sign-in-needed, source-changed and settings-not-found. Part 1 keeps each value and its mapping. Parts 5 to 7 write the sync fields that feed them.
- Source behaviours settings that read connectors (`settings-source-behaviors.ts`). **Guess**
  these only need the safe account summary. Part 1 confirms.

### 3.4 Screens

| Screen                                        | Web file                                                    | Part                                                 |
| --------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------- |
| Settings, Connections list                    | `settings-connections-pane.tsx`                             | 1                                                    |
| Email module settings                         | `packages/email/src/settings/index.tsx`                     | 3                                                    |
| IMAP connect form and test                    | `settings-imap-connect.tsx`                                 | 4                                                    |
| Google connect guide                          | `settings-google-connect.tsx`, `use-google-connect-flow.ts` | 6                                                    |
| Onboarding connector step (Google and member) | `onboarding/*connector*.tsx`                                | 6                                                    |
| Today email refresh control                   | `today/today-email-refresh.tsx`                             | 9                                                    |
| Briefing freshness and action rows            | `today/briefing-freshness.tsx`, `briefing-action-rows.tsx`  | 10 (read side only, the screens belong to Briefings) |
| Outlook calendar status                       | `calendar/outlook-calendar-status.tsx`                      | 12                                                   |
| Admin connections audit lines                 | `settings-admin-panes.tsx`, `settings-audit*.ts`            | 1                                                    |

All screens are redone as package screens under the Park Press design system and the module frame
(registry design section 7, rule 6). No new screen design is needed beyond what exists, but
CLAUDE.md requires front-end agreement for a new module. Email already exists, so each part
reproduces the current screen. Anything new gets Ben's mockup sign-off first.

### 3.5 Chat tools

| Tool                             | Risk        | Part |
| -------------------------------- | ----------- | ---- |
| `email.listVisibleMessages`      | read        | 10   |
| `email.draftReply`               | write       | 11   |
| `email.sendReply`                | destructive | 11   |
| `calendar.listLiveEvents`        | read        | 10   |
| `connectors.startGoogleGuidance` | read        | 6    |
| `gmail.searchLive`               | read        | 10   |
| `gmail.getLiveMessage`           | read        | 10   |

Other connector features declared in the manifest (`connectors.google_sync`,
`connectors.imap_sync`, `connectors.email_refresh`, with reconnect and retry remediations) are app
map entries and move with their parts.

### 3.6 Public API the other modules call

Calendar, Briefings and Tasks reach these through `requires`. The Rust package must expose them
under the same names (parts 10 and 11).

- `listCalendarContext`, `createCalendarEvent`, `deleteCalendarEvent`, `rescheduleCalendarEvent`
- source context reads for email, calendar and email-derived tasks
- `listThreadsWithNewerMessages` (thread provider)
- email read provider (`listVisible` with per-account live or cache outcome)

### 3.7 Errors and degraded outcomes

The user-visible ones to preserve (each needs a test and an app-map remediation).

- No account connected, account revoked, sign-in needed, scan incomplete, helper unreachable.
- Google refusal by status and reason token, rate limit retry, permission refusal not retried.
- IMAP wrong password, unreachable host, certificate failure, Proton Bridge not running.
  **Guess** the exact messages live in `imap-probe-client.ts` and the web form. Part 4 lists them.
- Per-message analysis given up after repeated failure.
- Refresh failed for one account with the others succeeding.
- Read outcome `source: live | cache` with `degradedReason`.
- Calendar creation refused when the Outlook source is stale or incomplete.
- Send reply refused without approval, or when "send on my behalf" is off.

## 4. Outside accounts, stand-ins and secrets

### 4.1 What needs a real outside account

| Piece                                           | Real account needed  | Stand-in possible                                                |
| ----------------------------------------------- | -------------------- | ---------------------------------------------------------------- |
| Account store, grants, health model, admin list | No                   | Not needed                                                       |
| Email cache, routes, settings, tools            | No                   | Rows written by a sync fixture                                   |
| IMAP connect, test, sync, send                  | Only for final proof | Yes, a local IMAP and SMTP server                                |
| Google OAuth code exchange and refresh          | Only for final proof | Yes, a local server that mimics Google's token and API endpoints |
| Gmail and Google Calendar sync and writes       | Only for final proof | Yes, same local server, fed by recorded response shapes          |
| Outlook web calendar                            | Yes                  | Partly. A saved page fixture can test parsing, not sign-in       |
| Real model summaries and sorting                | A configured model   | Yes, a fixed fake model for CI, the real router for live proof   |

### 4.2 What CI can prove and what needs Ben

CI, with no outside account.

- Every route, job and tool above against the local stand-ins.
- The secret rules (section 4.3), each seen failing with the protection removed.
- Old data compatibility. A connector secret written by the TypeScript app decrypts in Rust, and
  one written by Rust decrypts in TypeScript, using fixtures made from the old code.
- Row level security (a second person cannot read or change an account, message or grant).
- Native and WebAssembly builds of the packages, and the live run on the Rust server over HTTPS.

Needs Ben, or an account he provides.

- One real Google sign-in with a test Google Cloud client, then one sync of mail and calendar and
  one calendar write. A throwaway Google account is better than his own. **Guess** that Ben's
  existing dev connection works for this.
- One real IMAP account (a throwaway Fastmail or similar) for sync and send.
- One real Microsoft 365 sign-in for Outlook. The Outlook helper was stopped on 2026-11-07 because
  work blocked web access, so this proof may stay open (part 12).
- A second physical device reaching the connect screens, as the other Phase 5 modules require.

Stand-ins are checked against real responses once, recorded in a fixture file with all personal
data removed. If the stand-in drifts from the real service, only a real account notices, so the
final parts always ask for one real pass.

**Guess** that a Rust stand-in for IMAP and SMTP is better than reusing GreenMail. The old UAT
used a GreenMail container (`tests/uat/specs/3467-greenmail.ts`), which needs Docker and Java. The
Rust app is leaving Docker, and CI jobs should not need a container. Part 2 decides after a short
check of which Rust IMAP server crate, if any, Ben is willing to add.

### 4.3 Secrets

How the old app does it.

- Account secrets are AES-256-GCM envelopes in `connector_accounts`, written and read only through
  `ConnectorSecretCipher` (`packages/connectors/src/crypto.ts`), bound to the label
  "connector secret" and the key ring `JARVIS_CONNECTOR_SECRET_KEY`, `_KEY_ID`, `_KEYS`.
- Google secrets hold client id, client secret and tokens. IMAP secrets hold host, port, user and
  password and the SMTP settings (`imap-secret.ts`).
- Responses and the admin list carry a safe summary only. Job payloads carry ids only.
  Sync errors keep a bounded status and reason token, never a provider body.

How the Rust host already handles it.

- `rust-spike/portability/src/secrets.rs` ports the same envelope format, key ring variables and
  nested family keys, so existing connections survive (port plan section 3.6).
- `rust-spike/module-host/src/credentials.rs` is the brokered credential port. The module names a
  credential, the host attaches it only to hosts bound in the manifest, runs token exchange and
  refresh inside the host, strips tokens from the response and marks headers sensitive. Guests
  never see values.
- `rust-spike/keystore` holds the key files and recovery bundle.

What is missing, and the plan.

1. The broker is HTTP only. Google's HTTP calls fit it. IMAP and SMTP do not. Part 4 adds a
   host-side `connectors` service (the `connectors@1.x` port named in the registry design) that
   opens IMAP and SMTP sessions itself from the decrypted secret and returns only mail data. The
   secret never crosses into the package.
2. The legacy secret is one envelope per account in `connector_accounts`, with the legacy table
   kept byte for byte. Part 1 reads and writes that exact shape. It does not move secrets into the
   host's own credential store, since that would break the TypeScript app during the support
   window. **Guess** that this is right, since registry design section 7 rule 2 keeps old SQL
   unchanged.
3. Every part that touches secrets includes sentinel tests. Plant a marker password and marker
   tokens, run the feature, then search logs, job payloads, route responses, AI prompts, error
   text and exported data for the marker. The test is first run with the protection removed to
   see it fail.
4. Google's token endpoint call needs the client secret in the request body. It runs host side
   (part 6), not in the package.

## 5. Design decisions

1. **Connectors is a package, and a host service sits under it.** Calendar already calls a
   package named `connectors`, so the package id stays. It owns the tables, routes, jobs, sync
   logic and public API, as WebAssembly where it can. Raw sockets (IMAP, SMTP) and secret custody
   sit in a new host service behind a brokered `connectors` port. This matches the registry
   design (section 5.1 lists a `connectors` port, built in Phase 5). **Guess** that the sync loop
   fits the WebAssembly speed budget. If it misses, it is on the native list (rule 10), measured
   in part 5.
2. **Email is a thin package that requires Connectors.** It owns the message cache tables and its
   three chat tools and two settings. Connectors writes into the cache through Email's public API,
   not by touching its tables (module isolation). **Guess** that the TypeScript code reaches into
   `email_messages` directly from connectors. If so, part 3 defines the public insert API and the
   legacy SQL ownership stays as is.
3. **Legacy SQL stays byte for byte** in `packages/connectors/sql` and `packages/email/sql`.
   Both declare `"ledger": "core-legacy"`.
4. **Model calls go through the router.** No provider or model names. The email sorting and
   extraction prompts keep the current prompt rules.
5. **Google loopback catch.** On desktop the Rust app can catch the redirect itself, removing the
   copy-paste. Part 6 keeps copy-paste working first (it works headless, on a phone and on a
   remote server) and adds the catch as a follow-up.

## 6. Build parts

Sizes are by complexity (S, M, L), not time. Each part is one builder window. Order is dependency
order. Every part ends with the module's live check on the real Rust server over HTTPS and from a
second device when the part has a screen, and writes its checkpoint into
`docs/superpowers/specs/2026-11-xx-rust-phase5-connectors-report.md` (the plain-English report).

| Part | Scope                                                                                                                                                                                                                                                                                                                                      | Size | Depends on                   | Proof                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Connectors package skeleton and account store. Legacy tables read and written byte for byte, safe summary, health model, feature grants, providers list, accounts list, create, update, revoke, admin safe list, Connections settings screen and its app map. Secret envelope read and write through the existing Rust cipher. No network. | M    | none                         | Route parity tests, RLS test with a second person, sentinel secret test seen failing first, a TypeScript-written envelope decrypts and the reverse, live Connections screen on Rust server |
| 2    | Stand-in servers for tests. A local fake Google (token endpoint, Gmail list and message, history, send, Calendar list and write) and a fake IMAP and SMTP server, plus fixtures made from real response shapes with personal data removed. Test crate only, shipped nowhere.                                                               | M    | none (parallel with 1)       | The stand-ins pass their own contract tests, and a reviewer reads each fixture for personal data. **Needs Ben** if a new Rust crate is wanted                                              |
| 3    | Email package. Message table access, list and detail routes, briefing settings, task capture mode, Email settings screen, app map. Public API for Connectors to insert and update cached messages. Rows come from a fixture writer.                                                                                                        | M    | 1                            | Route parity tests, RLS, owner-or-share check, native and WebAssembly builds, live Email settings screen                                                                                   |
| 4    | Host `connectors` service for IMAP and SMTP. IMAP presets, `test-connection`, `connect`, the connection form screen, certificate and wrong password errors, secret custody in the host. **New crates needed (IMAP client, SMTP client, message parser)**, so Ben approves the list first.                                                  | L    | 1, 2                         | Connect and fail cases against the IMAP stand-in, sentinel test that the password never reaches package logs, responses or payloads                                                        |
| 5    | IMAP sync and read. 15 minute schedule per account, message parse, cache write through Email's API, sync record and health, sync in progress, message key. Measure the WebAssembly speed budget here.                                                                                                                                      | L    | 3, 4                         | Sync against the stand-in including a changed and a deleted message, schedule reconciliation, job payload check                                                                            |
| 6    | Google connect. Authorize and complete routes, redirect parse, token exchange and refresh in the host, scopes, Google connect screen, onboarding connector step, `startGoogleGuidance`. Desktop loopback catch as an optional last step.                                                                                                   | L    | 1, 2                         | Full connect, refresh and revoked-token cases against the Google stand-in, sentinel tests for client secret and tokens, live screen                                                        |
| 7    | Google sync. Gmail walk and history, Calendar phase, chunked hand-off, transient retry, give-up rule, sync detail, sweep, `POST /google/sync`, 15 minute schedule.                                                                                                                                                                         | L    | 3, 5 (shared sync record), 6 | Sync, retry and hand-off against the stand-in, error detail never carries a provider body                                                                                                  |
| 8    | Email understanding. Extract, sorting, gate, bulk hint, own-sent, action suppression, triage feedback, analysis attempts, remaining Email settings. All model calls through the router.                                                                                                                                                    | L    | 5 or 7 (needs cached mail)   | Fixed fake model run in CI, prompt rule checks, summary cap and verbatim-copy rule, sign-in-code rule, live run with the configured model                                                  |
| 9    | Today refresh. Both refresh routes, dispatch, per-account and sweep queues, retry, the Today control (shared with the Today shell owner).                                                                                                                                                                                                  | M    | 5, 7                         | Partial failure case, retry case, queue payload check, live Today control                                                                                                                  |
| 10   | Source context and read tools. `email.listVisibleMessages`, `gmail.searchLive`, `gmail.getLiveMessage`, `calendar.listLiveEvents`, `listCalendarContext`, thread provider, monitor provider, proactive email (15 minute) and calendar (30 minute) monitors. Replaces Calendar's fail-closed read path.                                     | L    | 7, 8                         | Live or cache outcome and degraded reasons, model budget limits, Calendar's busy-time check running against real cached events                                                             |
| 11   | Writes. `email.draftReply`, `email.sendReply` (approval), reply building and threading, Google and IMAP send, `createCalendarEvent`, `deleteCalendarEvent`, `rescheduleCalendarEvent`. Unblocks Calendar's provider writes.                                                                                                                | L    | 4, 6, 10                     | Approval required and consumed once, threading headers, send reaches the stand-in, Calendar day-plan apply runs end to end                                                                 |
| 12   | Outlook web calendar. Browser port, scan, source, jobs, routes, status screen.                                                                                                                                                                                                                                                             | M    | 1, 10                        | Saved page fixture parses. **Needs Ben** for a real Microsoft 365 sign-in, and the helper must be running again. May stay open                                                             |
| 13   | Remainder. Work mail capture to notes, admin audit lines, diagnostics, packaging of both modules for the registry, upgrade check from an existing install, whole-module live pass with one real Google and one real IMAP account.                                                                                                          | M    | 1 to 12                      | **Needs Ben** for the real account pass. Existing-install upgrade run on a copy of the dev data                                                                                            |

Thirteen parts, within the 10 to 15 asked for. Parts 2 and 3 can run alongside part 1 once part 1
settles the account table API. Parts 4 and 6 can run in parallel after parts 1 and 2. Parts 5
and 7 share the sync record, so they should not run at the same time.

## 7. Risks

- **New dependencies.** No IMAP, SMTP, or mail parser crates are in the workspace lockfile. Part 4
  cannot start until Ben approves a short crate list. Part 2 may ask for a test server crate.
- **Size.** About 15,000 lines of TypeScript is a lot of behaviour. The largest single files are
  `google-sync-phases.ts` and `email-extract.ts` (1,000 and 982 lines). **Guess** that parts 7 and
  8 need a split into two builder windows each. A builder says so at a clean point rather than
  compacting twice.
- **Calendar coupling.** Calendar's public API names are already fixed by its Rust code. A rename
  in Connectors breaks Calendar, so names and shapes are kept exactly.
- **Real-account drift.** Stand-ins can pass while the real service fails. Part 13 forces a real
  pass.
- **Outlook helper.** Stopped on 2026-11-07. Part 12 may be blocked for a long time without
  blocking the rest.

## 8. Not covered

Anything outside the two legacy packages, and any non-Rust work. Calendar's own remaining parts,
Briefings, Memory and Meetings stay with their own plans, except where they read through the
public API in section 3.6.
