# Plan — Wave 3 Lane A: action + audit truth (#1256, #1252, #1251)

**Status:** DRAFT — grounding complete, task breakdown not yet finalized. Written mid-relay at the
context-meter 70% trigger so the grounding work survives the handoff. Successor: verify these
citations still hold, then finish the plan-build checklist (task boundaries, test cases, kill gate)
before messaging the coordinator for plan approval. Do not skip the coordinator approval gate.

**Spec:** `docs/superpowers/specs/2026-08-09-wave-3-action-audit-truth.md`
**Issues:** #1256, #1252, #1251 (lane A, sequential — all three edit `packages/ai/src/gateway/gateway.ts`)

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

## Not yet done (successor's next steps, in order)

1. Confirm the gateway's available logger (or settle on `console.error` matching line 731's
   existing pattern) — one grep/read, `packages/ai/src/gateway/gateway.ts` constructor + deps type.
2. Locate the composition root that constructs `AssistantToolGateway` and registers
   `packages/ai`'s routes, to find how to thread a `gateway` dependency into `AiRoutesDependencies`
   for #1256. Likely `packages/module-registry/src/*` or `apps/api/src/server.ts` — not yet grepped.
3. Decide and record the #1256 response-shape/status-code question above (additive field vs new
   status code) as a plan decision.
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
