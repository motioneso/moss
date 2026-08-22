# Plan: composed dispatch and tasks self-heal proof (#1529, spec 1339-A)

Part of #1529. Spec: `docs/superpowers/specs/2026-08-10-1339-security-review-followups.md`,
section "1339-A: prove composed dispatch and tasks self-heal".

Single phase, single new test case, no UI. Risk tier: security (permission grant path).

## Seams check (file:line citations)

- Test file already exists with five direct `getFamilyTier` tests to extend:
  `tests/integration/chat-action-policy-self-heal.test.ts:1-175`.
- `buildChatGatewayDependencies` signature (what the new test must call):
  `packages/chat/src/gateway-services.ts:123-145`.
- `AssistantToolGateway` constructor takes the dependencies object directly, and
  `callTool(token, toolName, rawInput)` is the only public dispatch entry point:
  `packages/ai/src/gateway/gateway.ts:158-166` (class), `:169` (`callTool` signature).
- `SessionTokenRegistry.mint(identity: SessionIdentity)` returns a token string; identity is
  `{ actorUserId, chatSessionId, allowedToolNames }`:
  `packages/ai/src/gateway/session-tokens.ts:3-9` (interface), `:64-69` (`mint`).
- `GatewaySessionRecord` discriminated union has exactly two `kind` values, `action_request` and
  `action_result` — confirmed current via research agent, `packages/ai/src/gateway/types.ts:17-51`.
- A successful auto-run dispatch (no confirmation required) emits exactly one `action_result` and
  never an `action_request` — confirmed at `packages/ai/src/gateway/gateway.ts:229-238` (YOLO path)
  and `:269-279` (policy "run"/trusted_auto path); `action_request` is only emitted from the
  confirmation-required branches (`gateway.ts:679-685`, `:380-385`).
- `tasksModuleManifest` real manifest, and its `tasks.create` tool entry (`risk: "write"`,
  `executionPolicy: "auto"`, `actionFamilyId: "task_changes"`, `selfOperationGrant:
"granted_at_install"`): `packages/tasks/src/manifest.ts:244` (export), `:637-647` (tool entry).
- `createTaskRequestSchema` accepts `{ title: "..." }` as minimal valid input — confirmed by
  existing unit test `tests/unit/shared-contract-schemas.test.ts:52`.
- `TASK_CHANGES_POLICY_KEY` / `LEGACY_AGENCY_AUTO_EXECUTE_KEY` constants:
  `packages/tasks/src/action-policy.ts:5-6`.
- Self-heal write path (`grantInstallTimeTrustIfUnset`, writes `trusted_auto` only when neither
  canonical nor legacy row exists): `packages/tasks/src/action-policy.ts:64-77`, reached from
  `getFamilyTier` dispatch at `packages/chat/src/gateway-services.ts:242-251`.
- `PreferencesRepository.get(scopedDb, key)` reads a raw preference value directly (no healing
  logic), returning `null` when absent: `packages/structured-state/src/preferences-repository.ts:38-46`.
  This is the "read storage without invoking a self-healing resolver" the spec requires.
- Test database helpers already in use by the file: `connectionStrings`, `ids`, `resetFoundationDatabase`
  — `tests/integration/test-database.ts:22` (connectionStrings), `:34-44` (ids).

No open questions — every capability the spec assumes is cited above and confirmed present and
unchanged.

## Task 1 — add the composed-dispatch test case

File: `tests/integration/chat-action-policy-self-heal.test.ts` (the suite's exclusive owned
surface per spec).

Add one new `it(...)` block inside the existing `describe`, after the last current test. Do not
modify the existing five tests or their fixtures (`testModule`, `tasksShapedModule` stay as-is;
the new test uses the real `tasksModuleManifest`, not either fixture).

New imports needed at the top of the file:

- `randomUUID` from `node:crypto` (for a stable chat session id).
- `AssistantToolGateway`, `SessionTokenRegistry`, `ConfirmationRegistry` as real classes (currently
  only imported as `type` — the new test needs live instances, the existing tests keep using
  `{} as unknown as X` stubs unchanged).
- `tasksModuleManifest` from `packages/tasks/src/manifest.js`.
- `TASK_CHANGES_POLICY_KEY` alongside the existing `LEGACY_AGENCY_AUTO_EXECUTE_KEY` import from
  `../../packages/tasks/src/action-policy.js`.
- A `GatewaySessionRecord` type import from `@moss/ai` for the notifier stub's recorded-records array.

Test body, as behaviour (no implementation code):

1. Pick two fresh actor ids not used by the other five tests in this file (e.g. two new UUIDv4
   literals declared locally in the test, or reuse `ids.userA`/`ids.userB` if this test runs in a
   sub-describe with its own `beforeAll` reset — decide based on whether the existing tests' prior
   writes to those ids would contaminate the "absent before dispatch" assertion; prefer fresh ids
   to avoid coupling to execution order). The second actor is the negative control and never has
   `callTool` invoked against it.
2. Build a real `SessionTokenRegistry` and `ConfirmationRegistry`.
3. Build a `SessionNotifier` test double whose `emit` pushes every record into a local array,
   typed `GatewaySessionRecord[]`.
4. Call `buildChatGatewayDependencies` with: `resolveActiveModules: async () => [tasksModuleManifest]`,
   the shared `repository` and `runner` from the suite's `beforeAll`, the real token/confirmation
   registries, the notifier double, and `agencyPreferences: new PreferencesRepository()`.
5. Construct `new AssistantToolGateway(deps)` from those dependencies, unchanged.
6. Before calling any tool: read `TASK_CHANGES_POLICY_KEY` and `LEGACY_AGENCY_AUTO_EXECUTE_KEY` for
   the first actor via `runner.withDataContext(...) => new PreferencesRepository().get(scopedDb, KEY)`
   directly (no gateway, no `getFamilyTier`). Assert both are `null`.
7. Mint a token via `tokens.mint({ actorUserId: <actor 1>, chatSessionId: <a fresh uuid>,
allowedToolNames: null })`.
8. Call `await gateway.callTool(token, "tasks.create", { title: "Composed self-heal proof" })`.
   Assert the result's `ok` is `true`.
9. Assert the notifier's recorded array has records whose `kind` values are exactly
   `["action_result"]` (i.e., length 1, and that one record's `kind === "action_result"`; no
   `"action_request"` present).
10. Read `TASK_CHANGES_POLICY_KEY` for actor 1 again the same direct way as step 6; assert it now
    equals `"trusted_auto"`.
11. Read `LEGACY_AGENCY_AUTO_EXECUTE_KEY` for actor 1; assert it is still `null` (the heal must not
    manufacture legacy state).
12. Read both keys for actor 2 (the negative control, never dispatched against); assert both are
    still `null`.
13. Also assert, via `repository.listActionPolicies` on actor 1's scoped db (same pattern the
    existing tests already use), that no row exists in the generic `action_policies` table for
    `tasks`/`task_changes` — the tasks compat path writes only to `app.preferences`, never the
    generic table, and this test should catch a regression that changes that.

Why this test would fail against a broken implementation: if the self-heal stopped firing during
real dispatch (e.g. a future change routes `tasks.create` through a code path that never calls
`getFamilyTier`, or the compat helper's write silently no-ops), step 8 would still succeed (auto
tools default-run when no policy exists — confirmed by the existing "run" path in
`gateway.ts:249-289`) but step 10 would find `null` instead of `"trusted_auto"`, failing the test.
If the heal incorrectly touched actor 2's row, step 12 fails. If the heal ever emitted an
`action_request` (e.g. a regression made `task_changes` require confirmation), step 9 fails.

## Verification

```bash
pnpm vitest run tests/integration/chat-action-policy-self-heal.test.ts > /tmp/1529-test.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, 6 passing tests (5 existing + 1 new), 0 failing. Run only through the
`verify-gate` skill per repo rules — never bare `pnpm vitest run` against a DB-backed suite.

Pre-push trio before opening the PR:

```bash
pnpm format:check > /tmp/1529-fmt.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/1529-lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/1529-tc.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0` for all three.

## Kill gate

None needed — single task, single file, no phase 2. If the pre-flight contract check (already
run, see below) had found drift, that would have been the kill/escalate point; it did not.

## Determinism boundary

Not applicable — this is a test-only change with no user-facing UI or model-authored output.

## Pre-flight note (already completed before this plan)

Per the spec's pre-flight instruction, confirmed the gateway's action-flow record contract has not
drifted from what the spec assumes (exactly two `kind` values; auto-run success emits one
`action_result`, never `action_request`). See seams check above for citations. No drift found, so
no escalation was needed.
