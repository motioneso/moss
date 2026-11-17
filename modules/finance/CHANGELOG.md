# Finance package

## 0.1.0

- Finance starts as an installable package. It keeps the same 24 tables and saved data as before, applied through the same 42 files.
- You can list your own accounts with balances, currencies and, for manual accounts, the opening date and balance.
- You can add a manual account (checking, savings, cash, credit, loan or asset) and manual transactions that move its balance, with the same rules as before: no future dates, no dates before the account opened or inside a reconciled period, current categories only.
- The assistant can do the same, and each write needs your one-use approval.
- The activity record of a new account or transaction now holds only ids. It no longer stores the amount.
- Bank links, accounts shared by other people, budgets, bills, targets, imports, transfers and the screens are not part of this package yet.
