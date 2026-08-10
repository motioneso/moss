# Plan — Wave 3 Lane A: action + audit truth (#1256, #1252, #1251)

**Status:** APPROVED (coordinator, 2026-08-09) WITH EXECUTION RE-SLICE — see "Execution slicing"
below. This doc stays the single authority for design/grounding/Fable review across all three
issues; each issue now ships as its own serialized PR out of its own worktree.

**Spec:** `docs/superpowers/specs/2026-08-09-wave-3-action-audit-truth.md`
**Issues:** #1256, #1252, #1251 (lane A — design is unified, per-issue below; **execution is now
three separate PRs, hard-boundaried, serialized because all three edit
`packages/ai/src/gateway/gateway.ts`**)

## Execution slicing (coordinator re-slice, 2026-08-09)

The design/Fable-review above is unchanged and remains approved as-is. Coordinator split execution
into three hard PR boundaries, landed in this order (serialized — each rebases onto the previous
one's merge, since all three touch `gateway.ts`):

1. **PR1 — Task 1 (#1251) only.** This worktree/branch. Files: `packages/ai/src/gateway/gateway.ts`
   (2 catch blocks only — lines ~416, ~506), `packages/ai/src/adapters/redact.ts` (hardening),
   `tests/unit/mcp-gateway-recovery.test.ts` (Task 1's cases only).
2. **PR2 — Task 2 + Task 2b (#1252).** Separate worktree, branches from PR1's merged `main`. Files:
   `packages/ai/src/gateway/gateway.ts` (the `runHandler` `__moduleError` insertion + the
   `runReadToolForActor` gap fix + 3 `recordAudit` call sites), `packages/ai/src/gateway/types.ts`,
   `packages/ai/src/gateway/output-validation.ts` (export `isPlainObject`), `packages/module-sdk/src/errors.ts`
   (doc-only), `tests/unit/mcp-gateway-recovery.test.ts` (Task 2's cases only).
3. **PR3 — Task 3 (#1256).** Separate worktree, branches from PR2's merged `main`. Files:
   `packages/ai/src/gateway/gateway.ts`, `packages/ai/src/routes.ts`, `packages/chat/src/routes.ts`,
   `packages/module-registry/src/index.ts`, `packages/shared/src/ai-api.ts`,
   `tests/integration/ai-tools.test.ts`.

**Dependency check (requested by coordinator before code):** Task 1 is standalone. It touches only
two `catch` blocks (gateway.ts:416, :506) and `redact.ts`; it does not read or write
`GatewayToolResponse.errorClass` (Task 2's field), the `__moduleError` insertion point (Task 2, a
different location in the same `runHandler` function), or anything in `routes.ts`/`ai-api.ts`
(Task 3). No blocking dependency on Task 2/2b/3 exists — PR1 can build, verify, and merge
independently. The only coupling is textual proximity in `gateway.ts` (both Task 1's `runHandler`
catch-block edit and Task 2's `runHandler` insertion sit in the same function), which is exactly why
execution is serialized rather than parallel — PR2 will need a small rebase once PR1 lands, not a
design change.

**This worktree/branch's scope for the remainder of this session:** implement, verify, and wrap up
Task 1 (#1251) only. Do not edit any Task 2/2b/3 file beyond what Task 1 itself requires (none —
Task 1 needs no files outside the three listed under PR1 above).

## Grounding already done (verified against branch, cite-checked)

### #1256 — `/resolve` route bypasses the gateway
- `packages/ai/src/routes.ts:533-553` — the `POST /api/ai/assistant-actions/:id/resolve` handler
  calls `repository.resolveAssistantAction(scopedDb, id, body)` directly. It does **not** go
  through `gateway.resolveActionRequest`, so it has neither the fail-closed no-live-waiter guard
  nor does it unblock a live waiter (`this.deps.confirmations.resolve(...)`).
- `packages/ai/src/gateway/gateway.ts:425-450` — `resolveActionRequest(actorUserId, actionRequestId, status)`
  already exists and does the right thing: returns `"expired"` when `status === "confirmed"` and
  `!this.deps.confirmations.isAwaiting(id)` (line 437), otherwise persists via
  `repository.resolveAssistantAction` and on success calls `this.deps.confirmations.resolve(id, status)`
  (line 448) to unblock the live waiter. Returns `"resolved" | "expired" | "not_found"`.
- `packages/chat/src/routes.ts:346-382` — the reference implementation. Chat's
  `/api/chat/action-requests/:id/resolve` already calls `wiring.gateway.resolveActionRequest` and
  maps outcome → HTTP: `"expired"` → 409, `"not_found"` → 404, else 204. **This is the shape the
  spec's drift-guard test compares against** (spec "Resolved decisions" #1256 drift guard).
- **Gap to close:** `AiRoutesDependencies` (`packages/ai/src/routes.ts:107-128`) has no `gateway`
  field today — nothing wires an `AssistantToolGateway` instance into `packages/ai`'s route
  registration. Need to (a) add an optional `gateway` dependency to `AiRoutesDependencies`, (b) find
  the composition root that already constructs the gateway (likely `packages/module-registry` or
  `apps/api/src/server.ts` — **not yet located, successor's first task**) and pass it through, (c)
  rewrite the `/resolve` handler to call `gateway.resolveActionRequest(...)` and map outcome to a
  response. Response contract: spec says additive-only, never a rename. Current success response is
  `{ action: serializeAssistantAction(action) }` — `gateway.resolveActionRequest` returns a status
  enum, not the row, so the handler must re-fetch/serialize the action row on `"resolved"` (or
  thread the row back some other way — worth comparing against what chat's route omits, since chat
  returns no body on success). Decide and record the exact response shape as a plan decision, not
  during build.
- **Open question for successor:** should `packages/ai`'s `/resolve` gain the same `"expired"` → 409
  status the chat route has (additive to the AI route's contract, which today only returns 404/200)?
  The spec's drift-guard test requires identical *outcomes* for the same request id across both
  routes, which implies yes — but confirm the exact status code / response body shape before coding.

### #1252 — `__moduleError` sentinel, resolved decision already settled by Ben (2026-08-09)
- Reserved key: `__moduleError`. Shape: reuse the existing `MossError` type,
  `packages/module-sdk/src/errors.ts:10-16` — `{ code: string; class: MossErrorClass; remediationRef?: string }`,
  `MossErrorClass = "prerequisite" | "transient" | "validation" | "permission" | "bug"`. Already
  re-exported from the barrel (`packages/module-sdk/src/index.ts:435`) and already used the same way
  elsewhere (`ModuleErrorManifest extends MossError` at `index.ts:450`; consumed client-side in
  `packages/chat/src/live/page-context.ts` and `apps/web/src/chat/page-context.ts`). No new type
  needed — just document the sentinel key.
- **Detection point (single choke point, both internal and external modules):**
  `packages/ai/src/gateway/gateway.ts:477-510`, the `runHandler` private method. Both a built-in
  module's `tool.execute()` and an external module's proxied `execute` (wired via
  `packages/module-registry/src/external/tool-manifests.ts:61`,
  `invoke: (_scopedDb, input, context) => invoke(module, tool, input, context)`) resolve to a
  `Promise<ToolResult>` (`ToolResult.data: Record<string, unknown>`,
  `packages/module-sdk/src/index.ts:75-79`) by the time `runHandler` awaits it — external modules
  get wrapped into `{ data: record }` shape earlier by `externalToolResult()`
  (`apps/api/src/external-module-tools.ts:163-172`), which does NOT need to change: if a module puts
  `__moduleError` inside its raw JSON payload, `externalToolResult` already nests it under `.data`
  because it wraps any non-`{data:...}`-shaped payload as `{ data: record }`. **So the fix is
  entirely inside `runHandler` — no other file needs to change for detection.**
- **What `runHandler` must do differently:** after
  `const result = await this.deps.runner.withDataContext(...)` (line 485-487), check
  `isPlainObject(result.data) && "__moduleError" in result.data`. If present and shaped like a
  `MossError` (has `code: string` and `class` in the `MossErrorClass` set — validate defensively,
  don't trust the module blindly), return `{ ok: false, error: \`Tool ${found.dto.name} failed\`, errorClass: moduleError.class }`
  — **do not** let the raw `__moduleError` payload reach `renderAndCap`/`structuredData` (strip it
  from `result.data` before calling `sanitizeAssistantToolResult`/`renderAndCap`, don't rely solely
  on output-schema allow-listing — a tool with no `outputSchema` skips schema projection entirely,
  see `packages/ai/src/gateway/output-validation.ts:51-53`, and would leak the sentinel verbatim).
  If the key is absent, current behavior (`ok: true`, full envelope) is unchanged — this is the
  documented no-heuristic back-compat gap the spec calls for.
- **Type change needed:** `GatewayToolResponse`'s `ok: false` variant
  (`packages/ai/src/gateway/types.ts:53-64`) currently has two shapes —
  `{ ok:false, denied:true, reason }` and `{ ok:false, error }` — neither carries an errorClass.
  Add an optional `errorClass?: string` to the plain-error variant (or a new discriminated variant)
  so `runHandler`'s return can carry it through to the three `recordAudit` call sites without a
  second lookup. **Do not let `errorClass` change the rendered model-facing string** — Non-goals
  says the model must keep seeing exactly `Tool <name> failed`; `errorClass` is audit-plumbing only,
  never rendered.
- **Three call sites that currently hardcode `errorClass: result.ok ? null : "handler_error"`** and
  need to prefer the module-reported class when present:
  `packages/ai/src/gateway/gateway.ts:201`, `:241`, `:607` (YOLO path, auto-run path, confirm-and-run
  path respectively). Each is `errorClass: result.ok ? null : (result.errorClass ?? "handler_error")`
  once the type carries it. Outcome stays `result.ok ? "success" : "failed"` — no new outcome value,
  matches spec (`app.moss_action_audit_log` outcome CHECK already accepts `'failed'`, no migration).
- **DB check confirmed:** `error_class` column has no enum CHECK, just
  `CHECK (error_class IS NULL OR length(error_class) <= 64)`
  (`packages/ai/sql/0127_jarvis_action_audit_log.sql:11`). Every `MossErrorClass` value fits. No
  migration needed — confirms spec's claim.
- **Handler-throw path is untouched:** `runHandler`'s existing `catch { return { ok: false, error: ... } }`
  (line 506-509) still produces `errorClass: undefined` → falls back to `"handler_error"` exactly as
  today. This satisfies the exit criterion "existing envelope-derived path is unchanged for tools
  that throw."

### #1251 — bare catches that should reach the operator log
Grepped every `catch {` in `packages/ai/src/gateway/gateway.ts` (line numbers below are current,
NOT the spec's stale citations — the file has drifted since the spec was written):
- **Line 416-418** (`runReadToolForActor`): `catch { return { ok: false, error: `Tool ${found.tool.name} failed` }; }`
  — swallows the real error. **Needs the #1251 fix**: `logger.error` (or equivalent — check what
  logger the gateway already has injected, `this.deps.logger`? not yet confirmed, successor's
  task) with tool name, requestId, and the real error, before returning the same sanitized string.
- **Line 506-509** (`runHandler`): same pattern, same fix needed. This is the primary handler-throw
  path used by the confirm/auto/yolo flows.
- **Line 280-282** (native YOLO grant check `catch { return false; }`), **line 551-553** (preview
  hook `catch { preview = undefined; }`), **line 645-647** (first-run notice `catch { return undefined; }`),
  **line 817-819** (native path safety check `catch { return false; }`) — reviewed, **out of scope**:
  none of these return a `Tool <name> failed`-shaped message to the model, none are the "handler
  throw" the spec goal describes. Confirm this reading with the coordinator/Fable if challenged, but
  don't fix what the spec didn't ask for.
- **Line 731** (`recordAuditRaw`'s catch): already logs via `console.error(JSON.stringify({event: "audit_log_write_failed", ...}))`
  — already meets the bar, not a gap. Leave as-is (or migrate to whatever logger #1251 introduces,
  for consistency — successor's call, not required by the spec).
- **Gap:** need to find/confirm what logger is available inside `AssistantToolGateway` — no
  `this.deps.logger` reference found yet in the greps done so far. Check `gateway.ts`'s constructor
  deps type and whether `packages/module-sdk/src/logger.ts` is the intended one, or whether a plain
  `console.error` (matching the existing `recordAuditRaw` pattern at line 731-739) is the house
  style for this file. **Do this check before writing the plan's task list.**

## Resolved since last relay (2026-08-09, second pass)

### #1256 response-shape decision — FINAL
- `resolveActionRequest`'s return type widens from `Promise<"resolved"|"expired"|"not_found">` to
  `Promise<{outcome:"resolved", action: AiAssistantActionRequestSafeRow} | {outcome:"expired"|"not_found"}>`.
  Only real call site needing an update: `packages/chat/src/routes.ts:346-382` (destructure
  `.outcome` instead of comparing the bare string). The test-only `registerResolveRoute` helper in
  `tests/integration/chat-mcp-transport.test.ts:67-88` discards the return value — no change needed.
- `packages/ai/src/routes.ts`'s `/resolve` handler (533-553) rewrites to call
  `gateway.resolveActionRequest` and map:
  - `"resolved"` → `200 { action: serializeAssistantAction(action), outcome: "resolved" }` (additive
    field, existing `action` shape unchanged).
  - `"expired"` → `409 { error: "This request expired — ask again.", outcome: "expired" }` (mirrors
    chat's message/status exactly, per the spec's drift-guard test).
  - `"not_found"` → `404 { error: "Assistant action request not found" }` (unchanged).
- **Schema trap (must check before coding):** `resolveAiAssistantActionRouteSchema` — if its
  response schema is a strict fastify/fast-json-stringify schema, the new `outcome` field will be
  silently stripped unless explicitly added to the schema (`fast-json-stringify-schema-strip.md`
  memory). Verify and update the schema in `packages/shared` as part of task #1256, don't assume.
- **CORRECTION (third pass, coordinator takeover) — the "intended test change" above was wrong.**
  Verified: `tests/integration/ai-tools.test.ts` calls `registerAiRoutes` directly (lines 507, 597,
  661) and never constructs a `chat` module / `AssistantToolGateway` at all. Under the design below
  (gateway wired optionally, via a late-bound getter — mirrors the existing `connectTerminalRpc`
  "absent in tests/deployments that don't wire a cli-runner — degrades gracefully" precedent,
  `packages/ai/src/routes.ts:122-127`), `/resolve` **falls back to today's direct
  `repository.resolveAssistantAction` call when no gateway is wired**, not a hard-fail. Since this
  test never wires a gateway, it keeps exercising the fallback path unchanged — `ai-tools.test.ts:300`
  needs **no edit**. The fail-closed guard only activates in configs where a gateway exists (real
  deployments: `packages/chat/src/routes.ts:214-249`'s `wiring` is truthy whenever
  `resolveActiveModules && mcpServerUrl` are both set, which is the normal prod/host-dev shape).
  A **new** focused test (task #1256, case 5 below) constructs a gateway explicitly to cover the
  fail-closed and live-waiter-unblock paths the exit criterion requires. Flag this correction to
  Fable explicitly — it replaces a wrong claim from the prior relay, worth a second look.

## Plan-build task list (FINAL — ready for Fable review)

Order: #1251 → #1252 → #1256 (smallest/most-isolated first; #1251/#1252 touch only `gateway.ts`,
#1256 also touches `routes.ts`, `packages/shared`, and the `module-registry` composition root).
Commit per task, via the `shared-checkout` skill (shared worktree). TDD: write the failing test
first for each case, then the fix.

### Task 1 — #1251: operator log receives real errors from swallowed catches

**Files:** `packages/ai/src/gateway/gateway.ts`, `tests/unit/mcp-gateway-recovery.test.ts`

**Scope — exactly 2 of the 7 `catch` blocks in this file** (the other 5 were reviewed and ruled
out in "Grounding already done" above — don't touch them):
- `runReadToolForActor`, gateway.ts:416-418 — currently `catch { return { ok: false, error: \`Tool ${found.tool.name} failed\` }; }`. In scope: `found.tool.name`, `actorUserId`, `requestId` (local var, line 398).
- `runHandler`, gateway.ts:506-509 — currently `catch { return { ok: false, error: \`Tool ${found.dto.name} failed\` }; }`. In scope: `found.dto.name`, `ctx.actorUserId`, `ctx.requestId`.

**Fix:** change both to `catch (error) { ... }`, log before returning, matching the house style
already at gateway.ts:731-740 (`console.error(JSON.stringify({event: ..., ...}))`) — no new logger
dependency. **Must reuse `redactSecrets` from `packages/ai/src/adapters/redact.ts:22`** on the
error message before logging — the hard invariant "secrets never escape... logs" (CLAUDE.md) applies
to operator logs too; a handler exception can embed a credential from a lower-level client. Do not
log the raw `error.message` unredacted.

**Required by Fable plan-review (note 1) — harden `redactSecrets` before relying on it here.**
`redactSecrets`/`redactExact` today only match three MCP-token shapes (`JARVIS_MCP_TOKEN=`,
`Bearer …`, `jst_…`) — `redactExact`'s own docstring admits arbitrary secrets are not caught. A
module-handler throw routinely wraps a provider-client error, which can carry a query-string API
key (`?key=…`), a bare `sk-…` key with no `Bearer` prefix, or a `postgres://user:pass@` URL — none
redacted today. **Add to `packages/ai/src/adapters/redact.ts` as part of this task** (small,
additive, in-file): generic patterns for query-param `key`/`api_key`/`token` values, `sk-[A-Za-z0-9_-]{8,}`,
and URL userinfo credentials (`\w+:\w+@`); cap the logged message length (e.g. 2000 chars) as a
backstop for anything still missed. Update this task's negative-assertion test (case 3 below) to
use a secret shape **outside** the original three patterns (e.g. a bare `sk-` key or a `postgres://`
URL) — the original `"Bearer sk-test-abc123"` example passes trivially against the un-hardened
matcher and would not have caught this gap.

Exact new code, both sites (event name differs per site):
```ts
} catch (error) {
  console.error(
    JSON.stringify({
      event: "read_tool_handler_threw", // or "tool_handler_threw" for runHandler
      toolName: found.tool.name,        // found.dto.name for runHandler
      actorUserId,                       // ctx.actorUserId for runHandler
      requestId,                         // ctx.requestId for runHandler
      error: redactSecrets(error instanceof Error ? error.message : String(error))
    })
  );
  return { ok: false, error: `Tool ${found.tool.name} failed` }; // unchanged string, unchanged shape
}
```

**Test cases (exit criterion: "operator log receives the real error while the returned string
stays exactly `Tool <name> failed`... negative assertion proves no secret or handler internal
reaches the model-visible return value"):**
1. `runReadToolForActor`: stub a read tool's `execute` to throw `new Error("boom: db timeout")`;
   spy `console.error`; assert the spy was called with a JSON payload containing `"boom: db timeout"`
   (or its redacted form) and `toolName`; assert the returned `GatewayToolResponse` is
   `{ ok: false, error: "Tool <name> failed" }` — exact string, no interpolation of the real error.
2. Same for `runHandler` (write-tool throw path via `confirmAndRun`/auto-run/YOLO — whichever is
   cheapest to drive `runHandler` directly in the existing test harness).
3. **Negative assertion:** stub the thrown error's message to include a fake-shaped secret **outside
   the original three `redactSecrets` patterns** — e.g. `"postgres://user:hunter2@db.internal/app"`
   or a bare `"sk-liveTestKey1234567890"` with no `Bearer` prefix (per Fable review note 1: the
   original `"Bearer sk-test-abc123"` example passes trivially against the un-hardened matcher and
   proves nothing about the new generic patterns). Assert the *returned* string never contains it
   (already true, since the return is a hardcoded template) **and** assert the *logged* payload has
   it redacted (not raw), proving the hardened `redactSecrets` is actually wired and actually catches
   this shape.

**Home:** `tests/unit/mcp-gateway-recovery.test.ts` (already imports `AssistantToolGateway` +
constructs it directly with stub deps — matches this task's needs exactly, per earlier grounding).

### Task 2 — #1252: `__moduleError` sentinel produces a real audit outcome + errorClass

**Files:** `packages/ai/src/gateway/gateway.ts`, `packages/ai/src/gateway/types.ts`,
`packages/ai/src/gateway/output-validation.ts`, `tests/unit/mcp-gateway-recovery.test.ts`

**Signature changes:**
- `packages/ai/src/gateway/output-validation.ts`: export the existing `isPlainObject` (line 197) —
  add `export` to its declaration, no behavior change.
- `packages/ai/src/gateway/types.ts`: `GatewayToolResponse`'s `{ ok: false, error }` variant
  (lines 53-64) gains an optional field: `errorClass?: string`. Non-goal: `error` string itself is
  never derived from `errorClass` or the module payload — stays the hardcoded `Tool <name> failed`.

**Fix — `runHandler` (gateway.ts:477-510), inserted right after line 487
(`const result = await this.deps.runner.withDataContext(...)`), before line 488
(`sanitizeAssistantToolResult`):**
```ts
if (isPlainObject(result.data) && "__moduleError" in result.data) {
  const moduleError = result.data.__moduleError;
  const validClasses: readonly string[] = ["prerequisite", "transient", "validation", "permission", "bug"];
  const errorClass =
    isPlainObject(moduleError) &&
    typeof moduleError.code === "string" &&
    typeof moduleError.class === "string" &&
    validClasses.includes(moduleError.class)
      ? moduleError.class
      : "bug"; // malformed sentinel still counts as a module-reported failure, never crashes the gateway
  return { ok: false, error: `Tool ${found.dto.name} failed`, errorClass };
}
```
This is a hard early return — `result.data` (with the raw `__moduleError` payload) is never passed
to `sanitizeAssistantToolResult`/`renderAndCap` in this branch, so it can't leak regardless of
whether the tool declared an `outputSchema` (closes the gap noted at
`output-validation.ts:51-53` — schema-less tools skip projection entirely).

**Three call sites to update** (currently hardcode `errorClass: result.ok ? null : "handler_error"`):
gateway.ts:201, :241, :607 → `errorClass: result.ok ? null : (result.errorClass ?? "handler_error")`.
Outcome stays `result.ok ? "success" : "failed"` — no new outcome value, no migration (confirmed:
`error_class` column is an unconstrained length-checked text field,
`packages/ai/sql/0127_jarvis_action_audit_log.sql:11`).

**Required by Fable plan-review (note 4) — close the same gap in `runReadToolForActor`.**
`runHandler`'s early return is correctly placed ahead of `sanitize`/`renderAndCap`/`structuredData`/
`media`, but the cross-tool pre-submit path, `runReadToolForActor` (gateway.ts:405-415), calls
`found.execute` + `renderAndCap` directly and does **not** go through `runHandler`. A schema-less
read tool returning `__moduleError` would pass the raw sentinel payload to the model as `ok: true`
— the exact leak this task exists to close, just on the read path instead of the write path. Reads
aren't audited, so this doesn't break the audit exit criterion, but it does violate the task's own
"never let the raw sentinel payload reach the model" rationale. Add the identical 3-line check
(same `isPlainObject`/`__moduleError`/`validClasses` logic, factored into a small shared helper
rather than copy-pasted) immediately before `runReadToolForActor`'s `renderAndCap` call.

**Test case 5 (new, covers the `runReadToolForActor` path):** stub a read tool's `execute` to
resolve with `{ data: { __moduleError: { code: "no_account", class: "prerequisite" } } }`; call
`runReadToolForActor`; assert the response is `{ ok: false, error: "Tool <name> failed" }` (or
`errorClass`-carrying, if the read-tool response shape supports it) and that the raw
`__moduleError` object never appears anywhere in the returned payload.

**Test cases (exit criterion: "__moduleError records non-success outcome + errorClass; existing
envelope-derived path unchanged for throwing tools; a module that hasn't adopted the key behaves
exactly as today"):**
1. Stub a tool's `execute` to resolve with `{ data: { __moduleError: { code: "no_account", class: "prerequisite" } } }`; call `runHandler` (or drive it via `confirmAndRun`); assert
   `{ ok: false, error: "Tool <name> failed", errorClass: "prerequisite" }` and that `recordAudit`
   is called with `outcome: "failed"`, `errorClass: "prerequisite"`.
2. Same with a malformed `__moduleError` (missing `class`, or an invalid `class` value like
   `"nonsense"`) — assert it still resolves `ok: false` with `errorClass: "bug"`, never throws.
3. Existing handler-throw path (already covered by Task 1's tests) — assert `errorClass` is
   `undefined` from `runHandler`, and the call-site fallback (`?? "handler_error"`) is what lands in
   the audit row — i.e. this is a call-site-level assertion, not a `runHandler`-level one.
4. A tool that resolves normally with `{ data: { someField: "x" } }` (no `__moduleError` key) —
   assert `ok: true` and full envelope unchanged (back-compat gap intentionally preserved).

**Home:** `tests/unit/mcp-gateway-recovery.test.ts`.

### Task 2b — #1252: document `__moduleError` in the module SDK (Fable note 2, required)

**Files:** `packages/module-sdk/src/errors.ts`, wherever this package's module-authoring docs live
(check for a `packages/module-sdk/README.md` or doc comment block near `MossError`/`MossErrorClass`
on write — grep first, don't assume a path).

The spec's settled decision (`docs/superpowers/specs/2026-08-09-wave-3-action-audit-truth.md`)
states `__moduleError` is "reserved and documented in the SDK," and that the back-compat gap (a
module that hasn't adopted the key keeps behaving as it does today) is "documented in the SDK and
stated on the issue when it closes." Today `__moduleError` appears nowhere in `packages/module-sdk`
— no plan task touched this until this review caught it. Add:
- A doc comment (or README section) next to `MossError`/`MossErrorClass` in
  `packages/module-sdk/src/errors.ts` explaining: a tool's `execute` may resolve (not throw) with
  `{ data: { __moduleError: { code, class, message? } } }` to report a structured failure without
  losing partial data; `class` must be one of `MossErrorClass`'s values or the gateway treats it as
  `"bug"`; this is purely additive — existing tools that never emit the key are unaffected.
- No test required for this task (it's documentation-only) — verify by reading the diff.
- **When #1252 closes, state the back-compat guarantee explicitly in the issue-closing comment**
  (per the spec's own wording) — a build-time note to self for whoever writes the close comment, not
  a code change.

### Task 3 — #1256: `/resolve` route goes through the gateway's fail-closed guard

**Files:** `packages/ai/src/gateway/gateway.ts`, `packages/ai/src/routes.ts`,
`packages/chat/src/routes.ts`, `packages/module-registry/src/index.ts`,
`packages/shared/src/ai-api.ts`, `tests/integration/ai-tools.test.ts`

**3a. `gateway.ts:425-450` — widen `resolveActionRequest`'s return type:**
```ts
async resolveActionRequest(
  actorUserId: string,
  actionRequestId: string,
  status: "confirmed" | "rejected" | "cancelled"
): Promise<
  | { outcome: "resolved"; action: AiAssistantActionRequestSafeRow }
  | { outcome: "expired" | "not_found" }
> {
  if (status === "confirmed" && !this.deps.confirmations.isAwaiting(actionRequestId)) {
    return { outcome: "expired" };
  }
  const access: AccessContext = { actorUserId, requestId: `mcp_${randomUUID()}` };
  const resolved = await this.deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
    this.deps.repository.resolveAssistantAction(scopedDb, actionRequestId, { status })
  );
  if (!resolved) return { outcome: "not_found" };
  this.deps.confirmations.resolve(actionRequestId, status);
  return { outcome: "resolved", action: resolved };
}
```
Import `AiAssistantActionRequestSafeRow` from `../repository.js` (already imported elsewhere in
this file's package — confirm on write, it's a same-package type).

**3b. `packages/chat/src/routes.ts:346-382` — update the one real call site:**
```ts
const result = await wiring.gateway.resolveActionRequest(access.actorUserId, id, rawStatus);
if (result.outcome === "expired") {
  return reply.code(409).send({ error: "This request expired — ask again." });
}
if (result.outcome === "not_found") {
  return reply.code(404).send({ error: "Action request not found" });
}
return reply.code(204).send();
```
`tests/integration/chat-mcp-transport.test.ts:67-88`'s `registerResolveRoute` test helper discards
the return value already — no change needed there.

**3c. Composition root — `packages/module-registry/src/index.ts` — new late-bound
`getGateway`/`adoptGateway` pair, mirroring `rpcConnection`/`getRpcConnection`/
`adoptChatRpcConnection` exactly (lines 2121-2122, 2259-2261):**
- Near line 2121: `let gateway: Pick<AssistantToolGateway, "resolveActionRequest"> | undefined;`
  `const getGateway = () => gateway;`
- In the `deps: BuiltInRouteDependencies` object literal (~2259-2266), alongside
  `adoptChatRpcConnection`: add `getGateway,` and
  `adoptGateway: (g: AssistantToolGateway) => { gateway = g; },`
- `BuiltInRouteDependencies` interface (~440-465): add two fields mirroring
  `adoptDropSessionsForProvider?: ChatRoutesDependencies["adoptDropSessionsForProvider"]`:
  `readonly getGateway: AiRoutesDependencies["getGateway"];` (non-optional — always provided by the
  composition root, even if it resolves to `undefined`) and
  `readonly adoptGateway?: ChatRoutesDependencies["adoptGateway"];`
- `aiModuleManifest.registerRoutes` (line 1321-1349): add `getGateway: deps.getGateway` to the
  `registerAiRoutes(server, {...})` call.
- `chatModuleManifest.registerRoutes` (line 1358+): add `adoptGateway: deps.adoptGateway` to the
  `registerChatRoutes(server, {...})` call. `ChatRoutesDependencies` (packages/chat/src/routes.ts)
  needs the matching `adoptGateway?: (gateway: AssistantToolGateway) => void` field, and the
  `wiring` closure (chat/routes.ts:214-249) calls `dependencies.adoptGateway?.(gateway)` right after
  `new AssistantToolGateway(...)` (line 245) — mirrors how `notifierProxy` is wired one step earlier.

**3d. `packages/ai/src/routes.ts` — `AiRoutesDependencies` gains a field (mirrors
`connectTerminalRpc?`, lines 122-127, same "absent in tests/deployments that don't wire it —
degrade gracefully" precedent):**
```ts
readonly getGateway?: () => Pick<AssistantToolGateway, "resolveActionRequest"> | undefined;
```
Import `type { AssistantToolGateway }` from `./gateway/gateway.js` (same package, no new edge).

**3e. `/resolve` handler (routes.ts:533-553) rewrite:**
```ts
async (request, reply) => {
  try {
    const accessContext = await dependencies.resolveAccessContext(request);
    const body = parseResolveAssistantActionBody(request.body);
    const gateway = dependencies.getGateway?.();
    if (!gateway) {
      // No gateway wired in this deployment/test config — fall back to the pre-#1256 behavior.
      const action = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
        repository.resolveAssistantAction(scopedDb, request.params.id, body)
      );
      if (!action) return reply.code(404).send({ error: "Assistant action request not found" });
      if (body.status === "confirmed") {
        // Fable review note 3: make a future wiring regression operator-visible instead of a
        // silent fail-open — this branch should be rare/expected only in narrow test configs.
        console.error(
          JSON.stringify({ event: "resolve_confirmed_without_gateway", actionRequestId: request.params.id })
        );
      }
      return { action: serializeAssistantAction(action), outcome: "resolved" as const };
    }
    const result = await gateway.resolveActionRequest(accessContext.actorUserId, request.params.id, body.status);
    if (result.outcome === "expired") {
      return reply.code(409).send({ error: "This request expired — ask again.", outcome: "expired" as const });
    }
    if (result.outcome === "not_found") {
      return reply.code(404).send({ error: "Assistant action request not found" });
    }
    return { action: serializeAssistantAction(result.action), outcome: "resolved" as const };
  } catch (error) {
    return handleRouteError(error, reply);
  }
}
```

**3f. `packages/shared/src/ai-api.ts` schema updates (fast-json-stringify strip trap — MUST do,
per `additionalProperties: false` on both schemas, lines 620-627 and 841-850):**
- `resolveAiAssistantActionResponseSchema` (line 620): add `outcome: { type: "string", const: "resolved" }` to `properties`, add `"outcome"` to `required`.
- New `resolveAiAssistantActionExpiredResponseSchema`: `{ type: "object", additionalProperties: false, required: ["error", "outcome"], properties: { error: { type: "string" }, outcome: { type: "string", const: "expired" } } }`.
- `resolveAiAssistantActionRouteSchema.response` (line 844-849): add `409: resolveAiAssistantActionExpiredResponseSchema`.

**Test cases (exit criterion: "a focused test proves the /resolve route fails closed with no live
waiter, unblocks a live waiter when one exists, and matches the chat route's outcome — including the
expired case"):**
1. **No gateway wired** (today's `ai-tools.test.ts` server setup, unchanged): existing test at
   line 300 stays green, unmodified — proves the fallback preserves current behavior.
2. **New test, gateway wired, no live waiter:** construct an `AssistantToolGateway` with a real
   `ConfirmationRegistry` (nothing `isAwaiting`), wire it via `getGateway` into a fresh
   `registerAiRoutes` call, create a pending action row directly via the repository, POST
   `{status:"confirmed"}` to `/resolve` — assert `409` + `{outcome:"expired"}`, and assert the DB
   row is still `"pending"` (not mutated) — this is the drift-guard, matches chat's `409` exactly.
3. **New test, gateway wired, live waiter exists:** register a waiter on the `ConfirmationRegistry`
   for the action id (`confirmations.register(id, ...)` or whatever the real registration API is —
   check `ConfirmationRegistry`'s public methods before writing), POST `{status:"confirmed"}` —
   assert `200` + `{action, outcome:"resolved"}`, and assert the waiter was unblocked (spy/await the
   registry's resolve promise).
4. **Not-found case:** POST to a nonexistent id — assert `404`, unchanged from today.
5. **Drift-guard test proper** (spec-required, compares ai vs chat outcomes for the same scenario):
   for the same no-live-waiter setup, assert `packages/ai`'s `/resolve` and `packages/chat`'s
   `/api/chat/action-requests/:id/resolve` produce the same semantic outcome (`expired`) — status
   codes both `409`, matching per 3b/3e above.

**Home:** new `describe` block in `tests/integration/ai-tools.test.ts`, near the existing resolve
tests (~line 280+).

## Kill gate

Stop and escalate to Fable/coordinator (don't push through) if, during build:
- Any test in `tests/integration/chat-mcp-transport.test.ts` or the existing
  `tests/integration/ai-tools.test.ts` suite starts failing for a reason *other than* the specific
  new assertions being added — that means a grounding fact above is stale.
- The `ConfirmationRegistry` has no public method to register/inspect a waiter from a test (task 3,
  case 3) — that's a missing test seam, not a design problem to work around with a hack.
- Adding `outcome` to `resolveAiAssistantActionResponseSchema` reveals other consumers
  (`apps/web/src/**`) doing strict/exhaustive switch-matching on the response shape that would break
  — additive-only means client code must already tolerate unknown fields; if it doesn't, that's a
  pre-existing bug worth flagging, not silently working around.
- Any change requires touching `AccessContext` (adding fields) or bypassing RLS — both are hard
  invariants, immediate stop.

## Verification commands (run per task, unpiped, record exit code)

```
pnpm --filter @moss/ai typecheck        # expect 0
pnpm --filter @moss/ai test -- gateway  # expect 0 (task 1, 2 — unit tests, no DB needed)
```
For task 3's integration tests, use the `verify-gate` skill (isolated DB) — never run
`pnpm verify:foundation` or any DB-touching command unscoped. Full local gate only at
`coordinated-wrap-up` time, per the skill.

**Fable review note 5 — green unit+integration is not the finish line.** Per the spec's Exit
Criteria (lane-wide), this PR additionally needs, before it's reportable as done:
- An Opus adversarial QA verdict posted as a `gh pr comment` (spec, lane-wide).
- Live-path proof: a real approve/deny through the real UI on a live dev instance, plus the
  resulting audit row (Lane A specifically, since #1256 is UI-adjacent) — owned by the
  `coordinated-build`/`coordinated-wrap-up` skills, not by the unit/integration gate above.

## Fable plan review — verdict (2026-08-09, coordinator-takeover run)

**APPROVE WITH NOTES.** Full independent cross-check against the branch (`gateway.ts`'s 7 catch
blocks, all 3 `recordAudit` sites, the `connectTerminalRpc?`/`rpcConnection` precedents, both
`additionalProperties: false` schemas, `MossErrorClass`, and independent re-verification of the
walked-back `ai-tools.test.ts` claim — confirmed no test needs to change). Q1 (fail-open-when-no-
gateway) ruled acceptable: a no-gateway deployment can never execute the action anyway (pending
rows are only created by gateway flows; write tools can't execute via REST), so the fallback's only
residual risk is the pre-existing DB/drawer divergence, unchanged from today — note 3 above turns
the one remaining risk (a silent future wiring regression) into an operator-visible log line.
Notes 1 (redaction hardening) and 2 (SDK doc task) were **required** before build and are now
folded into Task 1 and Task 2b above. Notes 3 and 4 (recommended/flagged) are folded into Task 3's
handler and Task 2 respectively. Note 5 is folded in immediately above. Test coverage confirmed
against all three spec exit criteria; kill gate confirmed sound. No open items remain from the
review — plan is ready for coordinator approval.

## Not yet done (successor's next steps, in order)

1. Confirm the gateway's available logger (or settle on `console.error` matching line 731's
   existing pattern) — one grep/read, `packages/ai/src/gateway/gateway.ts` constructor + deps type.
2. Locate the composition root that constructs `AssistantToolGateway` and registers
   `packages/ai`'s routes, to find how to thread a `gateway` dependency into `AiRoutesDependencies`
   for #1256. Likely `packages/module-registry/src/*` or `apps/api/src/server.ts` — not yet grepped.
3. ~~Decide the #1256 response-shape/status-code question~~ — DONE, see "Resolved since last relay"
   above.
4. Write the full `plan-build`-shaped plan: task boundaries (suggest 3 tasks, one per issue, in
   #1251 → #1252 → #1256 order — smallest/most-isolated first, or whatever order the successor
   judges lowest-risk-first; #1251 and #1252 are both confined to `gateway.ts`, #1256 also touches
   `routes.ts` and the composition root), exact signatures, test cases per exit criterion (see spec
   "Exit criteria" section, already read in full by this session — re-read it, it's short), kill
   gate, verification commands (unpiped, expected exit codes).
5. Message the coordinator (label `Coordinator`, session id `890502d0-c97b-4ed1-aaae-8c33ec48c98f`)
   with the finished plan path. **Verify `herdr pane list` shows exactly one `Coordinator` pane
   before messaging — do not use a cached pane number.** Wait for approval before writing code. The
   plan also needs a Fable plan-review per the manifest (security tier) before coordinator approval
   — see handoff doc.

## Do not re-derive

Everything under "Grounding already done" above is verified against the actual worktree at the time
of writing (branch `w3a-audit-truth`, clean tree, `pnpm install` already run). Trust these citations;
re-grep only if something looks like it's drifted since this was written, not as a matter of course.
