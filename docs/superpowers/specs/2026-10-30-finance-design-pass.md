# Finance design pass and budget speed

Part of #3873 (practical parity with YNAB and Monarch). Builds on the approved
`2026-10-08-finance-redesign-design.md`; where this spec is silent, that one holds. Competitor
notes stay outside the repo. Verification uses synthetic records only.

## Baseline (2026-10-30)

Every Finance screen was captured at 1440 and 320 wide, light and dark, on a private instance
with four months of synthetic history.

| Screen       | Defects                                                                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All          | Tab bar wraps to two rows on a phone. Orange arrow buttons step the month. Page nests a second `main` landmark inside the host's                                                                          |
| Budget       | Category table starts about 1100px down, under targets, card payments and flexible setup. Tall boxed inputs. Instruction lines ("Edit Assigned, then press Enter")                                        |
| Transactions | Six filter selects always open. Bulk bar and helper paragraph always visible. Each row is a tall card holding a select, Confirm, a switch and Split                                                       |
| Accounts     | Four text links on every row. Header buttons crowd the title on a phone. Explanatory line under net worth                                                                                                 |
| Reports      | Forest masthead with marketing lede. Numbered section heads, banned by the redesign spec. Net worth line drawn several pixels thick. Cash flow is a table with no chart                                   |
| Upcoming     | Forest masthead with marketing lede. Explanatory note. With no budget currency chosen the page shows "Request failed (500)", because the module's "currency required" answer reaches the host as an error |
| Settings     | Merchant rules explain themselves in a paragraph                                                                                                                                                          |

## Decisions

| Decision                                                                                                                                | Why                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Forest masthead on Budget (ready to assign) and Accounts (net worth) only                                                               | The approved spec gives a masthead to those two. A masthead on every tab buries the work below a banner      |
| Reports and Upcoming open on a toolbar, like Transactions                                                                               | The selected tab already names the page                                                                      |
| Month steps with a shared `PeriodStepper` in `@moss/ui`: two icon-only arrows around the month name, in masthead ink on the forest band | Approved spec; the orange buttons read as warnings. Three screens need it, so it lives in the shared library |
| Tabs stay one row at every width and scroll sideways on a phone                                                                         | Two rows of tabs push content off the first phone screen                                                     |
| Budget table directly under the masthead. Targets, card payments and flexible setup move under it                                       | Assigning money is the main job, so YNAB and Monarch both open on the category table                         |
| Assigned field keyboard: Enter saves and moves down, Shift+Enter moves up, Escape reverts                                               | YNAB-speed budgeting without a mouse. Saving keeps the typed-amount path, which never asks                   |
| A category row opens a detail panel: activity this month, target, quick amounts, Move money                                             | YNAB's inspector pattern keeps the table dense while the detail stays one click away                         |
| Quick amounts fill the Assigned field; the user still presses Enter                                                                     | No new write path. A typed amount already saves through the reviewed assign queue                            |
| Move money uses the existing `finance.budget.move` tool, with the freedom-limit confirmation Assigned already has                       | The tool exists with no screen. Moves are writes Moss can also make, so they keep the shared confirmation    |
| Transactions: one toolbar (month, search, Filters). Filters open in a disclosure; active filters show as removable chips                | Six always-open selects cost a screen of height for a rare action                                            |
| Transactions: dense rows (date, payee, category, account, amount). Review controls appear only on rows that need a look                 | Rows that need nothing should read as a ledger                                                               |
| Selection bar appears only when rows are selected, pinned to the bottom of the list                                                     | An empty bulk bar is noise                                                                                   |
| Accounts grouped by kind (cash, investments, credit cards, loans, other) with a group total. Row actions move into a `Menu`             | Four links per row read as clutter; grouping matches how both competitors show balances                      |
| Reports: income vs spending bars per month with a net marker; net worth as a 2px line over a light area                                 | Charts should read at a glance; the table stays behind a disclosure for exact numbers                        |
| Remove every explanatory, reassurance and instruction line listed above. Keep only status lines that change what the user does next     | Design-system rule and Ben's 2026-09-06 ruling                                                               |
| Module answers a missing budget currency with a normal result the page understands; Upcoming points to the currency choice on Budget    | A first-run state must never look like a crash. The reviewed currency choice lives in one place              |
| Loading shows nothing for 300ms, then one quiet status line. Empty pages use the shared `EmptyState`                                    | Design-system rule: no placeholder cards. Fast reads should not flash a loading box                          |
| Reports shows the currency picker only when accounts use more than one currency                                                         | A one-option picker is noise                                                                                 |
| Finance renders a `section`, never a second `main`                                                                                      | One main landmark per page                                                                                   |
| Upcoming with no bill plans is one `EmptyState` holding Add a bill; a month with nothing due is one quiet line                          | With no plans the month stepper and section heads have nothing to say                                        |

## Slices

| Slice | Content                                                                                                  | New behavior                                        |
| ----- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1     | Shell and first run: tabs, mastheads, month stepper, copy removal, landmark fix, Upcoming currency state | None beyond the first-run state                     |
| 2     | Budget: table first, compact rows, keyboard assign, category detail panel, quick amounts, Move money     | Move money (#3875); quick amounts (#3876)           |
| 3     | Transactions: toolbar, filter disclosure and chips, dense rows, selection bar                            | None                                                |
| 4     | Accounts and Reports: grouped accounts, row menu, cash flow chart, net worth chart                       | None                                                |
| 5     | Upcoming: month calendar of due bills, plus bill suggestions from repeating history                      | Recurring detection (#3877, own spec section first) |

Each slice ships with its app-map facts, screenshots at 1440 and 320 in light and dark, and the
design-system class audit.

## Slice 2 build notes

- Saves run one at a time through the existing assign and flex-assign tools. Fields stay editable
  while a save is in flight. Enter on another row queues that row; the queue drains once the
  fresh budget read lands, using that read's assigned total as `previousCents`.
- Own-write rebase: each assign bumps the budget revision by exactly one. When the read after a
  save shows `revision === savedFrom + 1`, the same categories, the saved row at its new amount
  with unchanged spending, and every other row's assigned, spent and available unchanged, typed
  drafts on other rows stay valid and move to the new review. Anything else marks them stale and
  drops the queue. The server still checks `previousCents`, so a missed outside change is
  rejected, never overwritten.
- Move money waits while typed amounts are unsaved, a save is running or saved records need a
  check. A move would change the review the drafts were typed against.
- Quick amounts leave out zero and the amount already assigned. The three-month average needs
  all three earlier months to read cleanly in the same currency.
- Phone rows are a two-column table: name, spending and bar on the left; the Assigned field and
  what is left on the right. The row whose panel is open carries the table's open-row edge.
- Finance already declares the platform's 16 app-map features. The two Transactions toolbar
  entries (filters, export) merge into one to make room for keyboard budgeting and the detail
  panel.
- Quick amounts come from reads that already exist: the target's need this month, last month's
  assigned and spent, and the three-month average spent. An amount that cannot be worked out is
  left out, never shown as zero.
- The detail panel is the shared `PeekPanel`, so focus return and modal isolation stay in the
  shared component.

## Slice 3 build notes

- Wide screens show one table: date, payee, category, account, amount. A date column replaces
  per-day headings, so a filtered or searched list keeps its order without orphan heads.
- Phone rows put payee and amount on the first line, then date and account, then the category.
  Amounts never shrink.
- Badges appear only for states that ask for attention: review, pending, uncleared, household,
  possible duplicate, unbalanced split. Posted, cleared and reconciled rows carry none.
- Confirmed rows edit their category through `Select quiet`, so the column reads as text until
  hover or focus. Needs a look rows keep the full picker, Confirm and the merchant switch, in
  the order they are used: picker on its own line, then the switch with Confirm at the end. On
  the narrowest phones Confirm wraps under the switch rather than squeezing the picker.
- The Needs a look tab shows its count only once the register loads, so a failed or pending load
  never reads as zero.
- Split moves from each row into the transaction details footer (Split, or Edit split). Details
  stays a `Dialog` because the note editor already depends on its pending close lock.
- Filters open in a panel under the toolbar; the button shows the active count. While the panel
  is closed, active filters show as chips, so nothing appears twice. Your entries only is a chip
  whose remove button includes shared records again.
- Export becomes a toolbar `Menu` with Loaded rows and Full history. Both keep their existing
  paths and limits.
- The selection bar renders only while something is selected, a check is pending or its review
  is open. The header box selects every editable loaded row up to 200. The bar keeps Select
  editable rows because phone rows have no header box.
- The loaded-of-total count shows under the list only when more rows match than are loaded.
  Otherwise it stays in the page for screen readers and is visually hidden.
- Search is `type="search"`, so phones show the search key and a clear button.

## Slice 4 build notes: Accounts

- Groups run Cash, Investments, Credit cards, Loans, Other, so assets read before debts. Cash
  holds checking, savings and cash on hand, the same rule ready to assign uses. Each group head
  shows its total per currency.
- The masthead reads Net worth, with the currency added only when there are several. Its lede
  gives assets and the debts owed in the same currency.
- One table per group with the same columns (name, balance, actions), so balances align down
  the page. The group head labels its table, so there is no header row.
- A row's name opens Transactions filtered to that account, through the register's existing
  account link. Under the name, one line says Manual or names the bank with its sync time, or its
  as-of date when the bank cannot sync.
- A bank that cannot sync shows its status, stored message and Reconnect once, above the groups,
  instead of on each of its rows.
- Manual rows keep Add transaction, Reconcile, Import CSV and Manage in a row `Menu`. Each item
  keeps its old accessible name ("Reconcile Synthetic wallet"). Bank rows have no menu.
- The toolbar holds Record transfer and an Add account menu (Manual account, Connect a bank).
  One add entry matches both competitors, and two controls fit one line at 320.
- With no accounts the page is one `EmptyState` holding Add manual account and Connect a bank.
  Record transfer needs two accounts, so the toolbar is hidden.
- Removed: the Accounts section head (the tab names the page), the line explaining debts and
  currencies, and the closed-accounts help line.

## Slice 4 build notes: Reports

- Two shared charts join `@moss/ui`: `ColumnChart` and `TrendChart`. No chart library; the marks
  are positioned elements and one SVG path, styled by `components-charts.css`.
- Cash flow is income and outflow columns per month with an ink dot for net. The legend carries
  the window totals. Hover, tap, focus and the arrow keys show one month's readout, and a polite
  live region speaks the same text.
- Series colours are `--steel` then `--gold-strong`, the same in every theme. The palette
  validator passes both modes on colour-blind separation, the normal-vision floor and 3:1
  contrast. It flags the chroma floor because Park Press is muted by design, so the legend,
  readout and table carry identity too. Accent beside gold failed in dark canyon, and park themes
  re-point the accent, so the accent never takes a series slot.
- Net worth is one 2px line over a 10% area, spaced by real dates because snapshot days are
  uneven. It keeps zero on the axis unless the values sit far from it. The data holds only the
  total, so there is no assets and debts split; that needs a server change.
- The monthly table moves behind a Monthly numbers disclosure and keeps every open-detail button.
  The chart never holds the only copy of a number.
- Removed: the cash flow caption (pending included, refunds reduce outflow, transfers excluded)
  and the net worth sources caption. Both facts move to the Reports app-map entry.

## Slice 5 design: Upcoming calendar and bill suggestions

### Bill calendar

- Upcoming opens on a month grid of due bills under the period stepper. Each bill is a chip on
  its planned date with name and amount; posted, skipped and needs-review states keep the badges
  the list already uses.
- The month total sits in the section head: due, paid so far, still to pay.
- A chip opens the same bill actions the list row has today. The list stays below the grid as
  the full record and the keyboard path.
- List rows put status and amount on one line and the actions in one row, commonest first
  (match, skip, record, change). A bill that is simply due on time carries no badge, so the
  badges that remain (posted, skipped, past due, needs review) stand out.
- Phone: no grid. The list grouped by week is the calendar. Rows drop their action buttons and
  show Details, which opens the same panel a chip opens; three tall buttons per bill made a
  month of bills several screens long.
- The month totals may drop below the "Bills due" title on a phone rather than squeeze it
  (shared `SectionHead wrap`).
- Built from the shared month grid (`DayCell`, `.cal-month`) rather than a Finance copy.

### Suggestion rules

Input is the owner's own posted history for the last 400 days, in the budget currency.
Excluded: pending, income and transfer categories, inflows, shared rows, and transactions
already matched to a bill.

| Step      | Rule                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payee     | Group by account and `normalizePayee(merchant ?? name)`. An empty key never matches                                                                                                   |
| Amount    | Within a payee, split charges into amount bands. A charge joins a band within max(10% of the band median, $1.00)                                                                      |
| Gap       | Weekly 7 days ±1, fortnightly 14 ±2, monthly one calendar month ±3 days, yearly one calendar year ±7 days                                                                             |
| Run       | Walk back from the newest charge while every gap fits one cadence. Weekly, fortnightly and monthly need 3 charges; yearly needs 2                                                     |
| Current   | The next expected date must be no more than one gap's tolerance in the past                                                                                                           |
| Existing  | Drop it when an active plan on the same account shares its payee key, or has the same cadence, an amount within 25% and a due date within the gap tolerance of the next expected date |
| Dismissed | Drop it when a dismissal for the same account, payee key and cadence is within 25% of its amount                                                                                      |

- The suggestion carries the display name (newest charge), the newest amount, the cadence, the
  next expected date, the account and the newest charge's category when it has one.
- Ties within a payee: each band is tested on its own, so two subscriptions from one store at
  different prices become two suggestions.
- Output is capped at 20, soonest next expected date first.
- The due-date check on the Existing rule stops one planned bill from hiding a different charge of
  similar size, such as a $13.99 plan on the 3rd hiding an $11.99 charge on the 11th.

Near misses the tests must reject:

- a grocery store on irregular 3 to 10 day gaps
- a restaurant whose amounts vary more than the band allows
- two monthly charges only
- a monthly run that stopped three months ago
- one payee at alternating prices where neither band reaches three charges
- a refund or inflow from a subscription payee

### Accept and dismiss

- Accept opens the normal Add a bill form filled in. Saving goes through the usual review; the
  new plan then hides the suggestion through the Existing rule.
- Dismiss writes one owner-only row: account, payee key, cadence, amount, time. It never asks,
  because it deletes nothing and only hides a suggestion.
- New module table `app.finance_bill_suggestion_dismissals` (module migration 0042) with
  `owner_user_id`, listed in the manifest's owned tables so the host adds its owner-only row
  security. Unique on owner, account, payee key, cadence and amount, so two prices from one
  payee dismiss separately.
- Two new tools so Moss can do the same: `finance.bills.suggestions` (read) and
  `finance.bills.suggestions.dismiss` (write). Payloads carry ids and the key fields, never notes.

### Screen

- Suggestions sit in one section under the calendar, only when there is at least one. Each row:
  name, cadence and amount, last charged date, Add as bill, Dismiss.
- No section with nothing to say, no explanatory line.

## Acceptance

- Budget: the first category row is visible without scrolling at 1440x900.
- Budget: assigning four categories in a row needs no mouse.
- Phone: tab bar is one row; no two controls touch; amounts wrap under titles, not shrink.
- Upcoming with no budget currency points to the currency choice, never an error.
- No section numbers, no marketing or instruction copy on any Finance screen.
- `pnpm check:ui-classes` clean for Finance.
- Live proof on a running instance through the real screens, recorded on #3874.
