# Confirm captured transaction reviews atomically

Continuation of the authorized Finance parity roadmap, task branch only. Commit and push reviewed
work without merge or deployment; synthetic fixtures only. Record this design before implementation.

The register's Confirm all action currently queues batches and optimistically hides rows before
persistence. A concurrent correction can be overwritten by a stale full-record write, and later
failure is separate from the apparent confirmation. Close this specific correctness gap using the
existing reviewed host-tool contract and SQL transaction revision tokens. Single-row category/rule
writes remain a separate legacy gap; this slice does not silently change their policy or functionality.

A read-only feed advertises support when the installed SQL store implements atomic confirmation.
Review up to 200 loaded own posted unsplit rows marked needs-look with a live nonempty category.
Capture row IDs and revisions; show count, payee, date, category, amount and currency in a scroll-body
review dialog. If more rows qualify, say how many are in this batch and how many remain. No hidden
rows, split/pending/shared records or merchant rules enter this action. Old stores retain their existing
legacy queue path; do not claim it has the new concurrency behavior.

A new always-confirm write tool validates one to 200 unique reviewed references. One SQL statement
locks rows in stable ID order, rechecks all revision tokens, current review states and live categories,
then changes review/provenance metadata plus metadata-only activity for all rows or none. Preserve
amounts, dates, account, currency, notes, splits, clearing, reconciliation and balances. There is no
category or rule change and therefore no category undo to fabricate. RLS remains the owner boundary.

Await persisted success before hiding rows or claiming confirmation. Host cancellation keeps the
captured review open. Stale, failed or ambiguous outcomes preserve the captured choices and require
an explicit fresh register check before another submission. Do not silently retry writes. Always keep
host confirmation/authorization; do not substitute a local confirmation or weaken the platform guard.

Acceptance: exact persistence and activity count, safe replay/stale rejection, a changed later row
aborting an entire batch under a deterministic competing lock, missing/archived/null categories,
pending/split/foreign-owner refusal, and preservation of all financial and statement fields. Negative
controls must fail when the row lock, owner RLS or host confirmation guard is removed. Installed
browser checks cancel/confirm/stale/reload, bounded scope and keyboard/phone/desktop/light/dark.
Update app map and matrix honestly; run focused, installed, static and aggregate checks with exact
receipts. No migrations, new credentials, live banks, financial transfers or provider actions.
