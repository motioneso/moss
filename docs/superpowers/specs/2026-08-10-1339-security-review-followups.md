# Security-review follow-ups from PR #1338

**Date:** 2026-08-10

**Status:** Approved by Ben's Fable delegate on 2026-08-10

**Roll-up issue:** #1339

**Source:** five non-blocking findings from the independent adversarial review of PR #1338

**Approved spec grounded on:** `origin/main` = `996a782a1`, issue #1339, issue #1246, open PR #1492,
and `docs/coordination/2026-08-10-follow-up-wave-decomposition.md`

## Decision summary

#1339 remains an open roll-up and receives no implementation PR. After the release gates below,
file two unconditional one-session children:

1. **1339-A — composed dispatch/self-heal proof:** one DB-backed integration test crosses the real
   `AssistantToolGateway.callTool` → production chat action-policy → tasks compatibility heal seam.
2. **1339-C — closed heal fallback:** one tasks-owned change makes an install-grant insertion
   failure resolve to `ask_each_time` rather than escaping as a policy-resolution 500.

Fable's binding ruling as Ben's delegate is to preserve the external `selfOperationGrant` /
`actionFamilyId` ABI. Finding 2 is superseded by the positive validation and compatibility evidence
on current `main`; do not file 1339-B. Silent stripping remains ruled out because an accepted
manifest must not silently run with different approval semantics. Any #1246 change on `main` to
either field requires a fresh Fable/Ben ruling before a #1339 child starts or the parent closes.

Finding 4, GET self-heal having an idempotent actor-scoped write side effect, remains a recorded
trade-off. It gets no child, no telemetry, no feature flag, and no speculative refactor.

## Current-state grounding

The codebase graph found the full production path:

```text
AssistantToolGateway.callTool
  → resolvePolicy
  → buildChatGatewayDependencies().actionPolicy.getFamilyTier
  → TasksCompatibilityHelper.getResolvedTaskChangesPolicy
  → healInstallGrantAndReread
  → grantInstallTimeTrustIfUnset
```

It also found the external manifest choke point:

```text
validateExternalModuleManifest
  → validateAssistantToolPolicy
  → createExternalToolManifests
  → AssistantToolGateway.callTool
```

The review finding and current `origin/main` no longer describe the same external ABI. The finding
was correct at PR #1338's reviewed head, but later #1246/job-search work intentionally promoted the
fields into the external contract.

| Finding                 | Current behavior at the draft baseline                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 / composed seam       | `tests/integration/mcp-gateway-self-operation.test.ts` drives real `callTool` only after manually seeding a grant and uses a test-local policy lookup. `tests/integration/chat-action-policy-self-heal.test.ts` uses production `buildChatGatewayDependencies` against a real DB, but calls `getFamilyTier` directly. No test joins the two halves.                          |
| 2 / external fields     | `ExternalModuleAssistantToolDeclaration` explicitly types `actionFamilyId` and `selfOperationGrant`; `validateAssistantToolPolicy` positively validates them and their family/tier relationships; `createExternalToolManifests` deliberately passes them through; the shipped Job Search external manifest declares them on ten write tools; focused tests pin preservation. |
| 3 / availability        | `TasksCompatibilityHelper.healInstallGrantAndReread` awaits the insert with no fallback. Its generic sibling returns closed on a rejected grant attempt.                                                                                                                                                                                                                     |
| 4 / GET side effect     | First read can insert one canonical, actor-owned preference. This is deliberate, idempotent, declaration-bounded behavior and remains unchanged.                                                                                                                                                                                                                             |
| 5 / real manifest proof | Boot assertions pin built-in declarations, but the dispatch and heal halves use synthetic or manually seeded fixtures. The new composed test uses the real tasks manifest.                                                                                                                                                                                                   |

## Release gates and ordering

No #1339 build child starts until all of these are true:

- **#1246 is resolved on live GitHub and its final permission/self-operation contract is on
  `main`.** The builder re-reads that resolution before assuming the tasks compatibility seam or
  external ABI.
- **PR #1492 is merged.** It changes external tool manifest types/wiring and gateway summary code;
  planning against its pre-merge shape would create avoidable collisions.
- **Wave 4 lane C is complete through W4-C3 (#1274 → #1275 → #1279).** Those children serialize
  ownership of `packages/module-registry/src/external/validate.ts`, external tool wiring, and the
  installed-external-tool gateway test.
- Immediately before 1339-A dispatch, confirm the gateway's action-flow record contract still
  emits only `action_request` and `action_result`. If another required action-flow record kind has
  landed, the Coordinator re-slices A instead of weakening its exact emitted-record assertion.
- The Coordinator refreshes Project 2 and open PR file lists immediately before dispatch. A live
  tasks, module-registry, or chat-gateway collision keeps the affected child queued.

After the gates, the mandatory local order is:

```text
1339-A → 1339-C
```

A lands before C so the unchanged composed behavior is pinned before the fallback branch changes.
Each child gets its own GitHub `task` sub-issue, branch, PR, focused checks, and fresh implementation
session. If its locked surface is no longer sufficient after the release gates, stop before code
and re-slice.

## Shared scope and security rules

- Both implementation children are **security tier** because A and C touch the approval decision
  path. Each requires independent adversarial QA and Ben/Fable merge sign-off under the
  then-current security process.
- Keep the fail direction closed: missing policy, missing family, missing preferences, or failed
  healing resolves to confirmation, never auto-run.
- Stored user choice remains authoritative. No child may overwrite either canonical or legacy
  revocation state.
- The canonical tasks preference remains owner-only under existing RLS. The DB proof includes a
  second-actor negative control; admin status grants no private-data visibility.
- Add no dependency, migration, public endpoint, feature flag, retry loop, logger abstraction, or
  new policy tier.
- These are internal hardening changes, not a user-facing feature. Focused automated proof replaces
  a new live-path artifact; #1121 still blocks a real provider-driven chat UAT and is not pulled into
  this parent.
- Database-backed commands run only through the repository's verify-gate procedure. Every PR also
  runs the normal repository gate required at implementation time.

## 1339-A: prove composed dispatch and tasks self-heal

**Tier:** security.

**Dependencies:** all global release gates above.

**Exclusive owned surface:**

- `tests/integration/chat-action-policy-self-heal.test.ts`

### Locked implementation contract

Extend the existing DB-backed suite with exactly one composed-path test. Reuse its database,
`DataContextRunner`, `AiRepository`, and `PreferencesRepository` setup. Use the real
`tasksModuleManifest`, not a copied action-family or tool declaration.

Construct the gateway exactly as production chat does:

1. Create real `SessionTokenRegistry` and `ConfirmationRegistry` instances and a notifier that
   records emitted gateway records.
2. Call `buildChatGatewayDependencies` with `resolveActiveModules` returning
   `[tasksModuleManifest]`, the real repositories/runner, and `agencyPreferences` set to the real
   preferences repository.
3. Pass those dependencies unchanged to `new AssistantToolGateway(...)`.
4. Mint an actor-scoped token and call the real `tasks.create` tool with the minimum valid input
   (`{ title: "Composed self-heal proof" }`). Do not call `getFamilyTier` directly and do not call
   any grant helper before dispatch.

Before `callTool`, read storage without invoking a self-healing resolver and prove that both
`TASK_CHANGES_POLICY_KEY` and `LEGACY_AGENCY_AUTO_EXECUTE_KEY` are absent for the actor. After the
call, read storage directly again.

The test must use another ordinary actor as a negative control. It must not weaken the real tasks
tool, replace its `execute`, seed an action-policy row, or substitute a test-local policy lookup.

### Focused acceptance

- `callTool` succeeds and the notifier's record kinds equal `['action_result']`; no
  `action_request` is emitted.
- The actor's canonical `TASK_CHANGES_POLICY_KEY` exists with value `trusted_auto` after dispatch.
- The actor's legacy key remains absent; the heal does not manufacture legacy state.
- The second actor still has no canonical or legacy tasks policy row.
- The real task tool completed through its normal handler; no confirmation registry resolution is
  needed.
- Run, through verify-gate, `pnpm vitest run tests/integration/chat-action-policy-self-heal.test.ts`.

This closes finding 1, the integration half of finding 5, and the issue's named composed coverage
gap. It does not claim to close the provider-driven UAT gap in #1121.

## 1339-C: degrade a failed tasks heal closed

**Tier:** security, with availability as the user-visible failure mode.

**Dependencies:** 1339-A merged; no live tasks-policy collision.

**Exclusive owned surface:**

- `packages/tasks/src/action-policy.ts`
- `tests/unit/tasks-action-policy-fallback.test.ts`

### Locked implementation contract

Change only `TasksCompatibilityHelper.healInstallGrantAndReread`:

- attempt `grantInstallTimeTrustIfUnset` exactly once;
- if that attempt rejects, return `ask_each_time` immediately;
- do not assert that the insert succeeded, do not continue to the canonical reread after the
  rejected attempt, and do not fall back to `trusted_auto`;
- when the attempt succeeds, keep the existing canonical reread and `ask_each_time` fallback
  unchanged.

This mirrors the generic self-heal's closed result without adding a shared abstraction. Do not
retry, write the legacy key, catch unrelated preference reads, or change
`getResolvedTaskChangesPolicy`'s canonical/legacy precedence.

The focused unit test may spy on the helper's public `grantInstallTimeTrustIfUnset` method to make
the insertion attempt reject. It must exercise `getResolvedTaskChangesPolicy` from a both-absent
state and prove the public result is `ask_each_time`. Keep existing DB-backed race, revocation, and
canonical-authority tests unchanged.

### Focused acceptance

- A rejected install-grant attempt resolves to `ask_each_time`, never `trusted_auto` and never a
  rejected policy promise.
- The insertion is attempted once; no retry or legacy write occurs.
- The existing success path still rereads canonical storage and returns the stored tier.
- Run `pnpm vitest run tests/unit/tasks-action-policy-fallback.test.ts`.
- Run the existing DB-backed tasks policy suites through verify-gate:
  `pnpm vitest run tests/integration/tasks-action-policy-self-heal.test.ts tests/integration/chat-action-policy-self-heal.test.ts`.

## External declaration contract — binding preservation ruling

Fable, acting as Ben's delegate, approved preservation of the current external
`selfOperationGrant` / `actionFamilyId` ABI on 2026-08-10. Finding 2 is superseded and receives no
implementation child. Five independent compatibility signals make these fields intentional:

1. `packages/module-sdk/src/external-module.ts` publishes both fields.
2. `packages/module-registry/src/external/validate.ts` positively validates the declarations,
   referenced family, execution policy, risk, and allowed tiers.
3. `packages/module-registry/src/external/tool-manifests.ts` deliberately maps both fields into the
   live manifest.
4. `external-modules/job-search/jarvis.module.json` depends on them for ordinary private writes.
5. `tests/unit/external-module-action-families.test.ts` and
   `tests/unit/external-module-tool-manifest-policy.test.ts` pin acceptance and preservation.

Silent stripping is not a compatibility strategy. It would return validation success while
removing install-time consent semantics, causing repeated confirmation cards and contradicting the
typed/pinned ABI. W4-C1–C3 remain the hardening work for untrusted external tool input and
shared-gateway enforcement; #1339 adds no parallel validator child.

This ruling is conditional on the contract that lands from #1246. Immediately before A dispatch
and again before parent closure, refresh `origin/main` and verify that both fields remain public,
positively validated, deliberately mapped, and covered by compatibility tests. Any #1246 change to
their presence or semantics invalidates this ruling and requires a fresh Fable/Ben decision. The
Coordinator must not infer rejection, stripping, or continued preservation from this approval
after such a change.

## Explicit non-goals

- No child for GET-on-read side effects.
- No 1339-B external-validator child; finding 2 is superseded by the approved preservation ruling.
- No #1121 provider or UAT harness work.
- No change to `resolvePolicy`, action tiers, confirmation precedence, RLS, or audit payloads.
- No external module signing, sandbox, worker budget, or loader work from #860/#818.
- No attempt to combine #1339 with Wave 4, #1246, or PR #1492.
- No opportunistic cleanup of the large external validator or extraction of a policy abstraction.

## Parent exit criteria

#1339 may close only when:

- 1339-A and 1339-C are merged with their focused evidence and security QA;
- finding 2 is explicitly closed as superseded by Fable's preservation ruling and the refreshed
  positive-validation/compatibility evidence;
- the final #1246 refresh confirms neither external field changed on `main`; otherwise the parent
  remains open for re-ruling;
- finding 4 remains linked as an intentional trade-off, not silently marked fixed; and
- the parent reports no user-visible feature change, only approval-path proof and fail-closed
  hardening.
