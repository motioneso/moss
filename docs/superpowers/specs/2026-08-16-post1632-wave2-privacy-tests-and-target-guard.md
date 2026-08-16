# Post-#1632 queue — wave 2: privacy regression tests + target-identity guard extension

**Date:** 2026-08-16
**Run:** `docs/coordination/post1632-queue-2026-08-16.md`
**Issues:** #1037, #1038, #1468
**Status:** draft, pending Ben's approval

## Context

Part of the post-#1632 backlog burn-down. #1037 and #1038 are non-blocking follow-ups from #984's
Opus QA pass: focused RLS/privacy regression tests with no production behavior change. #1468 is a
tracked fast-follow from #1383, extending the target-identity guard (`assertOperatorConfirmsTargetOwner`,
`packages/db/src/target-identity-guard.ts`) that #1383 deliberately scoped to two CLIs, to three more
operator scripts that mutate a target database from an env-derived connection string.

All three are small and bounded — same lightweight table-spec treatment as
`2026-08-08-non-feature-wave-1.md`, not individual specs. They travel together in this wave because
they're all security-tier (RLS/auth-adjacent for #1037/#1038, credential/destructive-write guard for
#1468) and none touch shared production files.

This wave travels alongside #1279 (already has its own approved spec —
`docs/superpowers/specs/2026-08-09-wave-4-external-module-supply-chain.md`, Wave-4 lane C's last
item) under the same run manifest. #1279 is not respecced here.

## Goals

- #1037: prove RLS denies actor A resuming/reading actor B's live private chat session via the
  resume path.
- #1038: prove chat privacy/history endpoints return only the requesting actor's own data across a
  two-user scenario — no list/detail endpoint leaks user B's history to user A.
- #1468: extend the target-identity guard to `scripts/rewrap-secrets.ts`,
  `scripts/module-reconcile.ts`, and `scripts/restore-database.ts`, each gated the same way as the
  two existing guarded CLIs (execute/non-dry-run path only), with matching `--confirm-owner-email`
  flag plumbing and a regression test per script proving the guard blocks a mismatched target.

## Non-goals

- No new dependency, abstraction, generic RLS-test helper, or generic guard framework.
- #1037/#1038 add tests only — no production code change unless a test proves an actual RLS/isolation
  gap (if a real gap is found, stop and escalate — that's a finding, not scope creep to fix silently).
- #1468 does not change the guard's core semantics (`packages/db/src/target-identity-guard.ts`) or
  the two already-guarded CLIs — it wires three more callers.
- #1468's `restore-database.ts` opt-out for an empty/first-time-provisioning target must be explicit
  and deliberate (a separate confirmable path), never a silent bypass of `NoBootstrapOwnerFoundError`.

## Architecture and scope

| Issue | Tier     | Intended files                                                                                                                                   | Smallest implementation                                                                                                                                                                                 |
| ----- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1037 | security | One focused chat-resume integration test (near existing #984 chat privacy tests)                                                                | Two actors, actor A attempts to resume/read actor B's live private session via the resume path; assert RLS/ownership check denies it (403/404-equivalent, no row returned).                            |
| #1038 | security | One focused two-user integration test (near existing #984 chat privacy tests)                                                                    | Two actors; call chat privacy/history list + detail endpoints as actor A; assert actor B's threads/messages never appear in any response.                                                                |
| #1468 | security | `scripts/rewrap-secrets.ts`, `scripts/module-reconcile.ts`, `scripts/restore-database.ts`; matching regression tests near the #1383 guard tests | Call `assertOperatorConfirmsTargetOwner` (or a restore-appropriate variant) before the first mutating statement on the execute path only; add `--confirm-owner-email` flag; test each script's guard blocks a mismatched target; explicit opt-out flag for `restore-database.ts` onto a bootstrap-owner-less (empty) target. |

## Exit criteria

- #1037 and #1038 each have one focused regression that fails without the RLS/isolation guarantee
  and passes with it (i.e., would fail on a codebase that leaked cross-user data).
- #1468: each of the three scripts refuses to proceed past its first mutating statement when the
  operator's confirmed owner email doesn't match the target database's actual bootstrap owner, and
  a regression test proves it per script.
- #1468: `restore-database.ts` onto an empty target requires an explicit opt-out flag, never a
  silent allow — a regression test proves the guard still fires without it.
- No lane changes AccessContext, adds a migration, or crosses an unrelated module boundary.
- Each PR carries a release-note sentence, or explicitly says the change is not user-visible (all
  three are expected to be internal-only — test/ops hardening, no user-facing surface).
- QA is green under the coordinated-build workflow (Opus adversarial pass, given security tier)
  before merge; issue and board state updated from GitHub after merge.

## Dependency and merge order

All three lanes are independent — separate test files (#1037, #1038) and separate scripts (#1468
touches only `scripts/*.ts` + its own tests). No shared production file. May build and merge in any
order; each rebases on current `main` and gets fresh QA. No serialization required between them or
against #1279 (different package: `packages/module-registry/src/external`).

## Hard invariants honored

#1037/#1038 directly enforce the private-by-default and RLS-applies-to-every-actor invariants —
that's the point of the tests. #1468 extends the credential/destructive-write target-identity guard
without touching secret encryption itself; guarded scripts still route secret access through
existing sanctioned paths. No lane touches migrations, VaultContext, or job payloads.
