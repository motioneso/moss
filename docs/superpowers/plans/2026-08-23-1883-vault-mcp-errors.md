# Vault-search MCP error detail (#1883)

Task issue: #1883. Spec: docs/superpowers/specs/2026-08-23-1883-vault-search-mcp-errors.md
(verified current against this branch — see seams below).

## Seams (file:line citations)

- Generic swallow point: `packages/ai/src/gateway/gateway.ts:635-647` `runHandler` catch-all —
  returns `{ ok:false, error: \`Tool ${found.dto.name} failed\` }`for every handler throw, no
cause detail, by design for #1251 hostile-throw safety. Protected by`tests/unit/mcp-gateway-recovery.test.ts:199-300`, which asserts a hostile `Proxy` thrown by a
handler is NEVER inspected (`trapCalls`must stay`0`).
- Existing trust boundary to gate on: `packages/module-registry/src/index.ts:2143-2149`
  `markBuiltInManifestTrusted` marks every built-in module's tools `isExternal: false` at load
  time. Tools constructed directly in tests (as in the Proxy safety test) leave `isExternal`
  `undefined`, so gating new logic on strict `=== false` leaves that safety test's behavior and
  assertions completely unchanged.
- Vault-search tool: `packages/notes/src/manifest.ts:100-109` `notes.search` (built-in ⇒
  `isExternal: false` at runtime — description: "Search the user's own ingested notes (Obsidian
  vault) by meaning"), execute at `packages/notes/src/tools.ts:34-62`, which calls
  `MemoryRetriever.retrieve` (`packages/memory/src/retrieval.ts:12-20`, default `sourceKind:
"vault"`) → an embedding provider (`packages/memory/src/local-embedding-provider.ts`, model
  fetch / local worker) and `MemoryRepository.vectorSearch` (DB).
- Existing safe-classification precedent for the same problem shape (network / timeout / HTTP
  status from a first-party dependency call), already reviewed and shipped:
  `packages/connectors/src/source-context/types.ts:145-176` `classifyLiveReadFailure`.
- `HttpError` (has `.statusCode`) already defined at `packages/module-sdk/src/route-errors.ts:12-20`
  and already imported in `gateway.ts:4`.
- MCP boundary that renders the text the client sees: `packages/chat/src/mcp-transport.ts:189-211`
  `gatewayResponseToMcp` forwards `res.error` verbatim as the MCP `content[0].text` — no change
  needed there; the new cause text rides through unmodified.
- Server-side log today: `gateway.ts:638-642` logs only `{toolName, requestId, errorClass}` — the
  original failure is not preserved anywhere, for any tool. Spec requires preserving it for logs.

## Design

New file `packages/ai/src/gateway/dependency-failure.ts`:

```ts
export type ToolDependencyCause =
  | "upstream_connection_refused"
  | "upstream_unreachable"
  | "upstream_timeout"
  | "upstream_http_error";

export function classifyToolDependencyFailure(error: unknown): ToolDependencyCause | null;
```

Behavior (mirrors `classifyLiveReadFailure`'s safe-inspection pattern):

- Caller-gated: only ever called on a throw from a tool where `isExternal === false` (first-party
  module code). That gate establishes trust in the _tool_, not in the _shape of what it throws_ —
  a first-party dependency (e.g. an embedding library) can still surface a hostile-shaped value
  (a `Proxy`, a getter that throws or returns garbage, a `cause` chain that is itself hostile).
  **The classifier must be safe against that regardless of the gate.**
- **Brand-check before touching anything — this is the actual fix for the coordinator's second
  fork.** A `try/catch` around a property read still _invokes_ a Proxy's `get`/`getPrototypeOf`
  trap before the throw is caught — that increments `trapCalls`, which the hostile-throw test
  asserts stays at `0`. Catching the throw is not enough; the trap call itself is the violation.
  The fix is to never perform a property read, `instanceof` check, or coercion on any value until
  it is confirmed to be a real native `Error` via a trap-free brand check —
  `require("node:util").types.isNativeError(value)`. That check inspects the value's internal V8
  class tag directly; it does not go through any proxy trap (`get`, `getPrototypeOf`,
  `getOwnPropertyDescriptor`, `ownKeys`, etc.), so calling it on a hostile Proxy costs zero trap
  calls and cannot throw.
  - Step 1: `isNativeError(error)`. If false, return `null` immediately — no other access of
    `error` of any kind.
  - Step 2: only once step 1 is true, read `error.code`, `error.name`, `error.statusCode`/`.status`
    (safe — a real native `Error` is a plain object with no traps).
  - Step 3: read `error.cause` (safe, same reason). Before touching anything on it, repeat step 1
    on the cause value: `isNativeError(cause)`. If false, treat the cause as absent — do not read
    `.code`/`.name` off it. If true, read `cause.code`/`cause.name` as in step 2.
  - The whole function is still additionally wrapped in one outer `try { ... } catch { return
null; }` as a second line of defense (belt-and-braces for any Node/V8 edge case), but the
    brand check is what actually keeps trap calls at zero — the try/catch alone does not.
- Reads only `.code`, `.name`, `.cause.code`, `.cause.name`, `.statusCode`/`.status`, each gated by
  its own `isNativeError` brand check per above — a closed set of short symbolic fields. Never
  touches `.message` or a stack, and never serializes or logs the value being classified.
- Values read are compared with `===`/`.includes` against fixed string constants only — never
  interpolated, logged, or returned. A read that produces something other than a short string/number
  (e.g. an object) is treated as unclassifiable, not coerced or stringified.
- `code`/`cause.code` `"ECONNREFUSED"` → `upstream_connection_refused`
- `code`/`cause.code` in `[ECONNRESET, ENOTFOUND, EAI_AGAIN, EPIPE, EHOSTUNREACH]` →
  `upstream_unreachable`
- `name`/`cause.name` `"AbortError"`, or `code`/`cause.code` in `[ETIMEDOUT,
UND_ERR_CONNECT_TIMEOUT, UND_ERR_HEADERS_TIMEOUT, UND_ERR_BODY_TIMEOUT]` → `upstream_timeout`
- `statusCode`/`status` numeric `>= 400` → `upstream_http_error`
- else, or on any exception during inspection → `null` (no classification; caller keeps today's
  generic message unchanged)

`gateway.ts` `runHandler` catch (line 635) changes:

- Gate strictly on `found.tool.isExternal === false`. This gate decides whether classification is
  _attempted at all_ — it does not change how the classifier or the log line inspects the thrown
  value. Both remain fully guarded (see below) so a first-party tool that throws a hostile-shaped
  value degrades to today's generic message, exactly like an ungated tool would.
- When gated: call `classifyToolDependencyFailure(error)` (internally total/guarded, per above —
  never throws). If non-null, the response error becomes `` `Tool ${found.dto.name} failed
(${cause})` ``; if null, unchanged `` `Tool ${found.dto.name} failed` ``.
- When gated: add to the existing `tool_handler_threw` log call a `cause` field (nullable) and an
  `errorName` field, both derived from the SAME `isNativeError`-gated inspection the classifier
  does — never a bare `error instanceof Error` at the call site. `instanceof` walks the prototype
  chain via `getPrototypeOf`, one of the trapped operations in the hostile-Proxy test, so it must
  never run on an unbranded value. Only after `isNativeError(error)` is true is `error.name` read
  for the log. If `isNativeError` is false, `errorName` is omitted entirely (not `"unknown"` or any
  derived string, and no further access of the value).
- When NOT gated (`isExternal !== false` — third-party/untrusted): zero change, identical to
  today's code — no call to the classifier, no `instanceof` check, no property access at all — so
  the Proxy hostile-throw test's `trapCalls === 0` assertion is untouched.

No change to `mcp-transport.ts` — see seam above.

## Test (red before fix)

New file `tests/unit/mcp-gateway-dependency-errors.test.ts`, gateway constructed the same way as
`tests/unit/mcp-gateway-units.test.ts:753` (`isExternal: false` tool), `execute` throwing:

- `Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(), { code:
"ECONNREFUSED" }) })` → expect `Tool <name> failed (upstream_connection_refused)`
- `new HttpError(503, "...")` → expect `Tool <name> failed (upstream_http_error)`
- `Object.assign(new Error(), { name: "AbortError" })` → expect `Tool <name> failed
(upstream_timeout)`
- a plain `new Error("boom")` (unclassifiable) → expect the UNCHANGED generic `Tool <name> failed`
  (no cause, no message leak)
- Assert `JSON.stringify(response)` never contains the literal thrown message text (`"fetch
failed"`, `"boom"`) — locks the "no raw exception dump" requirement.

**Hostile-shape cases, same `isExternal: false` tool** (this is the coordinator-flagged fork: a
first-party tool can still throw a non-first-party-shaped value):

- A top-level hostile `Proxy` — same trap set as `mcp-gateway-recovery.test.ts`'s Proxy (`get`,
  `getOwnPropertyDescriptor`, `getPrototypeOf`, `ownKeys` all throw and increment a `trapCalls`
  counter) thrown directly from the `isExternal: false` tool's `execute`. `isNativeError` on this
  value must be `false` without invoking any trap. Expect the UNCHANGED generic `Tool <name>
failed`, `trapCalls === 0`, and no rethrow/crash.
- A real `Error` whose `cause` is that same hostile Proxy (`Object.assign(new Error("boom"), {
cause: hostileProxy })`). The top-level value passes `isNativeError` (it's a real `Error`, so
  reading `.cause` off it is safe), but `isNativeError(cause)` must be `false` for the Proxy cause,
  and nothing on the cause may be read. Expect the UNCHANGED generic `Tool <name> failed`,
  `trapCalls === 0`, and `JSON.stringify(response)` contains neither `"boom"` nor the Proxy's
  sentinel property value.

This fails today (current code always returns the bare generic message, no `cause` suffix) and
passes after the fix. The hostile-shape cases must pass from the first version of the fix, not be
patched in after a review round finds them.

Re-run `tests/unit/mcp-gateway-recovery.test.ts` unmodified — must stay green (`trapCalls` stays
`0`), proving the existing untrusted (`isExternal !== false`) hostile-throw path is untouched.

## Live diagnosis (after the fix ships to dev)

Call the real `/api/mcp` `tools/call` for `notes.search` against the dev instance (a minted session
token, or through Moss chat) and read the surfaced `cause` to identify what's actually broken in
the current live outage. Record the finding in the PR — do not fix an unrelated dependency without
that evidence (spec non-goal).

## Verification

```bash
pnpm --filter @moss/ai test -- mcp-gateway-dependency-errors mcp-gateway-recovery mcp-gateway-units > /tmp/1883-unit.log 2>&1; echo "EXIT=$?"
```

Expected `EXIT=0`. Full gate via the `verify-gate` skill before wrap-up, not run ad hoc.

## Kill gate

If `notes.search`'s real dependency errors don't actually carry a `.code` / `.cause.code` / `.name`
/ `.statusCode` (e.g. `@huggingface/transformers` wraps the underlying network error into an opaque
shape with no symbolic fields), the classifier degrades to always-`null` and the fix is a no-op.
Owner: build agent — verify the real thrown error shape (read the library or reproduce locally)
during the red-test step, BEFORE finishing the fix. If the real shape doesn't classify, escalate to
the coordinator with the actual shape found rather than shipping a classifier that never fires.

Single-phase fix — no phase 2.
