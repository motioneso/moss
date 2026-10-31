# Reviewed target funding assistance

Authorized Finance parity continuation, extending #1144/#1148. Commit/push the isolated
branch only; no PR publication, merge, deployment, production data, credentials, banks
or live financial actions. Existing target types and budget/currency/card policy stay intact.

The official [YNAB auto-assign guide](https://support.ynab.com/en_us/auto-assign-a-guide-r1gBNbBJo)
and [Underfunded logic](https://support.ynab.com/en_us/underfunded-a-guide-BJwPhQO09), checked
October 30, describe quickly assigning money toward targets and other priorities.
[Monarch's current goals guide](https://help.monarch.com/hc/en-us/articles/44373110771860-Goals-in-Monarch)
and [Save Up guide](https://help.monarch.com/hc/en-us/articles/44373182867476-Using-Save-Up-Goals)
cover planned contributions, account allocations and goal progress. Moss already has
versioned monthly contribution and dated category-balance targets, but requires separate
manual assignment edits to act on them. This slice adds explicit selected-target assistance;
it does not reproduce either product's full prioritization or account-linked goal model.

## Behavior and data

Add no second allocation ledger or duplicate savings balance. Build bounded proposals from
the existing owned current-month budget snapshot, target progress and live taxonomy. Each
line names a target/category, current assigned total, suggested additional cents and new
assigned total. Monthly contribution targets suggest the remaining contribution. Dated
balance targets retain the existing remaining-balance/months-left calculation: call this
an additional suggestion today, explain that spending/funding changes it, and do not claim
a stored monthly installment or completed monthly contribution. All arithmetic is exact
integer cents. Refuse or disclose assignment-bound overflow; never clamp silently.

Only current-month proposals are actionable. Missing historical funding, future/past months,
nonpositive ready-to-assign, archived categories, reached targets and flexible-pool members
must not produce an eligible write. Preserve existing flexible pool routing; never fund a
member behind its pool or reinterpret its contribution guidance. Ordinary fixed/non-monthly
targets may be selected in flexible mode. Show why no proposals can be funded.

Allow explicit selection of one to twenty eligible targets, with no hidden priority or
partial allocation. Read-only review shows exact additions, each before/after assigned total,
selected total and ready-to-assign before/after. If the selected total exceeds ready money,
require a smaller selection; do not overassign, withdraw other category funds or silently
choose winners. Proposals above the existing per-assignment bound are unavailable with a
plain explanation. More than twenty eligible targets remain selectable through later reviews;
show the bound without silently truncating the list.

The new confirmed tool receives month, unique selected IDs, their captured suggested cents,
and captured revision/fingerprint. Rebuild the proposal on the server and compare amounts;
reject changed guidance (including a date-boundary change), stale/missing targets, invalid
selection and insufficient ready money before a write. Commit all selected assignment totals
and existing budget.assign activity/Undo facts through the established atomic budget-change
store and review CAS. There are no transaction/account mutations, money transfers, recurring
jobs, automatic write retries or new migrations. Existing provider convergence limitations
remain separately tracked; no universal concurrency claim is made.

## Native workflow

Category targets offers Review target funding when the current saved budget has eligible
suggestions. Disable it while assignment drafts, another save or uncertain budget state exist.
Use a shared native dialog with compact spacing, semantic money/status text and accessible
checkboxes. Selection updates the displayed total locally; the captured snapshot stays fixed.
After explicit review, the host must confirm the exact selected payload. Declare both assistant
confirmation policy and native confirmWhenKeys; default action-family preferences cannot skip
this confirmation. Cancel retains selection/review. Stale/uncertain results keep input and block
until an explicit successful fresh saved-record read. Lock submission and dismissal immediately,
not only after React renders; never retry a write automatically. Saved success refreshes the
budget and target progress together.

Tighten the existing target-edit dialog's immediate duplicate/dismissal guard while touching this
workflow; target metadata remains separate from assigning money. Keep earlier target versions.
Update existing app-map declarations within manifest limits, including empty/unavailable states
and recovery instructions. Do not add a decorative tab or duplicate goals overview.

## Acceptance

Pure tests cover monthly/datetime suggestions, reached/archived/pooled exclusions, negative
assignment recovery, exact cent totals, selection bounds/duplicates, safe overflow and no silent
clamp. Server tests cover current-month enforcement, exact captured amounts, insufficient money,
missing history and stale/ambiguous refusal. Real installed SQL proves atomic multi-target
assignment/activity, repeated monthly funding eligibility, preserved historical targets/ledger,
concurrent one-winner CAS and rollback on invalid/stale selection. Observe relevant guards fail
under fixture-only negative controls, then restore them.

Use synthetic data through actual installed UI/API/worker/SQL: selection, before/after review,
host cancellation/save, reload, changed second-tab rejection and explicit fresh-read recovery.
Inspect light/dark/Sage phone/tablet/desktop controls, keyboard selection and footer bounds. Run
focused/full Finance units, types, lint, format/style/file-size checks, SQL/migration regression,
complete installed browser and aggregate gates. Record exact clean commits and honest baseline
failures. Payment reserves, account-linked goals, debt payoff, target recurrence/refill modes,
automatic priorities and automatic funding remain separate parity gaps.

## Acceptance refinements from implementation

The existing ready-to-assign formula includes signed category availability. A positive
headline can coexist with an overspent category. This bounded assistant therefore requires
covering current category overspending before target funding; show that remedy instead of
claiming automatic overspending priority. Do not change existing budget math or silently
reserve, move or forgive another category's deficit. Server and native guards must agree,
with a synthetic negative-category regression.

Actual rapid sequential target creation exposed another stale-review window: successful
metadata saves close before the refreshed budget snapshot reaches the page. Disable new
target edit/funding actions until a successful read with a changed saved fingerprint lands.
Tie that wait to the form's original captured fingerprint, so a read that already arrived
cannot leave the page stuck. Failed reads retain the wait and the existing explicit records
check. Apply the same rule after funding success. Cancellation never starts that wait.
