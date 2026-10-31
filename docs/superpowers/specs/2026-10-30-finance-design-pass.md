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
| Accounts grouped by kind (cash, credit, loans, other) with a group total. Row actions move into a `Menu`                                | Four links per row read as clutter; grouping matches how both competitors show balances                      |
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

## Acceptance

- Budget: the first category row is visible without scrolling at 1440x900.
- Budget: assigning four categories in a row needs no mouse.
- Phone: tab bar is one row; no two controls touch; amounts wrap under titles, not shrink.
- Upcoming with no budget currency points to the currency choice, never an error.
- No section numbers, no marketing or instruction copy on any Finance screen.
- `pnpm check:ui-classes` clean for Finance.
- Live proof on a running instance through the real screens, recorded on #3874.
