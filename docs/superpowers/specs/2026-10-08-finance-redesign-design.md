# Finance redesign: budget first, with Moss on top

- Issue: #3162 (part of epic #3160)
- Status: draft, awaiting Ben's approval of the R1 mockups
- Builds on: `2026-07-18-finance-module-design.md` and the fin-03 to fin-06 deltas. Where they
  conflict, epic #3160 wins (holdings move from "never" to "later").
- Mockups: `docs/superpowers/specs/finance-redesign/` (desktop 1440 and phone 390 for every R1
  screen; open `index.html`)
- Tree read at: `46ab17577`

## In plain English

Finance becomes a budget you run together with Moss. The bank plumbing stays. The screens and the
way Moss helps are new.

- **R0** fixes bank syncing. Nothing else ships until it lands.
- **R1** is the new personal budget. Moss sorts every purchase into a category, builds your first
  budget from three months of history in one chat, and moves money when you ask it to in chat. A
  new "Moss's freedom" screen decides how much Moss does without asking: three steps, a dollar
  limit, and switches for each kind of action.
- **R2** adds the shared household budget, phone alerts, the weekly check-in and a money line on
  Today.
- **R3** adds receipt itemizing from email and saving ahead for trips on your calendar.

Three questions the issue asked us to settle by reading the code:

1. **Can finance read email and calendar today?** No. A module can only reach its own data. R3
   needs two new, narrow read doors that the email and calendar modules own and that the user
   agrees to at install. That follows a pattern the platform already uses for attachments and
   phone notifications. R1 needs neither.
2. **How does the freedom setting fit Moss's existing permission levels?** Each of the three steps
   is a preset that flips the existing per-action "ask or just do it" switches in one go.
   "Customize" shows those same switches. The dollar limit is a new rule that makes any money move
   above it ask, whatever the step. Background sorting, which today ignores those switches, learns
   to read them.
3. **What goes in Moss's app map?** Six screens, three settings and five features, listed below.
   Today the app map cannot hold entries from add-on modules at all, so R1 adds that ability first.

Things Ben should look at, beyond the mockups:

- Reports stops being its own tab. Spending lives on Budget and net worth lives on Accounts.
- Chat actions ("move $50 to groceries") and answers ("can I afford this?") land in R1. The epic
  ordered them second but did not assign a release, and R1 needs them for the first-budget chat.
- New users start on the middle step ("handle routine, ask about new") with a $100 limit.
- Moss's sorting guesses count toward the budget straight away, marked as guesses until you
  confirm them.

## Releases

| Release | Contents                                                                                                 | Detail here                             |
| ------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| R0      | Sync fix, shipped alone; finance stays disabled on prod until it lands                                   | Sketch                                  |
| R1      | Park Press screens, personal budget, Moss categorizing, first-budget chat, freedom setting, chat actions | Full                                    |
| R2      | Shared household budget, alerts, weekly check-in, Today money line                                       | Sketch                                  |
| R3      | Receipt itemization, calendar set-asides                                                                 | Sketch, plus the email/calendar verdict |
| Later   | Investment holdings and loan detail (one Plaid update-mode pass per bank)                                | One line                                |

## R0: sync fix (sketch)

R0 ships alone under its own task issue and plan. It changes no screens. The defects come from the
epic's 2026-10-08 read-only diagnosis.

| Defect                                                                                                           | Fix                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every sync calls the live balance endpoint first and aborts when it fails (`INVALID_PRODUCT` on both prod items) | Request transactions first. Treat balance as optional; on failure fall back to the balances `/transactions/sync` already returns and record the balance error separately |
| Removed pending transactions survive a batch that carries only removals                                          | Apply `removed` independently of `added`/`modified`                                                                                                                      |
| No restart on `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`                                                     | Discard the page set and restart from the saved cursor, bounded retries                                                                                                  |
| No webhook, no first sync on connect; 6-hour schedule only                                                       | Enqueue `finance.sync-run` from the connect-poll success path. Webhooks stay out (no public callback; scope guardrail)                                                   |
| Only the short error code is stored; nothing logged                                                              | Store code, type, display message and request id on the item; log through `ctx` logger with no tokens or account numbers                                                 |

R0 done means a live sync on dev against Plaid sandbox, plus Ben enabling finance on prod and
seeing transactions arrive.

## R1: the personal budget (full detail)

### Scope

In:

- New screens: Budget, Transactions, Accounts, Getting started (no bank, and the first-budget
  draft), Moss's freedom, Activity.
- Category groups, moved from KV into a table.
- Moss sorting every transaction, with a "Needs a look" review queue.
- First-budget draft built from three months of history, adjusted in one chat.
- Chat actions: move money, set an amount, sort a transaction, make a merchant rule, add or
  rename a category.
- The freedom setting (three steps, dollar limit, custom switches) and the Activity trail that
  step 3's weekly review reads.
- Platform additions P1 to P4 (below).

Out:

- Household anything. Existing `shared_to_household` flags stay in the data; the share switch and
  household view are hidden until R2.
- Alerts, weekly check-in, Today money line (R2).
- Receipts, calendar (R3).
- Webhooks, holdings, loans.

### Screens

All screens are Park Press and use `@moss/ui` only. Module CSS is layout only. The module keeps a
single host navigation entry, "Finance". Inside it, a `Segmented` control switches between Budget,
Transactions, Accounts and Activity. Moss's freedom opens from the Budget rail and from Activity.

| Screen                   | Path                      | Built from                                                                                                                                                                                                                                                                                                            | Empty                                                                           | Loading                               | Broken                                                                                 |
| ------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------- |
| Budget                   | `/m/finance`              | `Masthead tone="field"` (ready to assign, month switcher), `SectionHead` per group, a `jds-table` per group on desktop (assigned, spent with `jds-progress` meter, available) and `RowIndex` rows on phone, `Badge` for overspent, rail blocks (`Eyebrow` plus `SectionHead`) with `StatTile`s and a facts `RowIndex` | No bank: redirect to Getting started. Bank but no budget: Getting started draft | Masthead skeleton, three ghost groups | Sync error `Note variant="plan"` with Reconnect; budget still renders from stored data |
| Transactions             | `/m/finance/transactions` | `Segmented` filter (All, Needs a look), day `SectionHead`s, `RowIndex` rows, `Badge` "Moss guessed", `Select` for category, `Switch` "Always for this merchant"                                                                                                                                                       | "Nothing yet. Transactions appear after the first sync."                        | Ghost rows                            | Same banner as Budget                                                                  |
| Accounts                 | `/m/finance/accounts`     | `Masthead` net worth, `RowIndex` per bank with `Indicator` sync status, `Button` Reconnect / Add a bank                                                                                                                                                                                                               | Getting started                                                                 | Ghost rows                            | Per-bank `Indicator status="error"` with the stored display message and Reconnect      |
| Getting started: no bank | `/m/finance/start`        | `Masthead`, numbered `RowIndex` steps (connect, sort, build budget), primary `Button` "Connect a bank"                                                                                                                                                                                                                | n/a                                                                             | n/a                                   | Plaid credentials missing: admin `Note` naming the settings page                       |
| Getting started: draft   | `/m/finance/start`        | `Masthead` ("Your first budget"), draft group rows with history average and proposed amount, `Button` "Build my budget with Moss" (opens chat), `Button` "Start this budget"                                                                                                                                          | Under 30 days of history: draft from what exists, with a `Note` saying so       | Draft computing: progress row         | Draft failed: retry `Button`                                                           |
| Moss's freedom           | `/m/finance/freedom`      | `RadioCardGroup` (three steps), `Field` dollar limit, `SectionHead` "Customize" with a `Switch` per action family, fixed "Always asks" rows                                                                                                                                                                           | n/a                                                                             | Ghost cards                           | Save failed: inline error, switches revert                                             |
| Activity                 | `/m/finance/activity`     | Week `SectionHead`s, `RowIndex` rows (who, what, when), `Button variant="quiet"` Undo                                                                                                                                                                                                                                 | "Moss hasn't done anything on its own yet."                                     | Ghost rows                            | Retry                                                                                  |

Phone: every screen is single column. The rail moves below the main column. Chat stays a drawer
that slides over the page, including on the draft screen. Rows wrap amounts below the title rather
than shrinking text.

Reports folds in. Spending by category is the Budget "spent" column plus each row's trend. Net
worth heads Accounts. The two report tools stay for chat.

### Data model

New module migrations under `external-modules/finance/sql/`. Every table keeps
`owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE` and gets the
platform-generated owner-only FORCE RLS (fin-06 delta:61, :107). All are added to
`database.ownedTables`.

```sql
-- 0009_create_finance_categories.sql
CREATE TABLE app.finance_categories (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  id text NOT NULL,
  group_name text NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL,
  is_income boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  PRIMARY KEY (owner_user_id, id)
);

-- 0010_add_finance_transactions_review.sql
ALTER TABLE app.finance_transactions
  ADD COLUMN review_state text NOT NULL DEFAULT 'confirmed'
    CHECK (review_state IN ('confirmed', 'needs_look')),
  ADD COLUMN ai_confidence real
    CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1));

-- 0011_index_finance_transactions_review.sql
CREATE INDEX finance_transactions_needs_look
  ON app.finance_transactions (owner_user_id, date DESC)
  WHERE review_state = 'needs_look';

-- 0012_create_finance_budget_drafts.sql
CREATE TABLE app.finance_budget_drafts (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'started', 'discarded')),
  basis_from date NOT NULL,
  basis_to date NOT NULL,
  monthly_income_cents bigint NOT NULL,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  PRIMARY KEY (owner_user_id, id)
);

-- 0013_create_finance_budget_draft_lines.sql
CREATE TABLE app.finance_budget_draft_lines (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL,
  category_key text NOT NULL,
  group_name text NOT NULL,
  category_name text NOT NULL,
  basis_monthly_cents bigint NOT NULL,
  proposed_cents bigint NOT NULL,
  adjusted_cents bigint,
  adjusted_by text CHECK (adjusted_by IN ('user', 'moss')),
  dropped boolean NOT NULL DEFAULT false,
  PRIMARY KEY (owner_user_id, draft_id, category_key),
  FOREIGN KEY (owner_user_id, draft_id)
    REFERENCES app.finance_budget_drafts (owner_user_id, id) ON DELETE CASCADE
);

-- 0014_create_finance_activity.sql
CREATE TABLE app.finance_activity (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  at timestamptz NOT NULL,
  actor text NOT NULL CHECK (actor IN ('user', 'moss')),
  kind text NOT NULL,
  params jsonb NOT NULL,
  undo jsonb,
  undone_at timestamptz,
  PRIMARY KEY (owner_user_id, id)
);

-- 0015_index_finance_activity_at.sql
CREATE INDEX finance_activity_owner_at ON app.finance_activity (owner_user_id, at DESC);
```

Notes:

- Existing rows keep `review_state = 'confirmed'`, so the upgrade creates no review backlog.
- `finance_activity.params` holds ids, cents and category ids only. The row text renders from
  `kind` + `params` through a code template; there is no stored free text.
- The `storage-migrate` reconcile job copies the KV taxonomy (`taxonomy.ts:31-48`) into
  `finance_categories`, assigning the 16 defaults to groups (Bills, Everyday, Fun, Savings,
  Income). Payee rules, cursors, link sessions and settings stay in KV.
- Manifest version bump is required. Per the `manifest-hash-kills-module-queues` memory, the
  build plan must cover the queue re-registration that follows a manifest change.

### Categorization and review

Order is unchanged (`categorize.ts:32-80`, `sync.ts:69-99`): payee rule, then the Plaid category
map, then AI. Two things change.

1. The AI step returns `{ id, categoryId, confidence }` against the closed list of the user's
   non-archived category ids. Its input stays `{ id, payee, amountCents, date }`
   (`domain/categorize.ts:18-22`); no notes, account names or numbers.
2. Each result gets a `review_state`, decided by the freedom tiers (P4):

| Source                     | Merchant seen and confirmed before | `sorting` tier  | `sorting_new` tier | Result                                 |
| -------------------------- | ---------------------------------- | --------------- | ------------------ | -------------------------------------- |
| Payee rule                 | n/a                                | any             | any                | `confirmed`                            |
| Plaid map or AI            | yes                                | `trusted_auto`  | any                | `confirmed`, activity row (actor moss) |
| Plaid map or AI            | yes                                | `ask_each_time` | any                | `needs_look`                           |
| Plaid map or AI            | no                                 | any             | `trusted_auto`     | `confirmed`, activity row (actor moss) |
| Plaid map or AI            | no                                 | any             | `ask_each_time`    | `needs_look`                           |
| AI with `confidence < 0.6` | any                                | any             | any                | `needs_look`                           |

A `needs_look` transaction still counts toward its guessed category, so the budget is never empty
while you review. Transactions shows a "Needs a look" count and filter. Confirming or changing a
category writes `confirmed` and, when "Always for this merchant" is on, a payee rule.

### First budget

The draft is deterministic. Moss never invents the numbers on the screen.

1. "Connect a bank" finishes and the first sync completes (R0 adds sync on connect).
2. Getting started enqueues `finance.draft-build`. The handler reads the last three complete
   months (fewer if that is all there is) and writes a `finance_budget_drafts` row plus lines:
   - `basis_monthly_cents` is the mean monthly spend per category;
   - `proposed_cents` rounds that up to the next $5;
   - `monthly_income_cents` is the median monthly income;
   - a merchant with a charge in each basis month within 10% of the same amount lands in Bills.
3. The screen renders the draft from the record. "Build my budget with Moss" calls
   `hostActions.openAssistant({ starterPrompt })` (`apps/web/src/external-modules/host-actions.ts:14-79`).
   The prompt is an editable draft; the user sends it. On phone the chat opens as the drawer.
4. In chat, Moss calls `finance.budget.draft.get` and `finance.budget.draft.update`. Every update
   returns the line's before and after, and the screen re-reads the record.
5. "Start this budget" is a button on the screen only, through the `finance.draft-start` queue. It
   creates categories, writes this month's assignments and marks the draft `started`. No chat
   tool can start a budget.

### Chat actions and answers

Answers use the existing read tools plus `budget.status` gaining per-category `available` and
`readyToAssignCents`. Actions are the write tools below. The dollar limit applies to every tool
that moves money.

### Tools and families (manifest delta)

New and changed entries only. `finance.transaction.categorize` loses `createRule` (rules become
their own tool so they can have their own switch) and gains `amountCents`, which the handler
checks against the stored transaction and rejects on mismatch.

```json
{
  "assistantActionFamilies": [
    {
      "id": "sorting",
      "label": "Sort purchases from merchants you've seen",
      "description": "Put transactions into categories.",
      "freedom": "routine",
      "defaultTier": "trusted_auto",
      "allowedTiers": ["ask_each_time", "trusted_auto"]
    },
    {
      "id": "sorting_new",
      "label": "Sort purchases from new merchants",
      "description": "Decide the category the first time a merchant appears.",
      "freedom": "new",
      "defaultTier": "ask_each_time",
      "allowedTiers": ["ask_each_time", "trusted_auto"]
    },
    {
      "id": "rules",
      "label": "Make merchant rules",
      "description": "Always put a merchant in the same category.",
      "freedom": "new",
      "defaultTier": "ask_each_time",
      "allowedTiers": ["ask_each_time", "trusted_auto"]
    },
    {
      "id": "moving_money",
      "label": "Move money between categories",
      "description": "Assign or move budget amounts, up to your limit.",
      "freedom": "routine",
      "defaultTier": "trusted_auto",
      "allowedTiers": ["ask_each_time", "trusted_auto"]
    },
    {
      "id": "categories",
      "label": "Add, rename or archive categories",
      "description": "Change the shape of your budget.",
      "freedom": "new",
      "defaultTier": "ask_each_time",
      "allowedTiers": ["ask_each_time", "trusted_auto"]
    },
    {
      "id": "drafting",
      "label": "Adjust a draft budget",
      "description": "Change a budget that hasn't started yet.",
      "defaultTier": "trusted_auto",
      "allowedTiers": ["trusted_auto"]
    },
    {
      "id": "upkeep",
      "label": "Refresh bank data",
      "description": "Pull new transactions now.",
      "defaultTier": "trusted_auto",
      "allowedTiers": ["trusted_auto"]
    },
    {
      "id": "bank_connections",
      "label": "Connect a bank",
      "description": "Start a bank connection.",
      "defaultTier": "always_confirm",
      "allowedTiers": ["always_confirm"]
    },
    {
      "id": "sharing",
      "label": "Share an account",
      "description": "Share an account with your household.",
      "defaultTier": "always_confirm",
      "allowedTiers": ["always_confirm"]
    }
  ]
}
```

| Tool                                            | Risk  | Family             | Policy | Notes                                                                                                                  |
| ----------------------------------------------- | ----- | ------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `finance.transaction.categorize`                | write | `sorting`          | auto   | input gains `amountCents`; drops `createRule`                                                                          |
| `finance.rule.set` (new)                        | write | `rules`            | auto   | `{ merchant, categoryId }`                                                                                             |
| `finance.budget.assign`                         | write | `moving_money`     | auto   | `confirmAbove { inputKey: "amountCents", preferenceKey: "freedomLimitDollars", scale: 100 }`                           |
| `finance.budget.move` (new)                     | write | `moving_money`     | auto   | `{ month, fromCategoryId, toCategoryId, amountCents }`; `fromCategoryId` may be `ready_to_assign`; same `confirmAbove` |
| `finance.category.upsert` (new)                 | write | `categories`       | auto   | `{ id?, name, groupName }`                                                                                             |
| `finance.category.archive` (new)                | write | `categories`       | auto   | `{ id }`; refuses when assignments exist this month                                                                    |
| `finance.budget.draft.get` (new)                | read  | n/a                | n/a    |                                                                                                                        |
| `finance.budget.draft.update` (new)             | write | `drafting`         | auto   | `{ draftId, categoryKey, amountCents?, categoryName?, groupName?, dropped? }`                                          |
| `finance.activity.list` (new)                   | read  | n/a                | n/a    | `{ from, to }`                                                                                                         |
| `finance.sync.run-now`                          | write | `upkeep`           | auto   |                                                                                                                        |
| `finance.connect.start`, `finance.connect.poll` | write | `bank_connections` | ask    |                                                                                                                        |
| `finance.account.set-shared`                    | write | `sharing`          | ask    | hidden in R1 screens                                                                                                   |

New queues: `finance.draft-build`, `finance.draft-start`, `finance.review-apply` (confirm or
change a `needs_look` row from the screen), `finance.activity-undo`.

New preference (`external-module.ts:256-314`, integer, within the 8-entry cap):

```json
{
  "preferences": [
    {
      "key": "freedomLimitDollars",
      "label": "Moss can move up to",
      "description": "Moves above this amount ask first, at every freedom step.",
      "type": "integer",
      "default": 100,
      "min": 0,
      "max": 100000
    }
  ]
}
```

Each write handler appends a `finance_activity` row with the actor (`moss` when the call came
through the assistant gateway or a background job, `user` when it came from a screen queue) and
an `undo` payload where undo is possible.

### The freedom setting

The three steps are presets over the families tagged `freedom`. "Customize" edits the same tiers
one family at a time. The screen stores nothing of its own. It reads the tiers and shows which
preset they match, or "Custom" when they match none.

| Family                        | Tag     | Step 1: ask about everything | Step 2: handle routine, ask about new | Step 3: run it all, review weekly |
| ----------------------------- | ------- | ---------------------------- | ------------------------------------- | --------------------------------- |
| `sorting`                     | routine | ask                          | auto                                  | auto                              |
| `moving_money`                | routine | ask                          | auto, up to the limit                 | auto, up to the limit             |
| `sorting_new`                 | new     | ask                          | ask                                   | auto                              |
| `rules`                       | new     | ask                          | ask                                   | auto                              |
| `categories`                  | new     | ask                          | ask                                   | auto                              |
| `bank_connections`, `sharing` | none    | always asks                  | always asks                           | always asks                       |
| `drafting`, `upkeep`          | none    | always runs                  | always runs                           | always runs                       |

"ask" is `ask_each_time`; "auto" is `trusted_auto`. Step 2 is the default for new installs.

How each path honours the setting:

| Path                           | Today                                                                                           | R1                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Chat tool call                 | `resolvePolicy` (`packages/ai/src/gateway/policy.ts:37-73`) reads the family tier               | Unchanged, plus `confirmAbove` (P3) feeds the existing `requiresConfirmation` step |
| Classifier gate                | Routes through the same policy (`gateway.ts:307-345`)                                           | Unchanged; finance declares no classifier in R1                                    |
| Background sorting during sync | Bypasses the gateway (`apps/worker/src/external-module-job-handler.ts:197-214`); always applies | Reads its own `sorting` and `sorting_new` tiers (P4) to set `review_state`         |
| YOLO mode                      | Runs any non-destructive installed-module tool (`policy.ts:83-97`)                              | Unchanged. `always_confirm` families still ask; `confirmAbove` still asks          |

Step 3's "review weekly" is the Activity screen in R1. The weekly check-in chat that walks through
it arrives in R2.

The chat approval card stays Approve and Reject (`apps/web/src/chat/action-request-card.tsx:236-244`).
Its title for a move above the limit renders from the tool input, for example "Move $250 from
Dining out to Travel (over your $100 limit)".

### Platform additions

Each is a host change with its own tests, built before the finance work that uses it.

**P1. External modules contribute to the app map.**

- Today: external modules are absent. `scripts/build-app-map.ts:109` reads built-in manifests only;
  `validate.ts:62-64` forbids external `settings`; `features` are dropped by the allow-list
  (`validate.ts:854-890`); external `navigation` has no description (`external-module.ts:237-254`).
- Change: an optional external manifest block `appMap: { screens, settings, features }` using the
  built-in entry shapes (`module-sdk/src/index.ts:531-564`), validated at install, stored with the
  installed manifest, and merged by the app-map read service (`packages/settings/src/app-map.ts`)
  at query time for modules active for the actor (`resolveActiveModules`). Paths are rewritten
  under `/m/<moduleId>`.
- Test: install a fixture external module with one entry; the map query returns it for a user
  with the module enabled and not for one without. Fails today because the build script never
  sees external manifests.

**P2. Freedom tags and a preset write.**

- Family declarations gain optional `freedom: "routine" | "new"`.
- New route `POST /api/ai/action-policy/:moduleId/freedom` with body `{ step: 1 | 2 | 3 }` writes
  every tagged family's tier in one transaction, using the table above. It reuses the per-family
  checks in `packages/ai/src/action-policy-routes.ts:28-112` and is blocked from chat like the
  existing PATCH (`route-chat-rules.ts:74-77`).
- `GET /api/ai/action-policy` responses gain each family's `freedom` tag so the screen can group
  them.
- Moss-wide later means the same route without `:moduleId`; nothing in R1 depends on that.
- Test: a step 2 write leaves `sorting_new` at `ask_each_time` and `sorting` at `trusted_auto`; a
  family without a tag is untouched; chat cannot call the route.

**P3. `confirmAbove`, a numeric confirmation rule.**

- Today `confirmWhen` is equality only (`tool-manifests.ts:82-91,149-172`).
- Change: tool field `confirmAbove: { inputKey, preferenceKey, scale }`. When
  `abs(input[inputKey]) > preferences[preferenceKey] * scale`, `requiresConfirmation` is true, so
  `resolvePolicy` asks at step 6 regardless of tier. A missing preference asks.
- Test: limit 100, move of 10001 cents asks under `trusted_auto`; 10000 runs. Fails today because
  nothing reads preferences in the gateway.

**P4. A worker can read its own family tiers.**

- Today the worker context (`packages/module-sdk/src/worker.ts:55-169`) has no tier access.
- Change: `ctx.actionPolicy.get(familyId)` returns the actor's tier for a family the calling
  module declared. Implemented host-side over the existing repository
  (`packages/ai/src/repository.ts:2406-2455`), wired at the composition root like `ctx.notify`
  (`apps/api/src/external-module-tools.ts:91-108`).
- Open: confirm the validator accepts a family that no tool references (`sorting_new`). If not,
  P4 relaxes that check.
- Test: a worker asking for another module's family gets an error, not a tier.

### App map entries

Declared in the finance manifest `appMap` block (P1). Paths are module-relative.

Screens:

| id                     | label           | path            | description                                                                                            |
| ---------------------- | --------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| `finance.budget`       | Budget          | `/`             | This month's budget: money ready to assign, and each category's assigned, spent and available amounts. |
| `finance.transactions` | Transactions    | `/transactions` | Every bank transaction by day, with Moss's category guesses and a Needs a look filter.                 |
| `finance.accounts`     | Accounts        | `/accounts`     | Connected banks, balances, sync status, reconnect, and net worth.                                      |
| `finance.start`        | Getting started | `/start`        | Connect a first bank and build a first budget from three months of history.                            |
| `finance.freedom`      | Moss's freedom  | `/freedom`      | How much Moss does in finance without asking: three steps, a dollar limit, and per-action switches.    |
| `finance.activity`     | Activity        | `/activity`     | What you and Moss changed, by week, with undo.                                                         |

Settings:

| id                       | label               | path       | scope | description                                                                              |
| ------------------------ | ------------------- | ---------- | ----- | ---------------------------------------------------------------------------------------- |
| `finance.freedom-step`   | Freedom step        | `/freedom` | user  | Ask about everything, handle routine and ask about new, or run it all and review weekly. |
| `finance.freedom-limit`  | Moss's dollar limit | `/freedom` | user  | Moves of money above this amount always ask first. Also on the module preferences page.  |
| `finance.freedom-custom` | Per-action switches | `/freedom` | user  | Turn each kind of finance action on or off for Moss.                                     |

The Plaid credentials stay where they are (admin, module settings page) and are already covered by
the host's module-settings entry.

Features:

| id                     | requires                                            | errors and remediations                                                                                        |
| ---------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `finance.bank-sync`    | Plaid credentials set by an admin; a connected bank | `ITEM_LOGIN_REQUIRED`: reconnect on Accounts. Credentials missing: ask an admin to set them in module settings |
| `finance.categorize`   | `finance.bank-sync`; an AI model for new merchants  | No model: rules and the Plaid map still run, everything else waits in Needs a look                             |
| `finance.first-budget` | `finance.bank-sync` with at least one sync          | Under 30 days of history: draft from what exists                                                               |
| `finance.chat-actions` | A budget started                                    | Move above the limit: approval card                                                                            |
| `finance.freedom`      | none                                                | n/a                                                                                                            |

### Determinism boundary

- Every number on every screen renders from the record: drafts, assignments, available amounts,
  review state, activity rows. None comes from model text.
- The module never injects chat turns. The first-budget chat starts from an editable draft the
  user sends.
- The model has exactly two jobs:
  1. guess a category, from the closed list, for a transaction no rule or Plaid mapping places,
     with a confidence;
  2. turn a chat request into finance tool calls.
- Model-authored values crossing into user data get all four guards:
  1. schema field descriptions on every tool input;
  2. the guidance below with a worked example;
  3. a boundary validator (category ids must exist; amounts within manifest bounds;
     `amountCents` must match the stored transaction);
  4. a before-and-after diff in every write tool's result, shown in the approval card when it
     asks.

`assistantOnboarding.guidance` (under 150 words):

> Finance holds the user's budget. Read before you write: call finance.budget.status or
> finance.transactions.query first. Amounts are integer cents. To move money, call
> finance.budget.move with both category ids; use "ready_to_assign" as the source when the
> money is unassigned. For the first budget, call finance.budget.draft.get, then
> finance.budget.draft.update one line at a time. You cannot start a budget; tell the user to
> press Start this budget. Example: "move 50 to groceries" with 80 ready to assign becomes
> finance.budget.move { fromCategoryId: "ready_to_assign", toCategoryId: "groceries",
> amountCents: 5000 }. Report the before and after the tool returns. Never guess a category id;
> list categories first.

### Security and privacy

- No new secrets. Plaid tokens stay in `finance.plaid-tokens` and never reach prompts, activity
  rows or job payloads.
- Job payloads carry ids only (draft id, transaction id, category ids, cents).
- AI input stays payee, amount and date.
- All new tables are owner-only. Nothing in R1 reads another user's data.

### Build phases and tests

| Phase | Contents                                                                                                 | E2E test (Playwright, real dev instance, Plaid sandbox)                                                                                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | P1; migrations 0009-0011; categorization review; Budget, Transactions, Accounts screens; app-map entries | Connect a sandbox bank, see transactions grouped by day, open Needs a look, change one category with "Always for this merchant", see the Budget spent column move                              |
| 2     | Migrations 0012-0013; draft build and start; Getting started screens; draft chat tools                   | From a fresh account, connect, open Getting started, see a draft, ask Moss in chat to set Groceries to $600, see the line change on screen, press Start, land on Budget with those assignments |
| 3     | P2, P3, P4; migrations 0014-0015; families; move and category tools; Freedom and Activity screens        | Pick step 2 with a $100 limit; ask Moss to move $50 (runs, appears in Activity, Undo works); ask to move $250 (approval card); switch to step 1 and sync (new rows land in Needs a look)       |

Each phase ships with its e2e test run and observed to pass, and live proof on the PR.

Verification commands go in the plan, unpiped, with expected exit codes, through the
`verify-gate` skill.

### Kill gate

After phase 1 ships to prod (after R0), Ben uses Transactions for two weeks. If he changes more
than one in five of Moss's confirmed or guessed categories, stop before phase 2 and rework
categorization, because the first budget and every freedom step depend on sorting being right.
Owner: Ben.

## R2: household, alerts, check-in, Today (sketch)

- **Shared budget.** A household budget with its own categories and assignments, funded only by
  accounts both people mark joint. A joint account linked by both counts once (dedupe on Plaid
  `persistent_account_id`) and never appears in a personal budget.
  - The blocker is that owner-only RLS is the only class external-module tables have in v1
    (fin-06 delta:51). R2 needs either a household RLS class from the platform, or the existing
    instance-scope mirror (`finance.shared`, `instanceWritePolicy: "module"`) extended to budget
    rows. The R2 spec must choose with Ben.
  - Either person can change the shared budget. When Moss proposes a change, both get the ask and
    the first answer counts. The activity trail gains a household scope and shows who changed
    what.
  - The shared budget has its own freedom setting. Changing it notifies the other person.
- **Alerts.** Overspent, large charge and sync broken, through `ctx.notify.post`
  (`worker.ts:45-52`). Modules have no quiet-hours wiring today; R2 adds it or asks Ben to accept
  that gap.
- **Weekly check-in.** A schedule (default Sunday 18:00, user-configurable preference) that posts
  a notification linking to a check-in view built from Activity and the week's numbers. Opening
  it offers an editable chat draft, because a module cannot start a chat turn.
- **Today money line.** Through the manifest `briefing` contribution
  (`external-module.ts:327-335`). There is no UI today to turn on an external module's briefing
  (`settings-module-subviews.tsx:235-260`), and Today widgets are built-in only
  (`apps/web/src/external-modules/loader.ts:23-31`). R2 must close one of those gaps.

## R3: receipts and calendar (sketch and verdict)

### Can finance read email and calendar through declared public APIs?

No. External modules have no way to call another module today.

- The worker context is `input`, `deadlineAt`, `preferences`, `localTimezone`, `auth`, `fetch`,
  `kv`, `ai.generateStructured`, `db.query` (own tables only), `embed`, `attachments.readText` and
  `notify.post` (`packages/module-sdk/src/worker.ts:55-169`).
- There is no cross-module call, no event bus and no `publicApi` or `consumes` manifest field
  (`module-sdk/src/index.ts:700-756`; `external-module.ts:344-396`). External manifests cannot
  declare provider functions (`validate.ts:62-79`).
- The email list tool returns no body, at most 30 messages per account
  (`email/src/manifest.ts:218-257`), and the cache keeps 500 characters
  (`email/src/repository.ts:74`). The calendar list tool returns no description
  (`calendar/src/manifest.ts:341-383`). Both are chat tools, not module APIs.
- Email sync calls a fixed Commitments hook, not an event (`connectors/src/google-sync-phases.ts:575,601`;
  `imap-sync-jobs.ts:212`).
- Food asked for the same kind of door in #1697 and it was never built.

### What R3 adds

The platform already adds host ports this way: `ctx.attachments`, `ctx.notify`
(`apps/api/src/external-module-tools.ts:51,91-108`), `ctx.embed`, and the built-in-only
`EmailThreadProvider` (`module-sdk/src/commitments.ts:54-90`, wired at
`module-registry/src/index.ts:3054-3060`).

- `ctx.email.searchReceipts({ since, limit })`: messages the email module classifies as receipts,
  with sender domain, date, subject and a bounded body excerpt. The email module owns the
  implementation.
- `ctx.calendar.listEvents({ from, to, limit })`: title, start, end, all-day and location. The
  calendar module owns it.
- Both are declared in the finance manifest (`consumes: ["email.receipts", "calendar.events"]`),
  shown at install and consentable per user, and wired at the composition root. Finance polls on
  a schedule; there are no events.
- Itemization works for any merchant: the model extracts line items into a fixed schema from the
  excerpt, then matches them to a transaction by amount and date within three days. Unmatched
  receipts wait for review.
- Calendar set-asides propose a savings category for an upcoming trip or event. They are always
  proposals, under the `categories` and `moving_money` families.

## Later

Investment holdings and loan detail. Each bank needs one Plaid update-mode pass to add the
`investments` and `liabilities` products.

## Open questions

| Question                                                 | Owner                 |
| -------------------------------------------------------- | --------------------- |
| Fold Reports into Budget and Accounts                    | Ben, at mockup review |
| Chat actions in R1                                       | Ben, at mockup review |
| Defaults: step 2, $100 limit                             | Ben, at mockup review |
| Guesses count toward the budget before confirmation      | Ben, at mockup review |
| Validator accepts a family that no tool references       | P4 implementer        |
| Household RLS class versus extending the instance mirror | R2 spec, with Ben     |
| Quiet hours for module notifications                     | R2 spec               |
