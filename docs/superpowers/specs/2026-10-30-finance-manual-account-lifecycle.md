# Reviewed manual-account lifecycle

Authorized continuation of Finance parity, isolated branch only. Commit/push without merge or deploy;
synthetic tests only. This changes Moss manual-ledger metadata, never a real bank account or settings.

[Monarch hiding/closing](https://help.monarch.com/hc/en-us/articles/4407859794580-Hiding-an-Account)
and [YNAB closing/reopening](https://support.ynab.com/en_us/how-to-close-or-delete-an-account-in-ynab-ry_409Gko),
read October 30, describe preserving account history while closing and reopening accounts. Moss has
manual account creation, immutable opening baselines and an archived marker, but no native management.
Implement a safe bounded lifecycle; deletion and provider-account edits remain separate gaps.

## Contract and correctness

Add an own-only SQL review capability with current name, type/currency/opening fields, balance,
archive/statement state, latest entry date, close blockers and an opaque account-row revision from
the same statement. Expose no notes, provider credentials or shared-owner edit authority. A new
always-confirm write tool accepts account ID, captured revision, rename/close/reopen operation, and
only a rename's bounded new name. Host authorization and confirmation remain mandatory.

One SQL statement locks the reviewed manual account and rechecks its revision, then changes only
name/status/version plus metadata-only activity. Preserve amounts, currency, opening balance/date,
transactions, statements and the balance observation timestamp. Rename is allowed on active or
closed manual accounts. Reopen resumes entry while keeping reconciled periods locked. Do not
silently retry stale or ambiguous writes; keep drafts and require a fresh review of the saved state.

Close requires both stored and reconstructed balances to be exactly zero, valid original ledger
source/currency/opening dates, no future entries, and a statement reconciled through owner-local
today. A pristine zero opening baseline with no entries can close without a fake statement. No
financial adjustment or deletion is created. Reject active future bill-plan references rather than
silently invalidating them. Read and write use the owner's date, never a caller-provided today.

Keep bill creation and closure serial: bill creation locks the active account before policy eligibility
and advances a manual account's version when a plan is attached. A closer waiting on that account
then detects the new version even if its initial statement snapshot missed the plan. Do not rely on
a foreign-key key-share lock to protect a non-key archive change. Preserve all-or-none plan creation.
Allow stopping an already ending plan sooner, preserving recorded occurrence decisions and the
existing inclusive end-date semantics; label future stops accurately and show the linked account.

## Interface and acceptance

Add one Manage action to active manual accounts, with native details, rename and closing review.
Show closed accounts in an accessible disclosure with Manage/reopen and history access. Hide new
entry/import/reconcile actions for closed accounts. All history remains in Reports, Transactions and
owned CSV export; historical net-worth funding is preserved. Show actionable close blockers and
links to reconciliation and Upcoming. Balances keep their actual observation date after renaming.
Use Park Pass typography, semantic colors, quiet rows and responsive dialogs, not new raw styling.

History links may initialize validated account/month register filters; reject invalid URL values and
preserve existing normal navigation/filter behavior. Capture the review/draft through host cancellation.
Read/loading/error/unsupported/stale states must have clear actions and must not show an unverified
fallback as saved. Provider and shared accounts never acquire manual edit controls.

Verify ownership/provider refusal, names, stale/replay behavior, immutable financial fields/time,
zero/reconciled/pristine rules, corrupted/future ledger refusal, bill dependencies, reopen protections,
closed history/export visibility, and deterministic entry/plan/close conflicts. Negative controls must
fail without owner, version or confirmation guards. Installed desktop/phone/light/dark/Sage flows
must cancel and save rename, show blocked closure, close/reopen a valid zero ledger, retain history,
exercise stale recovery and follow the history link. Run focused, SQL, browser, static and aggregate
checks; distinguish passed/failed/unrun and keep the matrix partial outside these declared boundaries.
