# 2175 Safety Core — Build Plan (Tasks 1-4)

Spec: `docs/superpowers/specs/2026-09-01-integration-tool-call-discipline.md`
Milestone plan: `docs/superpowers/plans/2026-09-01-integration-tool-call-discipline.md` (Tasks 1-4)
Issue: #2175 (Part of #2175)
Branch: `build/2175-safety-core`

## Seams check (grounded against this branch, file:line)

- `packages/shared/src/integrations-api.ts:10-15` — `IntegrationToolDescriptor` has no `readOnly`/`idempotent`/`destructive` fields yet. Task 1 premise holds.
- `packages/integrations/src/mcp-client.ts:39-44` — MCP discovery maps `name, description, group:"", inputSchema`, drops everything else including `t.annotations`. Task 1 premise holds.
- `packages/integrations/src/openapi-convert.ts:85-101` — no per-method hint mapping. Task 1 premise holds.
- `packages/integrations/src/tool-manifests.ts:100-115` — `execute` is `async (scopedDb, input)`, no third `ctx` param used, so it cannot see `actorUserId`/`chatSessionId` yet. Must be widened to `(scopedDb, input, ctx)` — `ToolExecute` in `packages/module-sdk/src/index.ts:140-145` already carries `ctx: ToolContext` as the 3rd param, so this is additive, not a type change.
- `packages/module-sdk/src/index.ts:95-101` — `ToolContext` = `{ actorUserId, requestId, chatSessionId, localTimezone? }`. Confirms spec section 3's claim.
- `packages/ai/src/gateway/gateway.ts:483` — `const ctx: ToolContext = { actorUserId, requestId, chatSessionId: "", localTimezone }` on the cross-tool read path. Confirms spec section 3's "empty string" claim exactly.
- `packages/integrations/src/limits.ts:1-3` — `RESPONSE_CHAR_CAP = 64_000` exists, used only in `openapi-invoke.ts:67-68`. MCP path (`mcp-client.ts`) has no size cap at all. Confirms spec section 5 exactly.
- `packages/integrations/src/curation.ts` — `mutedTools` pattern to mirror for the new escape-hatch column.
- `packages/integrations/src/repository.ts:8-28,40-52,54-74,155-163,224-245` — full `mutedTools` plumbing (ConnectionRow, UpdateConnectionInput, ConnectionSqlRow, SELECT_COLUMNS, updateConnection patch branch, mapRow) is the exact pattern to copy for the new column.
- `packages/integrations/src/routes.ts:215-217,281-288` — where `mutedTools` crosses into `IntegrationDetail` and where `UpdateIntegrationRequest` is parsed into a patch. Same two spots need the new field.
- `packages/integrations/sql/0207_integration_connections.sql` — only migration in this package; table has `muted_tools text[] NOT NULL DEFAULT '{}'` at the same level the new column joins. Highest migration number anywhere in the repo (`find packages -path '*/sql/*.sql'`) is `0207`. **Next number `0208` is my pick, not yet confirmed with the coordinator** — flag this in the plan-approval message; another concurrent lane could claim it first.
- `packages/chat/src/live/runtime.ts:72-110` — `composeMossPersona(surface)` builds the provider-agnostic system prompt from exported string constants (`MOSS_PERSONA_BASE`, `MOSS_PERSONA_TOOL_GUIDANCE`, etc.) joined with `\n`. This is the "shared chat system prompt" Task 2 step 4 targets — found by tracing `renderPersona` -> `chat-session-manager.ts:227-238` -> `runtime.ts:692-706`. No provider name appears anywhere in it (satisfies the provider-agnostic hard invariant).

## Task 1 — Tool hints

**`packages/shared/src/integrations-api.ts`** — widen `IntegrationToolDescriptor` exactly as the milestone plan's Step 1 code block (readOnly/idempotent/destructive, all optional booleans, absent = "did not say").

**`packages/integrations/src/mcp-client.ts`** — in `discoverMcpTools`, map `t.annotations?.readOnlyHint`, `t.annotations?.idempotentHint`, `t.annotations?.destructiveHint` onto the three fields (MCP SDK's `Tool.annotations` is `ToolAnnotations | undefined` with those three optional booleans per the MCP spec — not re-verified against `node_modules` in this session because that path is permission-denied to Bash/Read here; verify the field names compile during TDD). Only set a field when the annotation is a boolean; otherwise leave it absent (do not coerce `undefined` to `false`).

**`packages/integrations/src/openapi-convert.ts`** — in the per-method loop (`convertOpenApiSpec`, around line 85-101), add:

```ts
readOnly: method === "get" || method === "head" ? true : undefined,
idempotent: ["get", "head", "put", "delete"].includes(method) ? true : undefined,
```

(no `destructive` — leave unset). Note: current `METHODS` const only has `get,post,put,patch,delete` (no explicit `head` — confirm during TDD whether `head` needs adding to `METHODS` itself, since today's converter may not even discover HEAD operations; if so this is a pre-existing gap outside this task's scope — just make the mapping correct for the methods the converter already handles).

**Test:** `tests/unit/integrations-tool-hints.test.ts` — one tool list with one read-only-annotated, one idempotent-annotated, one destructive-annotated, one bare tool (MCP); one OpenAPI spec with one operation per method, asserting the exact hint combination per method; a stored connection whose `discovered_tools` JSON predates these fields still loads (no migration — JSON tolerates missing keys).

## Task 2 — Outcome envelope + prompt rule

**`packages/integrations/src/tool-manifests.ts`** — add:

```ts
export interface IntegrationOutcomeEnvelope {
  readonly status: "ok" | "error";
  readonly action: "performed" | "read";
  readonly summary: string;
  readonly detail: unknown;
}
```

Fixed summary strings (exact wording from the spec, reused by Tasks 3-4 too):

```ts
export const INTEGRATION_SUMMARY = {
  performedOk: "Action performed successfully.",
  readOk: "Read succeeded.",
  callFailed: "Call failed; see detail for the service's error.",
  blockedRead: "Unchanged result from earlier in this request.",
  blockedPerformed: "This was already done once in this request and was not done again.",
  truncated: "Result truncated at 8,000 characters; ask for a narrower query to see more.",
  requestRefused: "Call limit reached for this request; answer with what you have."
} as const;
```

`action` is `"read"` exactly when `tool.readOnly === true`; everything else (including both `false` and absent) is `"performed"` — matches spec section 2 exactly. `detail` is the service's payload passed through byte-identical; never rewritten.

**`packages/integrations/src/mcp-client.ts`, `openapi-invoke.ts`** — no shape change needed beyond what Task 4 does to size capping; they keep returning `{ ok, data }`, and `tool-manifests.ts` wraps that into the envelope. (If TDD shows the envelope belongs one level lower for a good reason, keep `status`/`action`/`summary`/`detail` field names and ordering — they're the part of the contract other tasks depend on.)

**Chat system prompt** — in `packages/chat/src/live/runtime.ts`, add one exported constant near `MOSS_PERSONA_TOOL_GUIDANCE` (line ~81-86), under 40 words per the milestone plan's Determinism Boundary section:

```ts
export const MOSS_PERSONA_INTEGRATION_RESULT_TRUST =
  "When a connected-service tool reports status ok and action performed, the action happened — do not call a read tool afterward just to confirm it.";
```

Add it to the `parts` array in `composeMossPersona` (line 105-110), every surface (not gated on `DEFAULT_CHAT_SURFACE` like the app-map block, since it applies to integration tools generally).

**Test:** `tests/unit/integrations-envelope.test.ts` — envelope shape for success/error/MCP/OpenAPI; `detail` byte-identical to the service's raw payload; no credential-shaped string anywhere in the envelope (grep the serialized JSON for a fixture secret).

## Task 3 — In-burst duplicate suppression

**Create `packages/integrations/src/call-memory.ts`** (package-level singleton store, not a resolver closure — Task 8 finding):

```ts
export interface CallMemoryScope {
  readonly actorUserId: string;
  readonly chatSessionId: string; // "" on the cross-tool read path — still per-user, one shared bucket
}

export interface CallMemoryEntry {
  readonly ok: boolean;
  readonly action: "performed" | "read";
  readonly summary: string;
  readonly detail: unknown;
}

export type CallMemoryDecision =
  | { readonly kind: "run" }
  | { readonly kind: "serve"; readonly summary: string; readonly detail?: unknown };

export interface CallMemory {
  /** Canonical key: connection id + tool name + JSON of args with keys sorted. */
  callKey(connectionId: string, toolName: string, args: Record<string, unknown>): string;
  /** Decide whether to invoke the service or serve a stored/blocked result. Looking up never extends the window. */
  check(
    scope: CallMemoryScope,
    connectionId: string,
    key: string,
    action: "performed" | "read",
    skipSuppression: boolean
  ): CallMemoryDecision;
  /** Record a call that reached the service. Only this call extends the 30s window. ok:false performed calls do NOT clear reads (nothing was confirmed to have happened) and are never memoized as a block. */
  record(scope: CallMemoryScope, connectionId: string, key: string, entry: CallMemoryEntry): void;
}

export function createCallMemory(deps?: { now?: () => number; windowMs?: number }): CallMemory;

/** Module-level singleton — imported by tool-manifests.ts. Never place this in a resolver closure (Task 8). */
export const callMemory: CallMemory;
```

Rules `check`/`record` must implement (all from spec section 3, restated as behaviour):

- Read repeat, no successful performed call on that connection since it was stored, entry.detail short (`< 500` chars serialized) -> `serve` with the stored `summary`/`detail`.
- Read repeat, same but stored detail is long -> `serve` with `summary` only (`INTEGRATION_SUMMARY.blockedRead`), no `detail`.
- Read repeat, but a successful (`ok: true`) performed call happened on the same connection after the read was stored -> `run` (stale, re-run for real).
- Performed repeat, prior entry was `ok: true`, and `skipSuppression` is false -> `serve` with `INTEGRATION_SUMMARY.blockedPerformed`, no `detail`.
- Performed repeat with `skipSuppression: true` (tool's escape-hatch flag on) -> `run` always.
- Performed repeat where the prior entry was `ok: false` -> `run` (an error was never a real duplicate side effect).
- `record` with `action: "performed", ok: true` clears every stored **read** entry for that `connectionId` within the scope (not performed entries — those stay to keep blocking further repeats).
- Entries expire 30s after their last `record` (not after a `check`/`serve`) — quiet window is quiet by real calls only.
- Two different `chatSessionId` scopes for the same user never see each other's entries; two different `actorUserId` never see each other's, even with the same `chatSessionId` string.

**Escape hatch column** — new SQL file `packages/integrations/sql/0208_integration_unsuppressed_tools.sql` (confirm `0208` is free with the coordinator before committing it):

```sql
ALTER TABLE app.integration_connections
  ADD COLUMN unsuppressed_tools text[] NOT NULL DEFAULT '{}';
```

Plumb it exactly like `muted_tools`:

- `packages/integrations/src/repository.ts`: add `unsuppressedTools: readonly string[]` to `ConnectionRow` (~line 22), `UpdateConnectionInput` (~line 51), `ConnectionSqlRow` (~line 68), `SELECT_COLUMNS` (~line 79), an `updateConnection` patch branch mirroring lines 161-163, and `mapRow` (~line 239).
- `packages/shared/src/integrations-api.ts`: add `unsuppressedTools: readonly string[]` to `IntegrationDetail` (~line 42) and `unsuppressedTools?: readonly string[]` to `UpdateIntegrationRequest` (~line 68).
- `packages/integrations/src/routes.ts`: add to the detail-building object (~line 217) and the patch-parsing block (~line 287-288), mirroring `mutedTools` both times.

**`packages/integrations/src/tool-manifests.ts`** — `buildToolManifest`'s `execute` gains the `ctx` param, computes `action` from `tool.readOnly`, calls `callMemory.check(...)` before invoking the service, `callMemory.record(...)` after a real call, and returns the envelope either way.

**Test:** `tests/unit/integrations-call-memory.test.ts` — every rule above as its own case, plus: argument key-ordering canonicalizes to one key; empty-string `chatSessionId` bucket is per-user only (two different `actorUserId` with `chatSessionId: ""` never collide); expiry after the window; a blocked check never itself extends the window (only `record` does).

## Task 4 — Call ceiling and size budget

**`packages/integrations/src/limits.ts`** — add, retire the old cap:

```ts
export const INTEGRATION_CALL_CEILING = 12;
export const INTEGRATION_RESPONSE_CHAR_CAP = 8_000;
export const INTEGRATION_REQUEST_CHAR_BUDGET = 24_000;
// RESPONSE_CHAR_CAP (64_000) removed — retired per spec section 5: with 8,000 above it, it can never fire.
```

**`packages/integrations/src/call-memory.ts`** — counters live in the same store (milestone plan: "Task 4's counters live here too"), keyed by the same `CallMemoryScope`:

```ts
export interface CallMemory {
  // ...Task 3 members...
  /** true = admitted and counted; false = ceiling already reached, caller must refuse without counting. Call only for calls that will actually reach the service (post-suppression). */
  admitCall(scope: CallMemoryScope): boolean;
  /** Adds chars to the request's running total (measured pre-truncation, per spec section 5 step 7 — the size of what the service sent). Returns the total so far; caller compares to INTEGRATION_REQUEST_CHAR_BUDGET. */
  addResponseChars(scope: CallMemoryScope, chars: number): number;
}
```

**`packages/integrations/src/tool-manifests.ts`** — in `execute`, after a `check` returns `{ kind: "run" }`: call `admitCall`; if false, return the refusal envelope (`status: "error"`, `INTEGRATION_SUMMARY.requestRefused`) without calling the service. After a real call returns, measure the **pre-truncation** service payload length, truncate `detail` to `INTEGRATION_RESPONSE_CHAR_CAP` if over (summary becomes `INTEGRATION_SUMMARY.truncated`), then `addResponseChars` with the pre-truncation length; if the running total now exceeds `INTEGRATION_REQUEST_CHAR_BUDGET`, this call's own result still returns normally (it already happened) but subsequent calls in the burst get the same `requestRefused` envelope as the call ceiling.

**`packages/integrations/src/openapi-invoke.ts`** — remove the `RESPONSE_CHAR_CAP`/truncation logic (lines 67-68 and the `truncated` flag in the returned `data`); return the full parsed/text payload — capping now happens once, centrally, in `tool-manifests.ts`, covering MCP and OpenAPI alike. Leave `packages/ai/src/gateway/output-validation.ts`'s 16,000-char cut untouched (product-wide backstop, out of scope).

**Test:** `tests/unit/integrations-limits.test.ts` — boundary at exactly 8,000 (7999 untouched, 8000 untouched, 8001 truncated with the exact message); combined 24,000 budget crossing mid-burst (call N completes and returns real data even though it pushes the total over; call N+1 is refused); the 12-call ceiling (call 12 runs, call 13 is refused without reaching the service — assert the fake service's call count); a refusal is a normal envelope (`status: "error"`), never a thrown exception.

## Verification (unpiped, expected exit code shown)

```bash
pnpm lint > /tmp/tcd-lint.log 2>&1; echo "EXIT=$?"        # expect 0
pnpm typecheck > /tmp/tcd-tc.log 2>&1; echo "EXIT=$?"      # expect 0
pnpm test:unit > /tmp/tcd-unit.log 2>&1; echo "EXIT=$?"    # expect 0 (module-sdk-worker known-red locally)
```

`pnpm verify:foundation` only via the `verify-gate` skill, never unscoped, never piped.

## Kill gate (owner: Ben)

Unchanged from the milestone plan: on the live dev instance, "turn the kitchen light off" must make exactly one switch-off call and finish clearly under half the ~13s baseline. Ben makes the call from Task 10 steps 1 and 4's recorded proof, after Task 9 (out of this PR's scope) or with Task 9's speed win absent if the safety core alone already clears the bar — the milestone plan structures Task 10 as "prove whichever has landed," so this PR's own live proof is scoped to duplicate-suppression + ceiling, not to timing improvements that Tasks 7-9 own.

## Open items for coordinator approval

1. Confirm SQL migration number `0208` is free (no concurrent lane has claimed it).
2. Confirm the envelope's default success summaries (`"Action performed successfully."` / `"Read succeeded."`) are acceptable — the spec fixes the blocked/truncated/refused strings exactly but leaves the plain-success wording to the build (Determinism Boundary requires it be a fixed string, not model-authored, but doesn't dictate the words).
3. Confirm placing `MOSS_PERSONA_INTEGRATION_RESULT_TRUST` in `composeMossPersona` for every surface (not gated to `DEFAULT_CHAT_SURFACE` like the app-map block) — reasoning: integration tools are usable outside the default surface too.
