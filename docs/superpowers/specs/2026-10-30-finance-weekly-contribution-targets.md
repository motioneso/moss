# Calendar-based weekly contribution targets

Authorized continuation of Finance #1144/#1148. Commit/push the isolated branch; no PR publication,
merge, deployment, production financial data, bank connection, credentials or real money action.
Preserve existing monthly/balance targets, ledger values, historical versions and write safeguards.

## Official comparison and deliberate Moss boundary

Official indexed documentation checked October 30:
[YNAB target types](https://support.ynab.com/en_us/getting-started-with-targets-ryAEP08xC),
[using targets](https://support.ynab.com/en_us/how-to-use-targets-rk5kkI9ks), and
[starting mid-month](https://support.ynab.com/en_us/starting-ynab-in-the-middle-of-the-month-a-guide-rJH96acA9).
The type guide describes weekly amounts that change when the chosen weekday occurs five times,
and a contribution behavior planning the full month. The mid-month guide also describes weekly
behavior excluding prior weeks. Full article bodies were not exposed by the current web reader;
do not assume these different behaviors are identical. This slice explicitly implements a full-
calendar-month contribution plan, named as such in Moss. It does not silently promise mid-month
proration, refill behavior or every YNAB target mode.

[Monarch Save Up Goals](https://help.monarch.com/hc/en-us/articles/44373182867476-Using-Save-Up-Goals),
updated October 19, covers target amount/date, planned monthly contributions, account allocations
and optional spending effects. A weekly Moss category contribution is not an account-linked goal,
investment forecast, refill fund or complete Monarch Goals implementation. Keep those matrix gaps.

## Financial semantics

Choose an exact weekly amount and weekday. For each viewed calendar month, multiply that amount
by its four or five occurrences in the full month. For example, 25.01 each Friday in October 2026
means five Fridays and a 125.05 monthly contribution target. February 2026 has four Fridays, so
the same definition means 100.04 then. Count calendar days, never elapsed milliseconds or locale-
dependent parsing; owner-local month selection remains the existing Budget contract.

Progress counts that month's assigned amount, independent of spending and positive rollover,
consistent with the existing monthly contribution type. Spending does not reopen an already funded
weekly contribution; rollover does not count as a new contribution. Recompute the monthly total
when viewing another month without changing the stored per-week amount. Creation mid-month still
plans the whole month and counts all current-month assignments; explain this explicitly before
saving. No automatic weekly assignment, catch-up bank movement, return of excess assignments or
change to existing cash/card/rollover semantics. Users select suggestions and confirm any funding.

Use safe integer hundredths and BigInt intermediate multiplication. A weekly amount cannot exceed
floor(MAX_SAFE_INTEGER / 5), so every possible month's total is representable. Reject invalid day,
zero/negative/unsafe money or out-of-range totals instead of clamping. Existing assignment limits,
ready-money availability, category overspending priority and pool/archive rules still apply.

## Versioned storage and writes

Add weekly kind and an optional weekday to category targets. It is required only for weekly,
with Sunday=0 through Saturday=6; monthly/balance/removed rows retain no weekday. Weekly has no due
date. Additive migration 0037 adds the column and updates kind/shape constraints in one ALTER;
retain positive money, removed-zero/date and dated-balance invariants. No existing migration edits,
target conversion, new fund ledger, table or account changes. Earlier target versions remain.

The metadata handler validates weekday only for weekly and saves through the existing owner-
scoped, revision/fingerprint-checked target operation. Remove passes neither due date nor weekday.
The SQL read/save mapper returns weekday only when present so old target DTOs remain compatible.
The existing budget fingerprint includes each target row's xmin, so changing only weekday must
invalidate a captured review even when both weekdays occur the same number of times. Verify this
with an owned raw-weekday change that does not advance policy revision.

Target progress and funding expose the selected weekday, occurrence count and monthly total.
Use the existing selected-funding handler and atomic budget ledger/activity commit; no new write
tool or confirmation policy. Server recalculates the suggestion. Target creation remains metadata
only; actual funding retains its mandatory host confirmation and uncertain-read boundary.

## Native design

Extend the existing Park Press Target type Select with Weekly contribution. Require an explicit
weekday choice, retaining it on edit. Keep the existing exact amount input and show an inline full-
month preview: per-week amount, day count and total for the viewed month. Clarify that progress is
new assigned money and the whole month is planned even when created late. No implicit personal
weekday, extra modal, new colors or custom control. Existing captured metadata, immediate locks,
stale/uncertain recovery and post-save fingerprint wait remain.

Target rows show weekly amount/day and that month's count/total without pretending the amount is
per month. Funding selection shows the same calendar basis and exact additional assignment;
before/after category totals and remaining ready money keep the existing review. Legacy read-only
pooled/archived reviews can remove weekly targets while disabling ordinary edits. Add app-map/tool
schema facts within current limits. Inspect phone/tablet/desktop in light/dark/Sage, including
editor and selected funding; keep controls/footer within bounds using shared scrollBody behavior.

## Acceptance

Unit tests cover all weekdays, four/five occurrences, leap/century February, first/last supported
years, exact fractional cents and overflow. Monthly/balance outputs remain unchanged. Verify
assigned-versus-spending/rollover semantics, different viewed months, removal and invalid inputs.
Pin required weekday and full-month native preview, edit preservation and metadata-only behavior.

Real SQL tests cover 37 migrations, old monthly/balance compatibility, owner/versioned weekly
round-trip and prior-month preservation, invalid weekday/shape/overflow refusal, current-month
selected funding and canonical balances/transactions unchanged. A raw change between two same-
count weekdays without policy revision must reject a captured funding review. Existing concurrent,
ready-money, owner/admin and flexible-pool checks remain active; do not weaken them for acceptance.

Exercise actual installed native weekly creation, edit/reload, full-month guidance and selected
funding with synthetic records. Existing installed startup uses real approval/onboarding/migration;
state any separate synthetic fixtures explicitly. Reuse the existing funding flow helper rather
than exceeding the central 1,000-line test limit. Run Finance units, complete backend and installed
regressions, repository lint/types/format/size/UI checks and the safe aggregate gate. Record exact
source and pass/fail/unrun outcomes; keep broader target parity partial.
