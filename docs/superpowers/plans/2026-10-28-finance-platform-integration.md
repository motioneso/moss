# Finance platform continuation

Date: 2026-10-28. Local branch: `task/finance-parity-20261028`. Paths are relative to
`~/Jarv1s`. Ben authorized the platform changes required for Finance to work end to end.
No publication, merge, deployment, production data change or live bank use is authorized.

## Existing design and ownership

Use the approved decisions in
`docs/superpowers/specs/2026-10-25-module-page-write-tools-design.md` and
`docs/superpowers/plans/2026-10-25-module-page-write-tools.md`, with implementation tasks
[#3723](https://github.com/motioneso/moss/issues/3723) and
[#3724](https://github.com/motioneso/moss/issues/3724). GitHub inspection on October 28 found
both issues open and unassigned, and no open PR matching either issue or the route title.
[PR #3733](https://github.com/motioneso/moss/pull/3733) is merged and supplies only the
confirmation persistence foundation. Recheck before editing any overlapping continuation.
The old draft heading does not undo Ben's recorded approvals. The current expanded brief
authorizes this continuation on the isolated Finance branch rather than the older named branch.

## Reviewable slices

1. **Guarded route.** Add the external-only module-scoped synchronous route and app-map entries.
   Reuse input validation, sanitization, output bounds, external worker invocation and public
   AI confirmation functions. Admit only active actor modules with matching tool ownership;
   require trusted Origin and the separate session/module limiter. Validate before classifying.
   Canonical validated input binds single-use confirmation. Commit consumption before execution;
   a failure must not restore approval. Direct and confirmed writes use existing activity outcome
   conventions, with metadata only. No job contains financial text. Add chat self-authority and
   platform route guards in the same commit. Preserve the old read route and queue behavior.
2. **Host bridge.** Add the optional browser-safe SDK handle and wire the actual external-module
   shell. The host binds module ID, validates response records, owns confirmation copy and focus,
   cancels through the existing action endpoint, and awaits one deterministic outcome. Retain the
   same input for a confirmation retry. No automatic retry after ambiguous transport failure.
   Missing support on an older host fails closed. Handle concurrent dialogs, unmount and session
   change without applying an approval to another operation.
3. **Finance consumer.** Introduce the manual account/ledger schema and public tools on this
   bridge, with owner RLS and explicit opening balance, currency, source and archival semantics.
   Preserve provider snapshots and IDs. Validate all input before one atomic commit. Then add
   CSV preview/apply and reconciliation, without substituting snapshot equality for a ledger.
4. **Assembled proof.** Use a throwaway development database and synthetic records through the
   actual signed-in host, installed Finance module, API, worker and RLS role. Assert direct save,
   host confirm/cancel, persisted results, owner isolation and activity. A disclosed stand-in is
   permitted only for an external service/recipient; intercepted application responses are not
   live proof. Keep fixture screenshots explicitly labeled until this passes.

## Required verification

- Route T1–T13 from the existing spec, including changed input, expiry, cancellation, replay/race,
  cross-user/chat IDs, inactive module, forced actor, Origin and safe module rejection codes.
- Observe destructive and module-owner guards failing when each guard is independently removed,
  then restore and rerun. Keep mutations local and out of commits. Follow confirmed-row recovery
  consumers before activating the route.
- Wire-level host tests for confirm/cancel, malformed/expired/rate-limited responses, concurrent
  operations and session/unmount changes. Prefer the actual shell over testing only helpers.
- Every database test runs through `scripts/run-gate.sh`; no direct test/migration command.
  Run focused unit and integration suites, lint, formatting, typechecks, app-map checks and full
  foundation checks. Distinguish known sandbox failures from new defects and unrun later phases.
- Record exact commits/inputs, exit codes and cleanup. No green local result substitutes for CI,
  independent review or installed live acceptance. Keep all commits local until publication is
  separately authorized.

## Checkpoint

The five Finance slices and their validation are recorded in
`2026-10-28-finance-parity-checkpoint.md`. The guarded route is implemented on the isolated
branch, rebased onto main `66f8e4ef`. The optional host bridge and manual ledger remain next.

Route verification on October 28 (Node 24.19.0, pnpm 10.6.2, throwaway PostgreSQL 17.11):

- Five focused unit files, 24 tests passed, including real route-catalog refusal and the
  preference-context argument. Two initial harness typing/coverage mistakes were corrected.
- Gate `test:integration:module-page-writes`: five files, 46 tests passed. Final restored run
  `moss_finance-20261028-071438.log`, input fingerprint `529d808d6d8a`, exit 0; container removed.
  This is real confirmation/audit storage with explicit auth/tool stand-ins, not installed UI proof.
- Negative control 1 removed only the destructive risk guard. Run
  `moss_finance-20261028-071237.log`, fingerprint `ac30a9465105`, exit 1: destructive request
  returned 200 instead of 409. The outbound guard remained. Five dependent assertions failed.
- Negative control 2 restored risk handling and removed only the module owner comparison.
  Run `moss_finance-20261028-071341.log`, fingerprint `08eb1d017bb3`, exit 1: module A invoked
  module B's tool (200 instead of 404). Both protections were restored before the green run.
- The first aggregate static run stopped at two newly merged heartbeat mockup lint errors
  (duplicate URLSearchParams global and undeclared location). A separate local fix uses
  window.location and removes the redundant declaration. Aggregate verification must rerun.
- Approval consumption commits before execution; a failed worker cannot roll it back and revive
  the approval. Worker mutations and the platform activity record are separate transactions:
  a failed response can follow a completed write, so the host must not automatically retry.
- Existing confirmed-row consumers were traced: recovery handles pending/timeouts, does not
  execute confirmed rows, and emits chat outcomes only with chat bindings. The unchanged REST
  approval path cannot replay a page row. Cancellation remains available through its owner route.

Migration 0342 adds module-page activity attribution; no applied migration changed. Existing
confirmation migration 0334 and public AI APIs are reused. Synchronous module preferences reuse
an already-open actor context to avoid acquiring a second connection from a one-slot pool.
No bank service, production database, publication or deployment was used.
