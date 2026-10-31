# Finance initialization after onboarding

Authorized continuation of the Finance parity task, with necessary platform repairs. Commit and
branch push only; no PR publication, merge, deployment, real credentials or live financial actions.

The approved-user startup fix covers an explicit approval event. When an administrator permits
registration without approval, new users become active without that event. Prove their normal
onboarding-completion path separately; do not infer it from the approved-user case.

Extend the synthetic installed startup acceptance to an immediately active owner who completes
onboarding. Configure registration through the actual administrator API and restore that setting
in the fixture. No financial record, currency, category or migrated marker is seeded. Drain the
fixture's earlier control/migration work before creating this owner, so an unrelated old reconcile
cannot accidentally initialize them and conceal the missing lifecycle event.

If the test confirms missing initialization, schedule the existing user-module reconciliation
after the onboarding state transaction commits. Complete and Skip share the same handler; preserve
their owner/member authorization and existing response. Use the existing composition-root hook,
not a second migration mechanism or an authentication-library callback. Queue failure must remain
a logged best-effort side effect, never undo completed onboarding or expose private content.

Keep all module/hash/active-user/RLS and confirmation checks. Only the migration lane runs in the
fixture; no bank or provider workers run. Prove actual queue delivery and installed migration,
empty owned accounts, manual cash creation, reviewed currency, confirmed allocation and reload.
Run onboarding and approval/module route regressions, focused units, lint/types/static, complete
installed browser acceptance and the final frozen aggregate. Update the parity matrix with the
exact proven signup modes; source claims about additional paths remain bounded by their evidence.

The clean approved-user run `062524-QTRADu` also exposed a reconciliation burst: the owner had six
created migration jobs behind earlier fixture work. The installed pg-boss 12.18.2 implementation
only computes `singleton_on` when `singletonSeconds` is supplied; a key alone on a standard queue
has no time-window uniqueness. Add a bounded thirty-second coalescing window per actor/job/package.
The package hash must distinguish an updated artifact immediately. This is best effort per database
time bucket, not a global exactly-once promise; handlers retain their replay markers and retries.
Prove actual same-bucket queue insertion and package changes against PostgreSQL, using the supported
send database adapter in one real transaction so a clock-boundary crossing cannot make the test flaky.
Do not alter existing queue policies, runtime deadlines, migration markers or authorization.

The complete nineteen-flow fixture starts its migration workers only inside startup acceptance.
Running startup after every seeded scenario accumulates lifecycle control requests while no worker
is running, unlike the deployed worker lifecycle. Run the independent fresh-owner cases first,
still after real installation and before creating each new owner. Retain the existing idle barrier,
new-owner post-commit receipt, real empty-ledger assertions and unchanged time bounds. Do not delete
old jobs, seed migration completion or turn a failed startup into a skip. This does not establish
latency under arbitrary production backlogs or make full-module reconciliation targeted per user.
