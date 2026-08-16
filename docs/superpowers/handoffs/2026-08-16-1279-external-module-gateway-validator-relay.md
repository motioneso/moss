# Relay handoff — 1279-external-module-gateway-validator

Relaying at the context-meter 70% warning (coordinated-build step 3). Grounding is done; no plan
or code written yet. Git tree is clean — nothing to commit from this session.

## Task

GitHub issue **#1279** — "Pin external-module tools to the shared gateway validator with a test,
and name the tool in rejections." Spec: `docs/superpowers/specs/2026-08-09-wave-4-external-module-supply-chain.md`
(lane C, last item — the only lane-C item assigned to this worktree; #1274/#1275 are already
built on `main`, confirmed via `lintAssistantToolInputSchema` wired into
`packages/module-registry/src/external/validate.ts:673`).

**Risk tier: security** — adversarial Opus QA + Ben's explicit merge sign-off required before
merge. Coordinator label `Coordinator`, resolve fresh via `herdr pane list` before messaging
(session id `11cf8264-55a8-4fa4-b32b-c8d086469f74` as of this writing — **re-resolve, don't trust
this value**).

Internal-only change (module-registry validator + test, no UI surface) — no live-path/UAT proof
needed; state that explicitly in the PR per the handoff doc.

## What's verified (issue #1279's two asks, both confirmed real on this branch)

1. **No test proves external-module tools route through the shared gateway validator.**
   `packages/module-registry/src/external/tool-manifests.ts:61` (`createExternalToolManifests`)
   hardcodes `isExternal: true` on every tool synthesized from an installed external module's
   manifest — this is the wiring that pins external tools onto the worker-thread pattern-matching
   path in `packages/ai/src/gateway/input-validation.ts`. It is untested today.
2. **Rejection messages never name the tool.** `packages/ai/src/gateway/input-validation.ts` throws
   `ToolInputValidationError` at 7 sites, all field-path-only:
   - line 145 (`Pattern matching failed and was rejected`, external worker-thread path)
   - lines 197, 211 (`compilePattern`, `Pattern is invalid: ${pattern}`)
   - lines 228, 233 (`validateStringBounds` minLength/maxLength)
   - line 245 (`validateStringBounds` unusable pattern)
   - line 252 (`validateStringBounds` invalid format)
   - line 270 (`validateObject` missing required field)
   - line 291 (`validateValue` enum mismatch)
   - line 297 (`validateValue` type mismatch)
   - line 361 (`validateToolInput` non-object input)

   `validateToolInput` itself (lines 355-377) currently:
   ```ts
   export async function validateToolInput(
     schema: JsonSchema | undefined,
     input: unknown,
     options: { readonly external: boolean }
   ): Promise<ToolInput> {
     if (typeof input !== "object" || input === null || Array.isArray(input)) {
       throw new ToolInputValidationError("Tool input must be an object");
     }
     const value = input as ToolInput;
     if (!schema) {
       return value;
     }

     const externalPatterns = options.external
       ? createExternalPatternSession(AbortSignal.timeout(EXTERNAL_PATTERN_INVOCATION_TIMEOUT_MS))
       : undefined;
     try {
       await validateObject(schema as SchemaNode, value, "", externalPatterns);
       return value;
     } finally {
       await externalPatterns?.close();
     }
   }
   ```

3. **Exactly 3 production call sites** of `validateToolInput` (confirmed by repo-wide grep,
   excluding `node_modules` and `.test.ts`):
   - `packages/ai/src/gateway/gateway.ts:184`, inside `callTool(token, toolName, rawInput)` —
     `toolName` in scope. Errors are caught locally and `.message` flows straight to the caller
     (`{ ok: false, error: error.message }`).
   - `packages/ai/src/gateway/gateway.ts:424`, inside
     `runReadToolForActor(actorUserId, toolName, rawInput)` — `toolName` in scope, same catch
     pattern.
   - `packages/ai/src/routes.ts:713`, inside a REST route handler — `selectedTool.name` in scope.
     This call is inside a broader `try/catch` that delegates to a **generic, shared**
     `handleRouteError` (routes.ts ~1180) which only knows `error.message`, nothing tool-specific.
     This is why the fix must live inside `input-validation.ts` itself, not be bolted onto each
     call site's error handling.

4. **Doc drift (non-blocking, mention in PR):** issue #1279 cites `server.ts:415` for the external
   manifest merge point. No `packages/ai/src/gateway/server.ts` exists in this tree. The real merge
   point is `createExternalToolManifests()` in `tool-manifests.ts`. The underlying claim in the
   issue is still correct — just cite the right file in the plan/PR.

## Planned fix (not yet written as a plan-build plan — do that first)

- Widen `validateToolInput`'s `options` type to `{ readonly external: boolean; readonly toolName: string }`.
- Wrap the function body in try/catch: catch any `ToolInputValidationError`, re-throw a new
  `ToolInputValidationError` with the tool name prefixed onto the original message (single DRY
  point of change — do NOT thread `toolName` through `validateObject`/`validateValue`/
  `validateStringBounds`, that's ~7 call sites of unnecessary churn).
- Update the 3 call sites above to pass `toolName: toolName` / `toolName: selectedTool.name`.

## Planned test

Extend `tests/integration/external-module-gateway.test.ts` (170 lines, read in full — reuse its
`describe`/`beforeAll`/`afterAll` scaffold: `resetFoundationDatabase()`, `createDatabase()`,
`DataContextRunner`, real `createExternalToolManifests()` + real `AssistantToolGateway`). Existing
2 tests both use a **write**-risk tool (`acme.write`) through the confirm/audit flow — don't copy
that shape. New test should use a **read**-risk external tool (risk: "read") with an
`inputSchema.pattern` that a hostile value fails, driven through
`createExternalToolManifests` → `AssistantToolGateway.callTool` (or `runReadToolForActor` if that's
the read-tool path — verify), asserting `{ ok: false }` and that `error` contains the tool name.
Read-risk tools should short-circuit without needing `resolveActionRequest` — confirm this by
reading `gateway.ts` lines 230-330 (already read once this session, re-read if needed).

## Next steps for successor

1. Read the spec section already identified (lane C / #1279 line) — do NOT re-read the whole spec;
   it's already fully extracted above.
2. Write the plan under `docs/superpowers/plans/2026-08-16-1279-external-module-gateway-validator.md`
   per `plan-build` (signatures + test cases + verification commands, no implementation bodies).
3. Message the coordinator (resolve pane fresh) for plan approval — STOP and wait, do not write
   code first.
4. TDD build (2-3 file edits + 1 test file edit), commit per task with explicit `git add <path>`
   (never `-A`).
5. Pre-push trio + rebase, then `coordinated-wrap-up`: gate on isolated DB (`verify-gate` skill —
   never run `pnpm verify:foundation` unscoped), push, open PR, report to coordinator as
   internal-only (no live-path proof needed).

## Run-specific bans (still in force)

Work only in this worktree/branch. `git add` by explicit path only. Never touch
`docs/coordination/`, the board, milestones, or merge. No secrets anywhere.
