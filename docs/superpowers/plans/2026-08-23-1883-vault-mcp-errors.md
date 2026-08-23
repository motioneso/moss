# Vault-search MCP error detail (#1883)

Task issue: #1883. Spec: docs/superpowers/specs/2026-08-23-1883-vault-search-mcp-errors.md
(verified current against this branch — see seams below).

## Seams (file:line citations)

- Generic swallow point: `packages/ai/src/gateway/gateway.ts:635-647` `runHandler` catch-all —
  returns `{ ok:false, error: \`Tool ${found.dto.name} failed\` }` for every handler throw, no
  cause detail, by design for #1251 hostile-throw safety. Protected by
  `tests/unit/mcp-gateway-recovery.test.ts:199-300`, which asserts a hostile `Proxy` thrown by a
  handler is NEVER inspected (`trapCalls` must stay `0`).
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
  module code). That gate establishes trust in the *tool*, not in the *shape of what it throws* —
  a first-party dependency (e.g. an embedding library) can still surface a hostile-shaped value
  (a `Proxy`, a getter that throws or returns garbage, a `cause` chain that is itself hostile).
  **The classifier must be safe against that regardless of the gate.**
- **Total inspection, never partial trust:** every property read, `instanceof` check, and
  `typeof`/coercion this function performs is wrapped so that if ANY of them throws for ANY reason,
  the function catches it and returns `null` immediately — same as an unclassifiable error. No
  step may rethrow, and no step's result is used before every prior step in the chain has
  succeeded. Concretely: wrap the whole body in one `try { ... } catch { return null; }`, and read
  `.cause` the same guarded way (a getter access is inside the same try). No separate unguarded
  pass over `.cause`.
- Reads only `.code`, `.name`, `.cause.code`, `.cause.name`, `.statusCode`/`.status` — a closed set
  of short symbolic fields. Never touches `.message` or a stack, and never serializes or logs the
  value being classified.
- Values read are compared with `===`/`.includes` against fixed string constants only — never
  interpolated, logged, or returned. A read that produces something other than a short string/number
  (e.g. an object, a thrown getter) is treated as unclassifiable, not coerced or stringified.
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
  *attempted at all* — it does not change how the classifier or the log line inspects the thrown
  value. Both remain fully guarded (see below) so a first-party tool that throws a hostile-shaped
  value degrades to today's generic message, exactly like an ungated tool would.
- When gated: call `classifyToolDependencyFailure(error)` (internally total/guarded, per above —
  never throws). If non-null, the response error becomes `` `Tool ${found.dto.name} failed
  (${cause})` ``; if null, unchanged `` `Tool ${found.dto.name} failed` ``.
- When gated: add to the existing `tool_handler_threw` log call a `cause` field (nullable) and an
  `errorName` field computed by the SAME guarded helper (or an equally try/catch-wrapped inline
  check) — note `error instanceof Error` itself calls `getPrototypeOf` on the value, one of the
  trapped operations in the hostile-Proxy test, so it must sit inside the same guarded block as the
  rest of the inspection, not called bare. On any exception, `errorName` is omitted (not `"unknown"`
  or any derived string).
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
  counter) thrown directly from the `isExternal: false` tool's `execute`. Expect the UNCHANGED
  generic `Tool <name> failed`, `trapCalls === 0`, and no rethrow/crash.
- A real `Error` whose `cause` is that same hostile Proxy (`Object.assign(new Error("boom"), {
  cause: hostileProxy })`). Expect the UNCHANGED generic `Tool <name> failed` (the top-level `Error`
  itself is safely `instanceof Error`, but its `cause` must never be touched unguarded), `trapCalls
  === 0`, and `JSON.stringify(response)` contains neither `"boom"` nor the Proxy's sentinel
  property value.

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
