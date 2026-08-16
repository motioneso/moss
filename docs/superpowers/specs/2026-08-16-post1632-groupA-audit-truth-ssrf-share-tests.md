# Post-#1632 queue — group A: audit-outcome truth, host-fetch SSRF hardening, manage-share write tests

**Date:** 2026-08-16
**Run:** `docs/coordination/post1632-queue-2026-08-16.md`
**Issues:** #1252, #946, #1490
**Status:** DRAFT — awaiting Ben's approval (drafted by Fable 5 under the 2026-08-16 overnight
delegation; Coordinator take-25 to present)

## Context

Three small security-tier items, all with the root cause already diagnosed in the issue body —
same lightweight table-spec treatment as `2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md`.

- #1252 (bug, sev:major): the gateway audit log derives `outcome` purely from the envelope
  (`result.ok ? "success" : "failed"` at `packages/ai/src/gateway/gateway.ts:193`, also 212, 564).
  External modules have no error channel, so a module that handles its own failure and returns
  `{ status: "error", ... }` is audited as `success`. Found during #1234 UAT; the audit log is the
  primary "did this actually work?" evidence source, so lying here undercuts its whole purpose.
  An older, unapproved draft (`2026-07-25-1251-1252-tool-failure-visibility.md`, branch
  `spec/host-findings-1250-1255`) coupled this to #1251 (since closed) and proposed a full
  protocol-level error channel; per the issue's 2026-08-16 comment this is deliberately re-scoped
  smaller here — audit truth only, no protocol change.
- #946 (task): follow-up hardening from #915 / PR #945 security QA. Six test-coverage gaps on
  SSRF-boundary logic already verified present and correct, plus one defence-in-depth BlockList
  entry (`::ffff:0:0/96` IPv4-mapped-IPv6 parity).
- #1490 (task, security): follow-up from PR #1483 (#1055) QA + Fable sign-off. The #1055 fix
  structurally closed cross-owner UPDATE branches reachable via a `manage`-level share; nothing
  asserts it stays closed. Tracked per Fable's post-merge condition on #1483.

## Goals

- #1252: an external-module tool call that self-reports failure is audited `outcome = failed`,
  never `success`.
- #946: the native host-fetch SSRF boundary is locked in by tests (and one parity BlockList entry)
  so a future refactor cannot silently regress it.
- #1490: the manage-share cross-owner write path (suggested-metadata resurface,
  archived→suggested, idempotency probe) is pinned closed by regression tests, including the
  worker-role path.

## Non-goals

- #1252 does **not** add a module→gateway error protocol, change the result envelope the model
  sees, change `result.ok` semantics, or touch the module SDK contract. The full error-channel
  design (the old draft spec's scope) stays open under #1252's "suggested direction" for a future
  milestone if audit truth alone proves insufficient. It also does not attempt semantic detection
  of failure inside arbitrary payloads — only a small, documented, closed set of conventional
  error shapes.
- #946 adds no new dependency and does not restructure `host-fetch`; the six items are tests plus
  one `BLOCKED.addSubnet` line. No behavior change on any currently-reachable path.
- #1490 is tests-only — no production code change. If a test finds the path is NOT closed (a real
  cross-owner write reproduces), stop and escalate; that's a security finding, not scope to fix
  silently.

## Architecture and scope

| Issue | Tier     | Intended files                                                                                                   | Smallest implementation                                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | -------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1252 | security | `packages/ai/src/gateway/gateway.ts` (audit-outcome assignment at the 3 cited sites) + unit tests                | At the audit-write choke point, when the handler returned (`ok: true`) and the tool is external, inspect the returned payload's top level against a small closed set of conventional error shapes (e.g. `{ status: "error" }`, `{ ok: false }`, `{ error: <string> }` — exact set is the build plan's to pin, documented in code). Match → audit `outcome = "failed"` with a distinct `error_class` (e.g. `module_reported`). The envelope returned to the model is byte-identical to today. |
| #946  | security | `packages/host-fetch/src/policy.ts` (+1 line), unit tests for `packages/host-fetch/src/index.ts` + `policy.ts` | Add `BLOCKED.addSubnet("::ffff:0:0", 96, "ipv6")`; add the six tests enumerated in the issue verbatim (hex-form v4-mapped literal, non-443 port, userinfo-in-URL, streaming size cap, cross-origin redirect header wipe incl. same-host different-port, redirect-to-blocked re-validation).                                                                                                              |
| #1490 | security | Regression tests near the existing #1055/#1483 tasks tests (integration)                                        | The 3 assertions in the issue verbatim: (1) `manage`-level share cannot cross-owner-UPDATE `suggestion_metadata`/status via the probe path; (2) owner A's row is byte-untouched after owner B's `create()`; (3) worker-role (`jarvis_worker_runtime`) coverage of the probe path reached from `packages/connectors/src/monitor-jobs.ts:255-266` and `packages/module-registry/src/index.ts:734-742`, incl. the fail-closed unset-GUC case. |

## Exit criteria

- #1252: a regression test drives an external tool whose handler returns a conventional
  error-shape payload and asserts the audit row records `failed` (+ the new `error_class`); a
  control test asserts a normal success payload still audits `success`, and a first-party
  (non-external) tool's behavior is unchanged. The model-visible envelope is asserted unchanged.
- #946: all six tests green and each fails when its guard is knocked out (spot-verify at least
  the BlockList entry and the redirect re-validation by scratch mutation, per test-truthfulness
  discipline); no reachable-path behavior change.
- #1490: tests fail on a codebase where the #1055 fix is reverted (verify by scratch-reverting
  the owner-scoped probe, then restoring) and pass on `main`.
- No lane changes AccessContext, adds a migration, or crosses a module boundary.
- Each PR carries a release-note sentence or states it is not user-visible (#946/#1490 are
  internal-only; #1252's only user-visible effect is truthful audit rows).
- Security tier: Opus adversarial QA + explicit human sign-off (Ben or Fable 5 per the standing
  overnight delegation) before merge; issue + board updated after merge.

## Dependency and merge order

All three lanes are independent — different packages (`packages/ai/src/gateway`,
`packages/host-fetch`, tasks tests), no shared production file. Any order; each rebases on current
`main` and gets fresh QA. Note for #1252: PR #1645 (#1279) touches the same gateway package (input
validation, not the audit sites) — rebase over it after it merges; no semantic overlap.

## Hard invariants honored

#1252 strengthens audit truthfulness without touching the secrets boundary — the sanitized
model-visible envelope is unchanged, and no handler internals are added to any log by this spec.
#946 strengthens the SSRF blocklist (secrets-never-escape adjacent). #1490 directly enforces
private-by-default / RLS-applies-to-every-actor on the share path. No migrations, no VaultContext,
no job-payload changes, no provider names.
