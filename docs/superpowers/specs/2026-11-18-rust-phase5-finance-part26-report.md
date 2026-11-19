# Rust port phase 5, Finance part 26 report (screens)

Task JS-342. Budget, Transactions and Accounts screens, shipped inside the signed Finance package
and served by the Rust server. The screens reproduce the approved TypeScript screens under
`external-modules/finance/src/web` with no redesign.

## What changed

- `modules/finance/ui/`: plain ES module screens (budget, transactions, accounts, dialogs), their
  models, two CSS files and two unit test files.
- `modules/finance/host/src/package.rs`: the 15 UI files are baked into the package.
- `modules/finance/moss.module.json` (version 0.5.2): `screens` entry for `/finance`, a Finance
  navigation entry, feature descriptions updated for accounts and transactions.
- `modules/finance/host/tests/package.rs`: new test that every file the page loads is in the package.
- `modules/finance/host/src/bin/finance-ui-check/` and `tools/ui-gate.*`: disposable HTTPS server
  with the signed package, used for the live proof (`pnpm test:rust-finance-ui`).

## Checks

| Check                                                                     | Result                  |
| ------------------------------------------------------------------------- | ----------------------- |
| Screen unit tests (16, node)                                              | Pass                    |
| Static gate `pnpm verify:static` (lint, format, file size, design checks) | Pass, exit 0            |
| Package test `the_screen_ships_with_every_file_it_loads`                  | Pass                    |
| Finance host tests, the rest                                              | See "Gate result" below |

## Live proof

Real Rust server, real HTTPS, real sign-in, signed package installed through a temporary registry.
No network response was intercepted or rewritten. Desktop (1280 wide) and phone (390 wide) views.

- Empty budget shows "Choose a currency"; after setting it with no accounts it shows "Give your
  budget an account".
- Accounts, desktop and phone: net worth $8,794.05, assets $9,174.30, debts $380.25, Cash and
  Credit cards groups.
- A bank that cannot sync shows "Harbor Credit Union · Sign-in expired" with a Reconnect button, and
  its account balance shows "As of November 10".
- Budget: assigning $200 to Groceries with Enter saved, and Ready to assign fell from $8,794.05 to
  $8,594.05.
- Transactions: choosing Groceries for Corner Market and confirming saved; Needs a look went from 5
  to 4 and survived a reload. Confirming with no category shows "Choose a category first."
- Browser console: no errors or warnings during the runs.
- Found and fixed during the proof: a dialog opened far below the visible area in a tall frame (it
  now scrolls into view), and a stale balance showed a raw timestamp (now "As of Nov 10").

## Not proven / not built

- The bank row was inserted directly into the disposable database, because the fixture has no
  Plaid. It is the state a failed sync stores. No real Plaid link was made.
- Clicking Reconnect sends a chat request to Moss, as the TypeScript screen does. The fixture host
  has no chat, so nothing visible happens there.
- Not viewed from a real phone on the home network; the phone view is a 390 wide browser window.
- Header cog and module settings (part 27).
- Not on the screen yet: transfer, reconcile, manage and close, Import CSV, undo, category detail,
  targets, flex, card payments, first-budget panels, Reports, Upcoming, Start, sharing and activity.
