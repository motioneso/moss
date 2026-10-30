# Finance initialization checkpoint — October 30

Branch `task/finance-parity-20261028`; commit/push authorized, no PR publication, merge, deployment,
real credentials, bank connection, production writes or live financial actions. Synthetic data only.

See the [parity matrix](../specs/2026-10-28-finance-parity.md),
[metadata checkpoint](2026-10-30-finance-metadata-checkpoint.md), and designs for
[open registration](../specs/2026-10-30-finance-open-registration-startup.md) and
[gate storage recovery](../specs/2026-10-30-finance-test-runtime-recovery.md).

## Implemented boundary

Approval initializes module jobs after the authorized account-state transaction commits. Completed
or skipped onboarding now also requests the existing reconciliation hook after its owned state
commits, covering initially active registration. Queue failure remains a logged best-effort side
effect and does not undo onboarding. No new migration mechanism or fake completion marker exists.

Repeated lifecycle requests use actual pg-boss thirty-second database buckets per actor/job/package;
a package update gets a distinct key immediately. A singleton key alone did not coalesce standard
queue inserts. This is bounded best effort, not exactly once or targeted per-user fan-out. Handler
replay markers, active-owner checks, package validation, RLS and confirmation remain unchanged.

Installed startup acceptance starts only the real migration lane and control consumer, exercises
actual signup, approval or initially active registration, onboarding, installed worker migration,
empty owned ledger, manual wallet creation, reviewed USD setup, confirmed assignment and reload.
No bank worker runs. Fresh-owner cases now precede seeded scenarios, avoiding a fixture backlog
accumulated while its migration workers are deliberately stopped. Existing idle/new-owner receipt
bounds remain; production backlog latency is not established by this fixture.

## Verification and exact limits

- Finance/onboarding/gate-focused units: 71 files / 700 passed. Additional reconciliation/timezone
  regressions: two files / 17 passed; API job routes: one file / two passed. Scoped lint, root-test
  types, formatting and manifest sixteen-case tests passed.
- Real coalescing SQL: old-code `063614-yfCeLv`, input `55a2d593b427`, failed because two inserts
  persisted instead of one. Restored `063744-IBxyQ3`, input `8423850aa521`, passed one case, including
  immediate changed-package admission. Real PostgreSQL/pg-boss used its supported transaction adapter
  to pin database time; enabled-user/discovery configuration is explicitly synthetic.
- Missing onboarding event: `064011-OvsKsb`, input `fc563a15d439`, failed with Finance enabled and the
  owner active but no migration job. Restored two-mode `064652-Qqi8nn`, input `0dd94dfd4ba8`, passed
  two / seventeen skipped. Actual migration receipt and native wallet/budget/reload were required.
- Expanded auth/settings/module/onboarding regression: initial `065416-KwMeJJ` passed sixty / failed
  one synthetic provider check. Its chat-home default was inaccessible in this environment. Supplying
  the existing `JARVIS_CHAT_HOME` configuration with a writable synthetic directory made restored
  `065629-CNZ0yb` pass all 61 across three files. Input `0336d929bdc0`, base `50ac564f` dirty. No
  provider guard was changed and no real provider credential was used.
- Complete installed browser `065415-FYApN0`, same input, passed eighteen / failed one at the old-work
  idle barrier before creating the approved owner. Focused two-mode acceptance had passed; the full
  fixture had accumulated lifecycle requests with its worker stopped. Cases were moved first without
  deleting jobs, changing time bounds, bypassing migration or skipping assertions. Restored complete
  run `065921-yLLNaM`, input `a9f930dc3fc9`, base `fb7e1d34` dirty, passed all nineteen, exit 0.
  Runtime/test source remained unchanged during that run; later documentation commits are separate.
- Earlier clean `6bd6caeb`, input `41f4af0b0117`: auth/module 47 passed (`062526-plArv6`); full browser
  eighteen-case `062524-QTRADu` passed seventeen / failed startup with queued duplicate migration work.
  Do not substitute the earlier dirty eighteen-pass receipt for this failed clean run.
- Clean `6bd6caeb` foundation `063138-Zydnm2` finished exit 1: all static checks passed; 1,619 files /
  19,566 tests passed, 21 files / 277 tests failed, three skipped. Normalized failure identifiers exactly
  match the earlier clean `3c620d58` baseline: added zero, removed zero. Computer trust/native/session,
  Sports browser setup and unmapped UID ACL prerequisites remain. Later aggregate DB stages were
  unrun after unit failure. This is not an overall gate pass; new initialization needs a frozen gate.

Disposable PostgreSQL volumes filled disk before `063322-URngTS` could execute any test. Four wrapper
cleanup paths now use Docker's supported associated-anonymous-volume removal. Ten event-proven,
unreferenced anonymous volumes belonging to completed Finance gates were individually removed;
no global prune or unknown/named/in-use deletion occurred. One subsequently completed old-wrapper
aggregate volume was independently checked and removed. A new-wrapper SQL gate's observed anonymous
volume was absent after exit; the persistent named database volume remained. Thirty-five wrapper
unit tests passed. Failed launch/script-selection/cancelled setup runs are not test passes.

Screenshots `finance-fresh-startup-390.png` and the earlier individual-review/transfer light/dark/Sage
sets remain outside the repository. Synthetic browser proof is distinct from CI e2e and production.

## Continue after preservation

1. Record the restored full nineteen-case verdict, commit/push this bounded checkpoint, and run a
   frozen combined-source aggregate with documented toolchain/browser/writable runtime directories.
2. Implement [awaited individual confirmation](../specs/2026-10-30-finance-individual-confirmation.md),
   using existing guarded metadata tools; prove cancellation, stale financial conflict, reload and
   actual desktop/phone/theme inspection.
3. Continue canonical merchant-rule list/edit/disable/preview. Rule-plus-category legacy writes remain
   separate; credit-card reserves, broader goals, existing-entry transfer matching, household co-editing,
   provider pending-ID convergence and investment holdings remain partial or missing as the matrix says.
   No blanket parity or live bank/provider coverage is claimed.

Initialization implementation was committed and pushed as `61052249ffa904d5f92128363a3c7be4ec6571ce`.
The separate frozen checkout is clean at that commit. Its full foundation run `070254-PFAraS` is
running, with Chromium, writable XDG/tool caches and the supported synthetic chat-home configuration.
The main task branch continues the next reviewed individual-confirmation slice independently.
