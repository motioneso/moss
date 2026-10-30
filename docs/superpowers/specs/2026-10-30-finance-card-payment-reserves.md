# Finance: reviewed card-payment reserves

Extends Finance budgeting task #1148 and the [parity matrix](2026-10-28-finance-parity.md).
Within the user's delegated Finance product and platform scope. No deployment, merge, real bank,
financial action, or PR publication. Existing full-debt accounting remains the default.

## Behavior and boundaries

An owned manual credit card in the budget currency can opt into payment reserves in the current
month through a captured preview and host-confirmed save. Earlier months retain their existing
math. Other cards continue full-debt accounting. This is a budget reservation, never a payment.
Enrollment persists from its effective month; disabling or rewriting past policies is outside
this slice. Provider cards remain on full-debt accounting until their historical baseline and
payment matching can meet the same acceptance criteria.

The Budget screen gains a separate Card payments section, using existing Park Press primitives,
semantic colors, typography and inline Dialog lifecycle. Each card shows owed, cash reserved,
uncovered debt, funded spending, refunds, and recorded payments. A reviewed setup explains the
change in Ready to assign and asks how much cash to reserve for starting debt. A funding review
sets desired available payment cash, showing its effect on Ready to assign. Negative reserves
are shown as overspent payment cash; they must be covered before automatic target funding.
Excess cash is visible and can be released. Archived enrolled cards remain visible so cash is
never orphaned; increasing their reservation is blocked, releasing it remains possible.

Only explicit complete manual transfer pairs count as card payments for an enrolled card.
Legacy inferred or unlinked transfer rows in the effective period prevent enrollment, with a
repair message. The same validation applies to subsequent reads and changes. Pending entries
never enter reserves. Refunds reverse reserved cash; statement credits categorized as Income
reduce debt without silently moving cash out of the payment reserve. Uncategorized purchases
show in uncovered debt, without claiming they have cash backing.

## Accounting

Money calculations use BigInt internally and validate safe integer cents at boundaries. Manual
card balances start at their immutable opening balance and process posted entries by date and
stable id. Positive raw balances mean debt; negative balances mean a positive card asset.
For a non-transfer entry, debt movement is `max(after, 0) - max(before, 0)`. The remainder of the
entry is cash-like activity. Mixed-sign splits divide debt movement proportionally using exact
integer arithmetic and deterministic largest-remainder cent allocation.

Existing envelope and flexible-pool derivation stays canonical. For each category or pool:

- `B = available + activity` (positive carry plus this month's assignment).
- `charges = sum positive enrolled-card debt allocations`.
- `refunds = sum negative enrolled-card debt allocations`.
- `cashLike = activity - charges - refunds`.
- `funded = min(charges, max(0, B - cashLike - refunds))`.

Allocate funded cents proportionally among contributing card charges, with deterministic
largest-remainder rounding. This is an explicit Moss policy when multiple cards compete for
underfunded category cash; it does not claim identical YNAB allocation order.

Per card/month, `paymentAvailable = positive previous carry + assigned + funded + refunds -
recordedPayments`. Payments consume their full linked amount, including overpayments. Negative
payment cash does not carry as an envelope balance into the next month. Positive cash does.

For months where a card is enrolled, its debt no longer reduces the account funding total;
only its positive asset does. Unenrolled accounts retain their existing signed funding math.
`Ready = funding - all signed ordinary available - all signed payment available - current
unfunded categorized card spending - future reserved assignments`. The unfunded term prevents
credit overspending from creating spendable cash. Historical funding uses reconstructed manual
balances; future Ready remains unavailable. A conservation test checks this equation independently.

## Storage and capture

Add two owner-only module tables for effective-month card policies and absolute monthly card
assignments. Never edit an applied migration. Add both tables to the budget change fingerprint.
Enrollment/funding and their metadata-only activity select from the existing single successful
budget revision update. Captures include revision and ledger fingerprint; changed ledger,
category, balance, policy or assignment invalidates the review. Same-review competing writes
must yield one success. Do not claim mid-statement ledger linearizability without a real
concurrency test; fix coordination if a barrier test exposes a race before enabling that write.
No private notes enter captures or activity. No automatic financial-write retries.

## Testable acceptance

1. Unenrolled budgets and all months before enrollment retain exact existing results.
2. Starting debt, partial cash coverage, funded purchases, unfunded credit spending, cash-first
   funding, partial payments, inverse transfer corrections, refunds across zero, statement
   credits, positive card balances, mixed-sign splits, multiple cards and flex pools conserve
   cents. Include safe-integer limits, stable rounding, leap months and carry/reset behavior.
3. Current Ready and historical reconstructed balances agree with independent conservation
   examples; future funding stays unavailable. No pending/provider/mock payment is counted.
4. Database migration works on fresh and restored module storage. Foreign users and admins
   cannot read or write another owner's policy or assignments. Observe privacy guards red when
   removed, then restore and rerun. Stale and replayed captures do not change data or activity.
5. Real installed synthetic UI exercises setup, cancel, confirm, reload, fund, release and stale
   capture rejection. Inspect desktop/phone and light/dark for readable values, keyboard focus,
   honest loading/error states and no hidden dialogs. Capture screenshots of the final UI.
6. Update the app map and parity matrix truthfully. Run relevant units, SQL/native gates, static
   checks and aggregate gate; distinguish baseline failures and unrun checks. Commit and push
   reviewable checkpoints without merging or publishing a PR.

## Official evidence

- [YNAB card handling](https://support.ynab.com/en_us/handling-credit-cards-overview-ry7cNub1s):
  funded purchases move money into a separate payment category; existing debt needs assignment.
- [YNAB red payment category](https://support.ynab.com/en_us/when-your-credit-card-payment-category-is-red-a-guide-SJDSr3Q1i):
  cash backing, overspending, refunds and overpayments need explicit review.
- [YNAB credit overspending](https://support.ynab.com/en_us/credit-card-overspending-an-overview-HkMGpSbJs):
  unfunded card spending creates debt rather than extra cash.
- [YNAB refunds](https://support.ynab.com/fr/credit-card-refunds-and-returns-H1J7qDWkj):
  refunds restore spending-category money and can leave payment cash negative.
- [YNAB positive card balance](https://support.ynab.com/en_us/credit-cards-with-a-positive-balance-an-overview-By_H6uzJo):
  positive card assets require different treatment from owed balances.

These sources motivate the capability; the equations above define Moss behavior and its bounds.

## Concurrency implementation decision

Inspection found that module SQL calls have individual transactions and snapshot-based budget
fingerprints, but no common mutation lock. A fingerprint checked within a statement can miss a
ledger transaction committing during that statement. Before enabling reserve writes, serialize
module mutations per module and actor in the canonical module-storage RPC using a transaction
advisory lock acquired in a separate statement before the authored SQL snapshot. Existing RLS,
read-only classification, timeout, result limits and redaction remain unchanged. Reads do not
acquire this lock. Different users/modules have independent keys. The lock survives only for
the caller's transaction and rolls back normally. A real barrier test must demonstrate waiting,
then rejection of the old fingerprint after the earlier ledger mutation commits. Observe that
same test fail without serialization, then restore it. This is necessary platform work within
the user's expanded authorization, not a Finance-only alternate SQL route.
