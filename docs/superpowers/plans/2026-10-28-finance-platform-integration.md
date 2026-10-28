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
`2026-10-28-finance-parity-checkpoint.md`. Platform route, host bridge and manual ledger are
not implemented at this planning checkpoint. No safeguard is deferred to a later consumer PR.
