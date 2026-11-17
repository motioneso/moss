# Rust Phase 5: Meals, Finance, Wellness and the rest port plan

Part of https://github.com/motioneso/moss/issues/4027. This is a planning document. It builds
nothing. It follows the rules in `2026-11-06-rust-port-plan.md` (Phase 5 and Phase 6). Finance and Meals
sit in Phase 6 in that plan and in the registry design. They are planned here because this task
covers every module still left, and no other plan covers them.
`2026-11-07-rust-module-packages-and-registry-design.md` (sections 5 and 7), and copies the
layout of `2026-11-11-rust-phase5-email-connectors-plan.md` and
`2026-11-13-rust-phase5-news-sports-weather-plan.md`.

Every claim about the old TypeScript app was read from the files named below. Anything marked
**Guess** is my inference and needs checking before a builder relies on it. Every other choice
is taken here as a **Decision**, with the reason. Only real product choices are left for Ben,
and they are marked **Ben**.

## 1. Summary

- Seven old modules are still not ported and are in scope here. Five live in `packages/`:
  **Commitments** (about 2,345 lines, 2 SQL files), **Goals** (about 1,244 lines, 3 SQL files),
  **Scratchpad** (about 897 lines, 1 SQL file), **Web Research** (about 1,517 lines, no SQL) and
  **Wellness** (about 5,130 lines, 16 SQL files). Two live in `external-modules/` as installed
  modules: **Meals** (about 14,964 lines, 27 SQL files, 20 owned tables) and **Finance** (about
  29,162 lines, 42 SQL files, 24 owned tables).
- **Recommendation.** Port them as seven registry packages, in this order: Scratchpad, Goals,
  Commitments and Web Research first (small, and Web Research unblocks the News described-topic
  gate left open by the News plan), then Wellness, then Finance, then Meals. Finance goes before
  Meals because the registry design (slice M12) says the package format must prove itself on
  Finance's bank-token exchange before Meals is rebuilt on it.
- **Finance and Wellness hold the most private data in Moss.** Bank balances, transactions and
  health check-ins, medications and therapy notes get a stronger proof floor than the other
  modules (section 6). No part in either module is done on stand-in proof alone where a real
  account exists to check against.
- The work splits into 38 parts (section 7). Screens are 9 separate parts, each held for Ben's
  agreement on the mockups before it is built. Parts that need new third-party Rust crates are
  flagged, because the box rule is that Ben approves new tools (section 7.2).

### 1.1 Skipped, and why

| Old code                                                                                                                                          | Why it is not in this plan                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workshop (`packages/workshop`)                                                                                                                    | Not ported (Ben, 2026-11-07). Redone later, most likely as a downloadable package. Excluded by this task's brief too.                                                                       |
| Food (spec `2026-08-18-926-food-nutrition-tracking.md`)                                                                                           | Not ported (Ben, 2026-11-07), and no old Food module exists to port. The spec describes a new module to be built later on the finished package platform. Excluded by this task's brief too. |
| Job Search (`external-modules/job-search`)                                                                                                        | Archived and cancelled. The Rust port plan lists it as archived (section 2.4). Its data stays archived under the companion rules and is not carried into a package.                         |
| Memory and embeddings                                                                                                                             | Already ported. See `2026-11-11-rust-phase5-memory-plan.md` and its report.                                                                                                                 |
| Calendar, Notes, People, Tasks, Email, Connectors, Meetings, Backtrack, Briefings, News, Sports, Weather                                          | Already ported or already planned and under way. Each has its own Phase 5 plan or report in this folder.                                                                                    |
| Sign-in, accounts, settings frame, chat and agents, AI router, vault, job queue, app map, notifications, workflows, structured state, Today shell | Core areas that stay in the host, not modules (registry design section 7). Notifications, workflows and structured state therefore get no package here.                                     |
| Focus Judgment, Priority, Source Behaviors, Datasets, Host Fetch                                                                                  | Host-side helpers with no routes and no screen of their own. They port inside the host work that already owns them (chat, Today, fetch). No part below, and no package.                     |

## 2. What the legacy modules do

### 2.1 Scratchpad

A quick note a person keeps beside chat. They can read it, replace it and append to it, and chat
can read and append with approval. Settings can connect it to a notes folder. Files:
`packages/scratchpad/src/` (`repository.ts`, `routes.ts`, `tools.ts`, `manifest.ts`), SQL 0216
(one table). Spec: `2026-09-04-scratchpad-design.md`.

### 2.2 Goals

Long-running goals shown as a section on Today. A person creates a goal, adds evidence to it and
closes it, and chat can manage goals with approval. Files: `packages/goals/src/`
(`repository.ts`, `routes.ts`, `tools.ts`, `jobs.ts`, `manifest.ts`), SQL 0123, 0182, 0300. Web:
`apps/web/src/today/goals-section.tsx`. Spec: `2026-06-27-long-running-jarvis-goals.md`.

### 2.3 Commitments

Moss reads email and chat and proposes commitments (things a person said they would do). A
person reviews each candidate, resolves it or suppresses it. An extraction job and an
email-judgement job feed the list, and a heartbeat surface shows it in chat. Files:
`packages/commitments/src/` (`extractor.ts`, `email-judgement*.ts`, `prefilter.ts`,
`repository.ts`, `routes.ts`, `tools.ts`, `jobs.ts`, `manifest.ts`), SQL 0125, 0220. Spec:
`2026-06-27-automatic-commitment-extraction.md`.

### 2.4 Web Research

A shared search and reading service other modules call. It searches the web through a provider,
reads pages with robots rules and rate limits, and refuses unsafe addresses. It owns no tables
and has no screen. News uses it for described topics, and its gate is the reason News topics
show a reason instead of stories today. Files: `packages/web-research/src/` (`providers.ts`,
`reader.ts`, `robots.ts`, `rate-limit.ts`, `url-safety.ts`, `tools.ts`, `manifest.ts`). Spec:
`2026-06-18-web-research-capability.md`.

### 2.5 Wellness

Daily health check-ins, medications and dose logs, therapy notes, trends and insights, and a
selective export a person can share. Insights are worked out in code from the person's own
rows (`insights.ts` says so at its head). No health text reaches a model. What consent gates
is the chat tools: with consent off they hand back nothing private and answer
`WELLNESS_CONSENT_REQUIRED` (`ai-consent.ts:35`). An export job builds a file and expires. This is health data and the most
private data in Moss alongside Finance. Files: `packages/wellness/src/` (check-ins, medications,
occurrence engine, therapy notes, insights, export and the rest), SQL 0082 to 0197 (16 files).
Web: `apps/web/src/wellness/` (today, history, trends, therapy notes, insights, charts). Specs:
`2026-06-13-p5-wellness-first-optional-module.md`, `2026-06-14-p5-wellness-design-taxonomy-insights.md`,
`2026-06-25-wellness-ai-consent.md`, `2026-06-25-wellness-selective-export.md`.

### 2.6 Meals

Plans a household's week of meals, then builds the shopping list, tracks the pantry and staples,
and logs what was cooked with nutrition estimates. A plan job fills each day, an estimate job
scores a log entry, and chat tools cover the kitchen, household, plan, list, pantry and log.
Files: `external-modules/meals/src/` (`domain/`, `cooking/`, `plans/`, `lists/`, `pantry/`,
`log/`, `estimator/`, `worker/`, `web/`), SQL 0001 to 0027, 20 owned tables, manifest
`jarvis.module.json` (version 0.9.1, 31 assistant tools, queues `meals.plan-day`,
`meals.log-estimate`, `meals.meal-job`). Spec: `2026-10-09-meals-meal-planning-design.md`.

**Decision.** Meals is not Food. Food (section 1.1) is a separate, later module about logging
what a person ate. Meals plans what a household will cook. The two keep separate tables and
separate packages, as they do today.

### 2.7 Finance

Manual and bank-connected accounts, transactions, budgets, bills, targets, reports and a CSV
import. Bank connection is through Plaid (hosts `production.plaid.com` and
`sandbox.plaid.com`). A sync sweep runs every six hours per person. Chat tools cover accounts,
manual entries, reconciliation, import, budgets, bills, rules, targets, cards and reports (65
assistant tools). Files: `external-modules/finance/src/` (`domain/` with about 70 files,
`adapters/plaid.ts`, `worker/`, `web/` with 7 screens), SQL 0001 to 0042, 24 owned tables,
manifest `jarvis.module.json` (version 0.7.8, 12 queues, one schedule). Specs:
`2026-07-18-finance-module-design.md`, `2026-10-08-finance-redesign-design.md` and the
`2026-10-28` to `2026-10-30` finance specs in this folder. Finance reads its Plaid client id and
secret and stores minted tokens itself today (`external-modules/finance/src/worker/auth-port.ts`).
That is the one place the registry design allows a plaintext-credential exception, and only if
the host exchange cannot express it (registry design section 5.1).

## 3. Parity checklist

Part numbers refer to section 7.

### 3.1 Routes

| Module      | Routes                                                                                                                                                                                                                                                                                                                                                                                        | Part  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Scratchpad  | `GET/PUT /api/scratchpad`, `POST /api/scratchpad/append`, `PATCH /api/scratchpad/settings`                                                                                                                                                                                                                                                                                                    | 1     |
| Goals       | `GET/POST /api/goals`, `GET/PATCH /api/goals/:id`, `POST /api/goals/:id/evidence`                                                                                                                                                                                                                                                                                                             | 4     |
| Commitments | `GET /api/commitments/candidates`, `GET /candidates/:id`, `PATCH /candidates/:id/status`, `POST /candidates/:id/resolve`, `POST /candidates/:id/suppress`, `POST /api/commitments/extract`, `GET /api/commitments/extraction-state`                                                                                                                                                           | 7     |
| Wellness    | `GET/PUT /api/wellness/ai-consent`, `GET/POST /api/wellness/checkins`, `PATCH /checkins/:id`, `GET/POST /api/wellness/medications`, `PATCH /medications/:id`, `GET /medications/schedule`, `POST /medications/:id/logs`, `GET /api/wellness/medications/logs`, `GET /api/wellness/insights`, `GET/POST /api/wellness/therapy-notes`, `DELETE /therapy-notes/:id`, `POST /api/wellness/export` | 13-15 |
| Finance     | No HTTP routes in the manifest. Every read and write goes through its assistant tools and worker queues, so parity is tool by tool (3.4)                                                                                                                                                                                                                                                      | 20-26 |
| Meals       | No HTTP routes in the manifest. Same shape as Finance                                                                                                                                                                                                                                                                                                                                         | 28-33 |

Source: `packages/<id>/src/manifest.ts` for the first five, `jarvis.module.json` for Finance
and Meals. Each part re-reads its handlers for exact error bodies. Web Research has no routes.
It is called through its tool and through other modules (3.5).

### 3.2 Background jobs

| Queue                                                                                                                                                                                                                                                                                                             | What it does                                                                            | Part   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------ |
| Integrations sorting queues                                                                                                                                                                                                                                                                                       | Sort a connection's tools with the owner's model                                        | 37     |
| Goals `goals-memory-sync` and `goals-memory-sync-reconcile`                                                                                                                                                                                                                                                       | Send each goal change to Memory and reconcile                                           | 5      |
| Commitments extraction and email-judgement queues                                                                                                                                                                                                                                                                 | Propose candidates from email and chat                                                  | 8      |
| Wellness medication reminder (declared, no worker yet) and wellness export                                                                                                                                                                                                                                        | The declaration ports as it is, with no worker. The export queue builds the export file | 14, 15 |
| `finance.sync-run` (sweep every 6 hours), `finance.connect-poll`, `finance.categorize-apply`, `finance.budget-apply`, `finance.share-apply`, `finance.storage-migrate`, `finance.draft-build`, `finance.draft-start`, `finance.draft-set`, `finance.review-apply`, `finance.activity-undo`, `finance.split-apply` | Bank sync and every queued Finance write                                                | 20-25  |
| `meals.plan-day`, `meals.log-estimate`, `meals.meal-job`                                                                                                                                                                                                                                                          | Fill one plan day, estimate one log entry, shared meal work                             | 29, 31 |

Payloads stay metadata only (person id, row id, kind, key). Bank tokens, amounts tied to a
person, health values and note text never appear in any payload.

### 3.3 Settings and preferences

- **Scratchpad**: connect to a notes folder (part 2).
- **Wellness**: AI consent on or off, time format, export choices (parts 13 and 15).
- **Finance**: bank keys are instance settings an admin holds. Finance keeps ten stored
  namespaces today (`finance.connections`, `accounts`, `transactions`, `categories`, `rules`,
  `snapshots`, `budgets`, `shared`, `settings`, `meta`). Parts 20 to 25 port each one with the
  data part that owns it. `finance.shared` is instance-wide and written by the module as a
  household mirror, so part 25 proves with two people that the mirror shows a person only
  what sharing allows. The start screen works with no bank keys at all (part 21).
- **Meals**: kitchen and household settings (part 28).
- **App map.** Each module's navigation, settings and features move into its `moss.module.json`
  in the part that builds the matching screen (registry rule 9).

### 3.4 Screens

All screens below already exist as built TypeScript screens. Each is an approved design to
reproduce, not a new design. Listed so none is lost.

| Screen                                                                                                                   | Approved design it reproduces                                                             | Part   |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------ |
| Scratchpad beside chat                                                                                                   | `2026-09-04-scratchpad-design.md` as shipped                                              | 3      |
| Goals section on Today                                                                                                   | `apps/web/src/today/goals-section.tsx` as shipped                                         | 6      |
| Commitments review in chat and Today                                                                                     | `2026-06-27-automatic-commitment-extraction.md` as shipped                                | 9      |
| Wellness today, history, trends, therapy notes, insights                                                                 | `apps/web/src/wellness/` as shipped, `2026-06-14-p5-wellness-design-taxonomy-insights.md` | 17, 18 |
| Wellness settings and export                                                                                             | `2026-06-25-wellness-selective-export.md` as shipped                                      | 18     |
| Finance budget, transactions, accounts, start, reports, settings, upcoming                                               | `jarvis.module.json` app map, `2026-10-08-finance-redesign-design.md`                     | 26, 27 |
| Meals plan, list, pantry, staples, recipe, household, settings, log and the plan helpers (swap, new, move, eaters, text) | `jarvis.module.json` app map, `2026-10-09-meals-meal-planning-design.md`                  | 34, 35 |

### 3.5 Chat tools and the public API other modules call

| Provider       | Consumer                  | Call                                                                                                    | Part   |
| -------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- | ------ |
| Scratchpad     | Chat                      | read and append tools, settings tools                                                                   | 2      |
| Goals          | Chat, Today               | goal management tools, Today section tool                                                               | 5      |
| Commitments    | Chat, Briefings           | review tools, heartbeat source                                                                          | 8      |
| Web Research   | News, Chat                | `web.research` search and read, the News described-topic gate                                           | 10, 11 |
| Wellness       | Chat, Briefings           | check-in, medication and insights tools. Briefings reads adherence counts only, never a medication list | 16     |
| Wellness       | Food (later)              | check-in context. Declared only, so the later Food module can ask what was logged before a check-in     | 16     |
| Finance        | Chat                      | the 65 assistant tools in `jarvis.module.json`                                                          | 22-25  |
| Meals          | Chat                      | the 31 assistant tools in `jarvis.module.json`                                                          | 30-32  |
| Finance, Meals | Account export and delete | data lifecycle sections for every owned table                                                           | 27, 35 |

Approval cards are drawn from the stored record, never from model text (News plan section 3.5
carries the same rule).

### 3.6 Errors and degraded outcomes

Each stays word for word, because tests and the app read them.

- **Finance.** Bank cannot sync (status, as-of dates and Reconnect shown on Accounts), stale or
  uncertain write (nothing saved, check saved records), duplicate found on import (Skip or
  Import anyway), closed account, unlinked transfer pausing totals.
- **Wellness.** No AI consent (no model call is made at all), export expired, dose already
  logged for a slot, therapy note not yours.
- **Meals.** Plan day job failed, estimate unavailable, pantry item not found.
- **Web Research.** Search provider off or unconfigured (the News gate reason), robots refusal,
  rate limited, unsafe address refused.
- **Commitments.** Extraction already running, candidate already resolved.

## 4. Outside services, and what needs a real account

### 4.1 Every live data source

| Source                           | Used by                                   | Key or account                                                                             | What a stand-in proves                                                                                                                                | What only the live service proves                                                                                   |
| -------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Plaid (bank feed)                | Finance                                   | **Yes.** Instance client id and secret, plus a per-person access token from linking a bank | Token exchange through the host, sync, balances, transactions, reconnect and every error shape, on recorded replies                                   | That a real bank links, that real balances and transactions arrive, and that the token still refreshes months later |
| CSV file from a bank             | Finance                                   | No. The person's own file                                                                  | Column, date and money-direction mapping, preview, duplicate choices, size caps (1 MiB, 200 rows) on fixture files                                    | That a real bank's export shape is handled. One file per bank a person actually uses                                |
| The person's model               | Commitments, Meals, Finance, Integrations | A configured model                                                                         | Extraction, judgement, plan drafting, restriction checks, estimates, categorising and tool sorting on canned replies, each checked against its schema | Quality on real email, real meal plans and real spending                                                            |
| Web search provider              | Web Research                              | Depends on the provider the install configures                                             | The gate and its reasons, search and read on recorded replies, robots and rate limits                                                                 | Real result quality and the provider's current limits                                                               |
| Any public page a search returns | Web Research                              | None                                                                                       | Reading, robots rules, private-address refusal on fixture pages                                                                                       | That real pages still read the same way                                                                             |
| Health sources and device data   | Wellness                                  | **None today**                                                                             | Not applicable                                                                                                                                        | Not applicable                                                                                                      |

**Decision on health sources.** Wellness today reads nothing from a watch, phone or health
service. Check-ins, doses and notes are typed in by the person (`packages/wellness/src/` has no
device or health-service client). This plan adds none. A health-source link is a new product
choice for Ben, not port work, so no part below builds one and no proof below needs a device.

**Decision on bank feeds.** Plaid is the only bank feed. There is no second feed to port. CSV
import is the no-account path and it ports in the same part as manual accounts, so Finance is
useful before any bank key exists, as the start screen already promises.

### 4.2 What CI proves and what needs Ben

CI proves, with no outside account: every route, tool and job above on recorded responses and
fixture files; bank-token custody with a fake token; row level security with two people; no
private text in logs; native and WebAssembly builds; each package's live run on the Rust server
over HTTPS.

Needs Ben, or something he provides:

- A Plaid sandbox account, then one real bank link (a throwaway or test bank first), for one
  live sync, balance and reconnect pass (parts 21 and 36).
- Approval of the crate list (section 7.2).
- One live pass per module from a phone or second device on the home network or tailnet
  (part 36).
- A configured model for the extraction, plan and estimate quality pass.
- A Brave Search key for one live search pass (part 11).

Stand-ins are checked against real responses once, recorded as fixture files with every
personal detail removed, as the stand-ins report did
(`2026-11-11-rust-phase5-standins-report.md`). A test fails on any address outside
`example.com` or the service's own public host.

## 5. Design decisions

### 5.1 Seams check

Every platform capability this plan assumes, checked against the current tree before planning.

| Assumed capability                                                  | Evidence in the tree today                                                                       | Verdict                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Packages, manifest v2, registry install and generated row security  | Registry design sections 3 to 5; ported packages under `modules/` (calendar, tasks and the rest) | Exists. Every part follows registry rule 7 (section 7 of that design)                                     |
| Public-web fetch for person-added addresses                         | `rust-spike/module-host/src/manifest.rs:305,557` and the News plan's part 1, now built           | Exists. Web Research reuses it and adds no new fetch mode                                                 |
| Brokered credentials with host-side token exchange                  | `rust-spike/module-host/src/credentials.rs:15,115`                                               | Exists. Part 19 checks whether it can express Plaid's exchange before any Finance data part starts        |
| Host account-preferences bindings for a saved place and a unit      | `rust-spike/module-host/src/account_preferences.rs:35,96`                                        | Exists, built for Weather. Wellness reuses the validated-binding shape for its own settings and adds none |
| Model calls through a capability router, with a strict reply schema | Email and News plans, parts already built                                                        | Exists. No part names a provider or a model                                                               |
| Typed job queues with metadata-only payloads                        | Ported modules under `modules/`, each with declared queues                                       | Exists                                                                                                    |

Anything not in this table is not assumed. In particular there is no health-source port and no
second bank-feed port, and this plan builds neither (section 4.1).

### 5.2 Packages and ledgers

Seven packages, `modules/scratchpad`, `modules/goals`, `modules/commitments`,
`modules/web-research`, `modules/wellness`, `modules/finance` and `modules/meals`, each with
`moss.module.json`, `ui/`, `icons/`, `CHANGELOG.md` and a crate in `src/`.

- The five `packages/` modules keep their SQL in `packages/<id>/sql` byte for byte and declare
  `"ledger": "core-legacy"`. Web Research owns no tables.
- Finance and Meals keep their SQL in `external-modules/<id>/sql` byte for byte and declare
  `"ledger": "module-legacy"`, with that ledger's hash rule (registry design section 3.6).
  **Decision.** Their SQL does not move into `modules/<id>/sql`, because the old module runner
  must keep reading it through the support window.
- All seven are registry packages from the first commit, bundled at first, optional and not
  installed by default where the old manifest already says so (Finance and Meals are
  `lifecycle: optional` today).

### 5.3 Finance bank tokens

**Decision.** Plaid's exchange runs in the host, as registry design section 5.1 plans. The
package names the credential and the hosts `production.plaid.com` and `sandbox.plaid.com`. It
never sees the client secret or the access token. Part 19 proves this on the Plaid stand-in
before any account data moves.

The registry design allows one exception. If part 19 finds an exchange the host cannot express,
Finance alone may ask for a `credentials.read` capability, first-party key only, shown on the
install screen. That is a **Ben** decision at that point, because it widens what a package can
see. No other module in this plan gets that capability, and no part assumes it.

### 5.4 Wellness consent and sharing

**Decision.** The AI consent switch ports exactly as it is. No Wellness data reaches a model
in the old app, and this plan adds no model call. With consent off, each Wellness chat tool
hands back nothing private, and a test reads what each tool returns in that state. Briefings
keeps reading adherence counts only. Nothing in Wellness is shared with another person in
this plan, because the old module shares nothing. Any sharing is a new product choice for Ben,
not port work.

### 5.5 Web Research is a package with no screen

**Decision.** Web Research ships as a package that other packages call through `requires`, even
though it has no screen and no tables. News already depends on it, and a package is the only
shape a third-party module could later replace. Its search provider stays an install setting,
so a missing provider shows the gate reason News already shows.

### 5.6 Reachable from other devices

Every screen is a package screen served by the Rust server, so a phone on the home network or
tailnet reaches it over HTTPS like any other module. Downloads, bank sync and search all happen
on the host. One step is the exception: linking a bank opens a Plaid-hosted page in the
person's own browser (`external-modules/finance/src/adapters/plaid.ts`), and part 21 proves
that page completes from a phone on the tailnet and returns to Moss.

### 5.7 The determinism boundary

Every label, health state, balance, budget figure, dose state, error, progress line and approval
card comes from stored records and code. The model has six jobs only: propose Commitment candidates, judge Commitment email, draft
Meals plan recipes, judge each Meals recipe against every eater's restrictions, and estimate Meals log entries and Finance categories, and sort Integrations tools. Each reply passes a schema check and a boundary
validator, and Commitment proposals, and Finance proposals outside the trusted sorting tier the person
already chose, reach a person's money or task list only after that person confirms. Model guidance in any one prompt stays under 150 words. A prompt that
needs more means the design is wrong, and the part stops and says so.

## 6. Keeping private data private

The floor for every part (written once here so section 7 can name only what is special):

1. **Row level security.** Two people, each policy seen failing when removed. No admin path
   reads another person's rows. The old SQL stays byte for byte. For the five `packages/`
   modules the old policies are in that SQL and carry over. Finance and Meals have no policy
   in their old SQL at all, because the old host generated it. Their Rust packages declare
   every owned table in the manifest, the host generates owner-only rules as it does today
   (registry design section 3.6), and the proof removes a generated rule, not an old one.
2. **No private text in logs.** A planted marker is searched in every response, log line, job
   payload, activity row and model prompt. The test is first seen failing with the protection
   off.
3. **Both builds.** The crate builds natively and as WebAssembly, and both builds run its tests.
4. **Live run.** The part's routes, tools or screens run on the real Rust server over HTTPS, and
   from a second device when the part has a screen. Results go in
   `docs/superpowers/specs/2026-11-xx-rust-phase5-<module>-report.md` with a "Not proven" list.
5. **Verification commands are never piped**, and each part's report states the expected exit
   code beside the command it ran.

Extra rules for Finance and Wellness, because bank and health data are the most private data
in Moss:

- **Finance.** Amounts, balances, account names, merchant names and bank tokens are marker
  values in every part's leak test, not only in the connect part. A test reads the stored job
  rows themselves, not only the responses. Export files are checked for another person's rows.
  The Plaid token is planted as a marker and searched in package logs, which the package must
  never be able to write it into, because it never receives it (5.3).
- **Wellness.** Check-in values, medication names, dose notes and therapy-note text are marker
  values in every part. Therapy notes get their own test: they reach no model prompt, no
  briefing, no export the person did not choose, and no log, even with AI consent on. Export
  expiry is tested by moving the clock, and an expired export reads as gone.
- **Meals.** Household member names and log text are marker values. Meals holds no bank or
  health data, so it keeps the floor above and no more.

## 7. Build parts

Sizes are by complexity (S, M, L), not time. Each part is one builder session. Order is
dependency order. Every part carries the proof floor in section 6. The table names only the
special proof for each part.

Parts marked **Screen** need the mockups agreed with Ben before building. The approved
TypeScript designs exist (3.4). **Recommendation.** For each screen part, show Ben the current
TypeScript screen beside a still of the planned Rust screen, get a yes, then build. No redesign.

| #   | Track        | Scope                                                                                                                                                                                                              | Size | Depends on             | Special proof                                                                                                                                                                                                                                                 |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scratchpad   | Package skeleton: manifest, ledger, 1 table, note read, replace, append and settings routes. No chat tools yet                                                                                                     | S    | none                   | Route parity against the old handlers; a second person cannot read the note                                                                                                                                                                                   |
| 2   | Scratchpad   | Chat read and append tools, approval cards, notes-folder setting, account export and delete for the note table                                                                                                     | S    | 1                      | Approval card from the stored record; append from chat lands in the same note                                                                                                                                                                                 |
| 3   | Scratchpad   | **Screen.** Scratchpad beside chat. App map entries                                                                                                                                                                | S    | 2, Ben's yes           | Live on desktop and phone; empty and broken states                                                                                                                                                                                                            |
| 4   | Goals        | Package skeleton: manifest, ledger, 3 SQL files, goal list, create, change, close and evidence routes                                                                                                              | S    | none                   | Route parity; evidence on a closed goal is refused as today                                                                                                                                                                                                   |
| 5   | Goals        | Chat goal tools and the Today section data call                                                                                                                                                                    | S    | 4                      | Tool replies match the routes on fixtures                                                                                                                                                                                                                     |
| 6   | Goals        | **Screen.** Goals section on Today. App map entries                                                                                                                                                                | S    | 5, Ben's yes           | Live on desktop and phone                                                                                                                                                                                                                                     |
| 7   | Commitments  | Package skeleton: manifest, ledger, 2 SQL files, candidate list, status, resolve and suppress routes                                                                                                               | M    | none                   | Route parity; a resolved candidate stays resolved                                                                                                                                                                                                             |
| 8   | Commitments  | Extraction and email-judgement jobs, prefilter, chat review tools, heartbeat source                                                                                                                                | M    | 7                      | Canned model run in CI; a proposal reaches no task list before the person confirms; payloads carry ids only                                                                                                                                                   |
| 9   | Commitments  | **Screen.** Commitment review in chat and Today. App map entries                                                                                                                                                   | S    | 8, Ben's yes           | Live on desktop and phone                                                                                                                                                                                                                                     |
| 10  | Web Research | Package with no screen: search through the configured provider, the gate and its reasons. No page reading yet                                                                                                      | M    | none                   | Gate reason matches News today; News described topics work against a fake search reply                                                                                                                                                                        |
| 11  | Web Research | Page reading: robots rules, rate limits, unsafe-address refusal, public-web fetch                                                                                                                                  | M    | 10                     | Private and loopback addresses refused, each guard seen failing when removed                                                                                                                                                                                  |
| 12  | Wellness     | Test stand-in: fixture check-ins, doses and notes. Test crate only, shipped nowhere                                                                                                                                | S    | none                   | A reviewer reads each fixture for personal data                                                                                                                                                                                                               |
| 13  | Wellness     | Package skeleton: manifest, ledger, 16 SQL files, check-ins and AI consent                                                                                                                                         | M    | 12                     | Check-in values are markers in logs; no model port is declared in the manifest at all                                                                                                                                                                         |
| 14  | Wellness     | Medications: medicines, schedules, dose logs, adherence counts, the reminder queue declaration with no worker, as today                                                                                            | M    | 13                     | Thirty-day adherence counts match the old code on fixtures; Briefings reads counts and never a medication list                                                                                                                                                |
| 15  | Wellness     | Therapy notes, selective export and account lifecycle: notes, export job, expiry, download, and the Wellness sections of account export and delete                                                                 | M    | 13                     | Therapy-note marker reaches no prompt, briefing, log or unchosen export; expired export reads as gone                                                                                                                                                         |
| 16  | Wellness     | Insights and chat tools: insights worked out in code, check-in and medication tools. Each tool's consent-off answer is tested                                                                                      | M    | 14, 15                 | With consent off every tool returns no private value; insights match the old code's figures on fixtures                                                                                                                                                       |
| 17  | Wellness     | **Screen.** Wellness today, history and trends. App map entries                                                                                                                                                    | M    | 16, Ben's yes          | Live on desktop and phone; empty, loading and broken states                                                                                                                                                                                                   |
| 18  | Wellness     | **Screen.** Therapy notes, insights, settings and export screens. App map entries                                                                                                                                  | M    | 16, Ben's yes          | Same live check; export download from a phone                                                                                                                                                                                                                 |
| 19  | Finance      | Platform probe: Plaid token exchange through the host broker on a Plaid stand-in, client secret and token custody, the exception question in 5.3 answered with evidence                                            | M    | none                   | Marker token searched in package logs, responses and payloads; if the host cannot express the exchange, the part stops and asks Ben before any data part starts                                                                                               |
| 20  | Finance      | Package skeleton: manifest, module-legacy ledger, 42 SQL files and 24 tables, account list, manual account create, manual entries. No bank link                                                                    | L    | 19                     | Route and tool parity for manual accounts; amounts and account names are markers in every surface                                                                                                                                                             |
| 21  | Finance      | Bank connect and sync: connect and poll queues, the six-hour sweep, balances, transactions, reconnect state                                                                                                        | L    | 19, 20                 | Sync against the Plaid stand-in including a failed and a reconnected bank; stored job rows hold ids only. **Needs Ben** for the real bank pass in part 36                                                                                                     |
| 22  | Finance      | Transactions: query, splits, categories, merchant rules, bulk review, confirm, notes and CSV import with preview and duplicate choices                                                                             | L    | 20                     | CSV fixture files at the size caps; a duplicate saved twice by replay stays one row; category sorting keeps its tiers exactly as today, including the trusted tier that applies without asking                                                                |
| 23  | Finance      | Budgets: configure, status, drafts (build, get, update, start), assign and move, budget-apply queue                                                                                                                | M    | 22                     | Draft figures come from stored records; an uncertain save saves nothing and says so                                                                                                                                                                           |
| 24  | Finance      | Bills, targets and flex: bill plans and occurrences, adjustments, suggestions, targets and funding, flex preview and assign, card reserves                                                                         | M    | 22                     | Bill and target figures match the old code on fixtures                                                                                                                                                                                                        |
| 25  | Finance      | Reports, activity, sharing and undo: spending and net-worth reports, history export, account sharing, activity list and undo queues                                                                                | M    | 22                     | Export holds only the owner's rows; a shared account shows the other person only what sharing allows today                                                                                                                                                    |
| 26  | Finance      | **Screen.** Budget, transactions and accounts screens. App map entries                                                                                                                                             | L    | 23, Ben's yes          | Live on desktop and phone; a bank that cannot sync shows its status and Reconnect                                                                                                                                                                             |
| 27  | Finance      | **Screen.** Start, reports, settings and upcoming screens, plus account export and delete sections. App map entries                                                                                                | M    | 25, Ben's yes          | Same live check; start works with no bank keys                                                                                                                                                                                                                |
| 28  | Meals        | Package skeleton: manifest, module-legacy ledger, 27 SQL files and 20 tables, kitchen, household, kitchen and household tools                                                                                      | M    | 19 (format proof only) | Tool parity for kitchen and household; household names are markers in logs                                                                                                                                                                                    |
| 29  | Meals        | Planning: plan create, get, current and control, day fill job, meal edit, swap, servings and favourites                                                                                                            | L    | 28                     | Canned model recipes in CI, each checked against its schema; the model can only add a restriction failure, never clear one; a missing verdict for an eater counts as a fail; a failed recipe is not served; a failed day leaves the rest of the week standing |
| 30  | Meals        | Lists and pantry: shopping list build and edit, bought, clear, pantry and staples                                                                                                                                  | M    | 29                     | List matches the plan on fixtures; clearing a list touches nothing else                                                                                                                                                                                       |
| 31  | Meals        | Log and estimates: log list, add, estimate job, re-estimate, correct and delete                                                                                                                                    | M    | 29                     | Canned model estimates checked against their schema; an estimate is shown as an estimate, never as a measured value                                                                                                                                           |
| 32  | Meals        | Cooking and undo: cooked, ratings and the undo tool covering every Meals write                                                                                                                                     | S    | 30, 31                 | Undo restores the record before the write, for each write kind                                                                                                                                                                                                |
| 33  | Meals        | Remainder tools and data lifecycle: every assistant tool not yet covered, account export and delete sections                                                                                                       | S    | 32                     | Tool-by-tool parity list signed off against `jarvis.module.json`                                                                                                                                                                                              |
| 34  | Meals        | **Screen.** Plan, list, pantry, staples and recipe screens. App map entries                                                                                                                                        | L    | 33, Ben's yes          | Live on desktop and phone; empty week and empty pantry states                                                                                                                                                                                                 |
| 35  | Meals        | **Screen.** Household, settings, log and plan helper screens (swap, new, move, eaters, text). App map entries                                                                                                      | M    | 33, Ben's yes          | Same live check                                                                                                                                                                                                                                               |
| 36  | All          | Remainder: registry packaging and signing for all seven, upgrade check on a copy of dev data, whole-module live pass from a second device, one real Plaid link and sync, News topics re-proof through Web Research | M    | 1-35                   | **Needs Ben** for the real bank pass. Upgrade keeps every note, goal, check-in, account, transaction and meal plan                                                                                                                                            |

| 37 | Host | Integrations: connected-tool sorting for chat, its 10 routes, 9 SQL files and 2 sorting queues, kept in the host with chat (not a package) | M | none | Sorting matches the old tiers on fixtures; a tool holding a credential is never sent to the model; account delete removes its connections as the old manifest declares |
| 38 | Host | Proactive Monitoring and Usefulness Feedback: cards on Today, the 2 proactive routes, the 5 feedback routes and their SQL, kept in the host with Today (not packages) | M | none | Cards follow quiet hours on fixtures; a feedback signal changes nothing else; account export and delete cover both, as their manifests declare or, where they declare nothing, by the host's account-delete rule |

Ordering. Parts 1 to 11 and the two host parts (37 and 38) can run in any order, because they share
nothing. Wellness (12 to 18) follows. Part 19 runs before every Finance and Meals part, because it answers whether the
package format can hold bank tokens at all. Finance (20 to 27) follows it, then Meals (28 to
35), as the registry design's slice M12 requires. Screens follow their data parts and Ben's
yes. Part 36 is last.

### 7.2 New crates and installs (Ben approves)

Recommended choices. All are pure Rust and must build for `wasm32-wasip2` unless the row says
host only. The builder pins exact versions when the part starts and records them in the part's
report. If a recommended crate fails the WebAssembly build or the speed budget, the builder
stops at a clean point and names the alternative rather than switching silently.

| Need                                   | Legacy library                                                        | Recommended                                                                                  | Part   | Why this one                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| CSV reading for bank imports           | the old CSV code in `external-modules/finance/src/domain/csv-text.ts` | `csv`                                                                                        | 22     | The standard Rust CSV reader. Caps stay in Finance code, not the crate                               |
| Plaid replies (balances, transactions) | `external-modules/finance/src/adapters/plaid.ts`                      | No new crate. Plain JSON through the host broker with `serde_json`, already in the lock file | 19, 21 | Plaid is one JSON API. A client crate would hold the token shape the host must own                   |
| Search and page reading                | `packages/web-research/src/reader.ts` and `robots.ts`                 | No new crate beyond what the News reader already added (`scraper`, `quick-xml`)              | 11     | Reuse beats a second HTML parser. Robots rules stay in package code, as today                        |
| Nutrition and category estimates       | the person's model                                                    | No new crate                                                                                 | 22, 31 | Estimates go through the model router. No local nutrition table exists today and this plan adds none |

Nothing else is needed. In particular no health-device crate, no second bank-feed crate and no
Chromium download are asked for in this plan.

## 8. Kill gates and risks

**Kill gate after part 19.** Plaid's token exchange runs through the host on the stand-in, and
the marker token appears nowhere a package can reach. Owner Ben. A miss stops Finance and Meals
until the host gains what is missing, or Ben rules on the exception in 5.3. The small modules
and Wellness are not held by this gate.

**Kill gate after part 36's upgrade check.** A copy of an existing install upgrades and keeps
every Finance balance, Wellness check-in and Meals plan. Owner Ben. A miss means that module
does not ship, and its old module keeps running under the support window.

Risks.

- **Bank data is the worst leak in Moss.** A single Finance log line with an amount in it is a
  failure of the whole module, not of one part. That is why the marker tests run in every
  Finance part and read the stored job rows (section 6).
- **Plaid is a live service.** Fixtures pass while the real link flow changes. Part 36's real
  pass is the only check, and the sync can still break later without any Moss change. The
  reconnect state exists for that day.
- **Health data stays out of the model.** No Wellness text reaches a model in the old app.
  The risk in Rust is adding such a call by habit. No Wellness part declares a model port,
  and part 13's manifest check fails if one appears.
- **Size.** Finance is the largest single module in this plan (about 29,000 lines) and is
  already split into eight parts. A builder who cannot finish a part in one session says so at
  a clean point rather than compacting twice.
- **Web Research has no owner screen.** Its failure shows up inside News and chat, so part 10
  proves it through the News topic gate and not only through its own tool.
- **Household data in Meals.** A kitchen can hold more than one person. Owner rules follow the
  old SQL, and part 28 tests two people in one install before any plan part builds on it.

## 9. Not covered

- Workshop and Food (not ported, Ben's ruling). Food is a later module and builds nothing in this plan. If it later needs Wellness check-ins,
  that link is its own spec, not a port item here.
- Job Search data beyond keeping it archived.
- Any health source, watch or device link for Wellness. That is a new product choice for Ben.
- Wellness dose reminders. The old queue is declared with no worker. Building one is new
  behaviour on health data and needs Ben's own spec, so part 14 ports the declaration only.
- Any bank feed other than Plaid, and any automatic payment or money movement. Finance records
  and reports. It sends no money, as today.
- The Today shell, Chat and the host helpers listed in 1.1. Parts 6, 9 and 17 supply only the
  sections and screens those surfaces host.
- Any non-Rust work.
