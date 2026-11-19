# Finance Start, Reports, Upcoming and settings screens (part 27) report

Part of the Phase 5 plan in `2026-11-13-rust-phase5-meals-finance-wellness-and-rest-plan.md`. Task JS-344.

### What was built

- Start screen. A person with no account lands here. It explains that a manual account needs no
  bank keys, offers "Add a manual account", and shows "Waiting on your admin" for the bank step
  when no keys are saved. A new route reports whether keys exist, whether the person has a bank
  or manual account, and the two sorting tiers. A person with an account and no link lands on
  Budget.
- Reports screen. Net worth with a trend line (hidden until there are two days), balance
  sources and history, spending by category and by payee for a chosen month, cash flow by month,
  and a detail list for one figure with paging. Loading, empty and broken states exist.
- Upcoming screen. A month stepper, totals, bills grouped by week, suggested bills and bill
  plans. Add a bill, Stop future bills, Skip, Change this occurrence, Match posted and Record
  bill entry (preview, then record). Writes carry the review fields read with the bills.
- Settings screen at `/settings/finance`, opened only from the module header cog. It shows the
  two sorting tiers (read only), bank key status, merchant rules and this week's activity with
  Undo.
- Finance sections of account export and delete, as account-contract entries. Export pages the
  person's own rows. Delete removes children before parents.
- App map: version 0.6.0, the settings entry, the `/settings/finance` screen, a new route and the
  features `finance.account-data`, `finance.start` and `finance.settings`.
- The UI check server now serves the settings screen.

### Proof

| Check                                                                  | Result                       |
| ---------------------------------------------------------------------- | ---------------------------- |
| Screen unit tests (node, 24)                                           | Pass                         |
| Account tests, including the setup status route (5)                    | Pass                         |
| Package tests, with the component built (7)                            | Pass                         |
| `pnpm verify:static` steps lint, format, file size, design and classes | Pass                         |
| `pnpm typecheck` and `pnpm build:app-map`                              | Pass, exit 0                 |
| `pnpm verify:static` as one command                                    | Exit 1, see below            |
| Live check, desktop 1280 and phone 390, real data, no bank keys        | Done, see the proof artifact |

`pnpm verify:static` stops at the migration number check. It reports four numbers (0238, 0239,
0287, 0330) claimed by open PR #4367 (Meetings part 7a) that already exist on main. This branch
adds no migration. The two steps after it were run on their own and pass.

The live check ran the real package on the Rust host with a fresh account, no bank keys, then
added an account, four transactions, a budget currency and a bill. It found and fixed four
layout faults: spending bars were indented with centred labels, the bill actions were hidden on
phones with nothing to replace them, rows on Start and Settings sat tight against each other,
and the net worth card showed a blank gap for a single day.

### Not proven or not built

- Tier switches, the dollar limit and the custom tiers are not editable. The frame cannot write
  them, and `moving_money`, `rules` and `categories` are not declared tiers.
- "Add bank keys" for admins is not offered. Start shows "Waiting on your admin" to everyone.
- The first-budget panel on Start is replaced by landing on Budget once a person has an account.
- The Upcoming month calendar for desktop is not built. The list view is.
- The activity wording and merchant rule editing are simpler than the old screen.
- Shared spending merges without a household directory check.
- Account delete order is checked only against the fake host. The live run did not delete.
- The phone tab bar scrolls sideways, so "Upcoming" is partly cut off until scrolled.
- A bill row on desktop shows its amount beside the name, not at the right edge.
- Not exercised live: Stop future bills, Skip, Match posted, Record bill entry, Undo, and a
  second device on the home network.
- The installed test `a_bank_connects_syncs_fails_and_reconnects` fails on clean main and is
  unchanged.
- Vikunja card 344 is an unrelated finished task. The real tracker is herdr-task JS-344.
