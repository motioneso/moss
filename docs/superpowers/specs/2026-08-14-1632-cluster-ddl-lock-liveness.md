# #1632 — cluster DDL lock session liveness

**Status:** Proposed follow-up to #1013; design only. No implementation or proof is authorized by
this document.

## Why the previous closure stopped

The #1013 helper acquires a session-level advisory lock on the maintenance database, then runs
the protected callback through one or more other PostgreSQL sessions. That is safe only while the
lock-owning backend remains alive. If that backend disconnects, PostgreSQL releases the advisory
lock while the callback's DDL session can continue. The callback then has no reliable evidence that
it is still serialized. The final P1-prime proof at `8bc7cd112` produced a participant-only
`XX000` (`tuple concurrently updated`) during a locked run, so the kill gate correctly froze the
line. The existing post-acquire identity query and attribution diagnostics do not repair this
ownership/lifetime gap.

The prior proof also showed that an external unlocked writer can be captured and classified, but
that does not establish safety when a nominal participant loses its lock session. This issue must
not claim that the original failure has a confirmed single cause; it defines the missing safety
property and the evidence needed to proceed.

## Goal and non-goals

Make cluster-global role/catalog DDL fail closed if the lock owner is no longer valid for the
entire protected callback. Preserve the current narrow lock scope, maintenance-database targeting,
per-lane database isolation, and crash-release behavior.

Out of scope: changing role SQL, broadening the set of DDL sites, retrying PostgreSQL `XX000`,
weakening attribution, serializing whole gates, or adding a distributed service/dependency.

## Required contract

1. **One authoritative owner.** The lock session and the session(s) executing protected DDL must
   have an explicit, testable ownership relationship. A lock acquired on one backend must not be
   treated as sufficient after that backend has disconnected.
2. **Continuous liveness.** While `fn` is running, the helper must detect lock-session loss before
   allowing another protected DDL phase to be reported successful. The detection bound must be
   explicit and configurable only within a documented safe range; the default must be short
   enough to prevent a second lane from entering during an undetected callback window.
3. **Fail closed.** If ownership cannot be proven (connect, identity, heartbeat, callback, or
   cleanup failure), protected work must not start or must fail with a typed lock error. Never
   continue unlocked and never silently convert an ownership failure into a diagnostic-only event.
4. **No false release.** A stale/old owner cannot unlock or supersede a newer owner. Cleanup must
   be idempotent and must not release a lock acquired by another invocation.
5. **Crash safety.** Process termination, backend termination, network loss, and database restart
   must eventually release ownership without stale artifacts or manual deletion. A killed owner
   must not leave a waiter permanently blocked, and a waiter must never steal a live owner.
6. **Correct phase coverage.** Bootstrap, role-password, module-role, teardown, purge, and
   membership grant/revoke paths remain covered by the same primitive. No caller may bypass the
   liveness contract by using the old helper directly.

## Design constraints

- Prefer PostgreSQL-native primitives already available in the repository. Do not introduce a new
  lock daemon, dependency, lock file, or broad abstraction without a new design review.
- Keep the DDL transaction/session relationship explicit. If the implementation uses a dedicated
  owner session plus DDL sessions, a heartbeat/lease-loss path and its race semantics must be
  specified and tested. If it changes to one owner session for DDL, prove that all wrapped sites
  can use it without changing role/password or module behavior.
- Do not catch or suppress lock-session errors. Diagnostic sinks remain observational only after
  ownership is known; a sink failure must not cause protected work to run unlocked.
- Preserve the current maintenance DB override and URL query parameters. Never create/drop or
  migrate a shared database as part of lock management.

## Acceptance checklist

### Unit and integration behavior

- [ ] Two independent databases cannot enter the same cluster lock concurrently.
- [ ] Protected callback is never invoked when acquisition, identity, or ownership validation
      fails.
- [ ] Owner backend termination during an idle callback is detected within the documented bound;
      the callback fails and a new waiter can acquire only after the old owner is gone.
- [ ] Owner backend termination while DDL is executing cannot yield a successful protected phase;
      the result is a typed liveness/lock error and cleanup is deterministic.
- [ ] Network/session loss and PostgreSQL restart are treated like owner loss, not as a successful
      unlock or an unlocked continuation.
- [ ] A live owner is never stolen; malformed, ambiguous, or unverified ownership fails closed.
- [ ] Callback rejection, synchronous throw, heartbeat failure, and cleanup failure preserve all
      relevant errors (including an `AggregateError` where two failures occur).
- [ ] Normal release, owner crash, and waiter timeout leave no lock residue and permit a later
      acquisition.
- [ ] Existing diagnostics cannot alter acquisition, liveness, callback, or cleanup semantics.

### Coverage and source guards

- [ ] Source assertion proves every approved cluster-global DDL site routes through the liveness-
      aware helper and no old lock-free path remains.
- [ ] Source assertion proves wrapped sections are sequential siblings, not nested acquisitions.
- [ ] The helper documents its non-reentrancy and ownership/liveness contract at the exported seam.

### Proof gate (fresh exact head only)

- [ ] Focused unit/static/type checks are green.
- [ ] A solo locked proof of at least 30 iterations is green with persisted owner-liveness traces.
- [ ] A controlled owner-loss proof is green, including an owner killed during protected work and
      follower acquisition after backend death.
- [ ] Two fresh detached worktrees run the full gate concurrently with zero participant-vs-
      participant `XX000`, zero unattributable errors, and no lock-session-loss success.
- [ ] Any participant-vs-participant collision, unattributable error, bypass of the liveness
      contract, or diff outside this spec's bound is an immediate kill-gate stop; no retry cycle.

## Evidence required before reopening #1013

Post one durable report containing the exact source head, design choice, typed failure semantics,
all focused results, owner-loss traces, full-gate logs, cleanup counts, and exact changed-file
scope. The report must explicitly distinguish:

- owner-session loss,
- an external unlocked writer, and
- a participant-vs-participant collision.

Until that report is green and independently reviewed, PR #1624 remains frozen and no production
or full-gate claim is reopened.

