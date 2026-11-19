# Finance package

## 0.6.0

- Finance now has Start, Reports and Upcoming screens and a settings page that opens from the header cog. Start works with no bank keys. Reports show net worth, spending by category and payee, and cash flow. Upcoming lists the month's bills and lets you add, skip, match, change and stop them. Whole-account export and delete now include Finance data. The settings page cannot change the sorting limits or the dollar limit yet.

## 0.5.2

- The Finance screen shows your budget by month, your transactions and your accounts from the package, on desktop and phone. A bank that cannot sync shows its status and a Reconnect button. Settings, Reports, Upcoming and the first-budget setup panels are not on the screen yet.

## 0.5.1

- Connecting a bank and syncing now have 30 seconds instead of 5, because a real bank sync makes several slow calls in a row. A long history is read two pages at a time, and each sync carries on where the last stopped.

## 0.5.0

- You can share a bank account with your household. Other people see its name, balance and transactions with category and amount, never your notes, review state or bank link details. You can stop sharing at any time and the copy is removed.
- Shared accounts from other people appear in your account list and your monthly transactions, marked with their owner.
- You can read a monthly spending report and a net worth chart, and list the transactions behind a figure. Net worth is never shared.
- You can export your own transaction history as a spreadsheet. Other people's rows are never in it.
- You can list recent changes and undo a category choice, a rule, a new category or an archive, when nothing has changed since.
- You can archive a category that holds no budget money. Income and transfers are protected.
- Not built: undoing a budget change, the Moss guess step for categories, and hiding shared rows from people whose account is switched off.

## 0.4.0

- You can plan bills that repeat, change one coming bill, put it back to its plan, and record a bill as paid.
- Moss suggests bills it finds in your saved spending, and you can dismiss a suggestion.
- You can set monthly, weekly, refill or balance targets for a category, and fund targets from what is ready to assign.
- Several categories can share one flexible pool with one total.
- You can set money aside for a manual credit card payment each month.
- The activity record of these changes holds ids, months and kinds only. It does not store amounts, names or dates.
- Undoing a change, shared accounts, reports and the screens are not part of this package yet.

## 0.3.0

- You can choose your budget currency once. It cannot be changed afterwards.
- You can see a month of your budget: what each category was given, spent and still holds, and how much is ready to assign.
- You can set the amount for one category or up to 20 at once, and move money between categories or from ready to assign.
- You can ask for a first budget built from your last three full months of spending, change or drop its lines, and start it.
- Every budget save checks that nothing changed since you looked. If something did, nothing is saved and you are told to review again.
- The activity record of a budget change holds the month and category only. It no longer stores amounts.
- Flexible pools, targets, card payments, bills, shared accounts, reports and undoing a budget change are not part of this package yet.

## 0.2.0

- You can list your transactions for a month, search and filter them, and save a note on any one.
- You can set a category, confirm what Moss sorted, split a transaction across categories and sort many at once.
- Moss sorts by your payee rules first, then the bank's own category. It confirms a guess on its own only for payees you have seen before, unless you change that.
- You can list and preview payee rules, and add categories.
- You can import a CSV bank file of up to 1 MiB and 200 rows, check it for duplicates and choose what happens to each one. Importing the same file twice saves it once.
- Archiving a category and exporting transactions are not part of this package yet.

## 0.1.0

- Finance starts as an installable package. It keeps the same 24 tables and saved data as before, applied through the same 42 files.
- You can list your own accounts with balances, currencies and, for manual accounts, the opening date and balance.
- You can add a manual account (checking, savings, cash, credit, loan or asset) and manual transactions that move its balance, with the same rules as before: no future dates, no dates before the account opened or inside a reconciled period, current categories only.
- The assistant can do the same, and each write needs your one-use approval.
- The activity record of a new account or transaction now holds only ids. It no longer stores the amount.
- Bank links, accounts shared by other people, budgets, bills, targets, imports, transfers and the screens are not part of this package yet.
