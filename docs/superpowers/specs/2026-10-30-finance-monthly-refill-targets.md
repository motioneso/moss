# Finance monthly refill targets

Continuation of the authorized Finance parity work under #1144/#1148. Reuse the existing category
ledger, versioned targets, captured budget review and selected confirmed funding; no new fund or
automatic money movement. This follows the separately verified weekly contribution slice.

## Product evidence and deliberate boundary

Official YNAB [target types](https://support.ynab.com/en_us/getting-started-with-targets-ryAEP08xC)
and [target usage](https://support.ynab.com/en_us/how-to-use-targets-rk5kkI9ks), checked 2026-10-30,
distinguish setting aside another contribution from replacing what was spent or unassigned last
period. Their indexed help also describes refund-related differences; full articles were not
readable in this environment. Do not claim every YNAB refund or custom-period behavior matches.

Moss's bounded Monthly refill guides one calendar month's spending allowance. Progress counts
positive money carried into this month plus net assignments this month. Spending and refunds
within this month do not reopen or reduce its contribution suggestion. A refund changes ordinary
available money and may carry into the next month, where it naturally reduces the next refill.
This is distinct from maintaining an available balance after every purchase, from monthly/weekly
new-contribution targets and from balance-by-date savings. The editor must explain that distinction.

Example: carry 20.00, assigned 30.00 and spent 25.00 count as 50.00 toward a 100.00 refill.
The suggested additional assignment is 50.00, not 75.00. Further spending does not ask for more.
A reduced assignment does change progress. Excess funds stay in the category; no withdrawal.
Future-month guidance uses provisional carry from the saved plan; funding remains current-month
only and rechecks the canonical ledger, ready money, overspending and target versions.

## Storage and math

Add kind refill with positive safe-integer amount, no date and no weekday. Additive migration
0038 only extends current target constraints; old rows, historical versions and migration hashes
remain unchanged. Never reinterpret existing monthly targets as refill. The editor offers Monthly
refill as an explicit choice and retains it on edit/reload. Removal clears date/weekday as usual.

Use BigInt for progress = available + activity (the existing envelope identity is positive prior
carry + net assigned - activity = available). This includes current-month negative assignments
without counting spending/refunds as contributions. Missing state is zero. Reject unsafe results
using existing exact-cent checks; do not clamp or silently create money. Remaining is max(target -
progress, 0). Keep ordinary monthly, weekly and dated behavior unchanged. Reuse the same selected
funding server recalculation and atomic assignment/activity write with mandatory host confirmation.

## UX and acceptance

Use the current Park Press controls and compact shared dialog layout. Explain carry-plus-assigned
progress in the editor, row and funding selection so a met plan with already-spent money is clear.
Show eligible funding suggestions before reached/unavailable rows, so their basis and amount are visible on a phone before historical guidance. Keep all unavailable reasons accessible. No automatic funding, bank operation, service integration or financial advice. Preserve stale/
uncertain read recovery, immediate locks, category/archive/pool checks and current assignment limits.
Update the owning manifest and evidence-linked parity matrix without claiming full target parity.

Unit tests distinguish carry/assignment from current spending/refunds, cover negative assignments,
excess balances, absent state, exact bounds and unchanged existing kinds. Handler/editor tests pin
no date/weekday, explicit kind and metadata-only saving. Real installed SQL proves migration 0038,
versioned round-trip, old-shape constraints, actual carry/spending math, exact selected funding,
unchanged accounts/receipts during funding, stale refusal and historical preservation.

Exercise real installed native creation/reload, the explanatory copy, selection/cancel/host confirm
and saved assigned totals using synthetic data. Inspect light/dark/Sage at phone/tablet/desktop.
Run Finance units and complete backend/native regressions plus repository maintainability checks;
record failures and unrun checks honestly. Broader goal/refill custom-period parity stays partial.
