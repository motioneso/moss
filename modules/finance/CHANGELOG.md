# Finance package

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
