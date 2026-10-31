# Finance initialization for a newly approved owner

Authorized Finance continuation, including necessary platform repairs. Commit/push only; no PR,
merge, deployment, real credentials, banks, production changes or live financial actions.

The installed Finance browser tests assumed a migrated owner. A new synthetic acceptance case
starts the actual platform control consumer, production reconciler and verified Finance migration
worker/runtime, then signs up and approves a new owner. It does not write a migrated marker,
account, category, currency policy or transaction directly.

The first runs failed. `061244-EYMpwc` diagnostics show Finance enabled, the owner active, no
storage-migrate job for that owner, and only the earlier completed module-enable control job.
Source confirms the approval route commits active status and returns without reconciliation.
Reactivation/deactivation already invoke the existing user-job reconciliation hook after commit.
The earlier metadata checkpoint incorrectly attributed that lifecycle hook to approval; that claim
is corrected before implementation.

Repair approval by invoking the same existing hook only after successful authorized status change.
Do not change admin authorization, pending-account validation, RLS, module/hash/actor gates,
confirmation, migration logic, background deadlines or provider behavior. Follow the existing
lifecycle contract: enqueue failure is logged by error name and does not undo an approved account.
No duplicate migration mechanism or manual completion marker is introduced.

Acceptance uses the normal approval HTTP request, real queue/control reconciliation, actual installed
migration worker, empty owned account state, manual wallet creation, reviewed USD budget setup and
a confirmed assignment above the normal routine limit. Reload must preserve the exact assignment
and opening balance. Only the migration queue gets a worker; no bank/provider worker runs. Shared
household records remain distinct from the new owner's empty ledger. Capture phone UX and run
focused plus complete installed browser suites, relevant route tests, types/lint/static and aggregate
checks. A bounded queue-lane fixture is not proof of every production worker or provider integration.
