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

- Caller-gated only: this function is only ever called on an error already known to originate from
  trusted first-party code (see gating rule below) — never on an unvalidated third-party throw.
- Reads only `.code`, `.name`, `.cause.code`, `.cause.name`, `.statusCode`/`.status` — a closed set
  of short symbolic fields. Never touches `.message` or a stack.
- `code`/`cause.code` `"ECONNREFUSED"` → `upstream_connection_refused`
- `code`/`cause.code` in `[ECONNRESET, ENOTFOUND, EAI_AGAIN, EPIPE, EHOSTUNREACH]` →
  `upstream_unreachable`
- `name`/`cause.name` `"AbortError"`, or `code`/`cause.code` in `[ETIMEDOUT,
  UND_ERR_CONNECT_TIMEOUT, UND_ERR_HEADERS_TIMEOUT, UND_ERR_BODY_TIMEOUT]` → `upstream_timeout`
- `statusCode`/`status` numeric `>= 400` → `upstream_http_error`
- else → `null` (no classification; caller keeps today's generic message unchanged)

`gateway.ts` `runHandler` catch (line 635) changes:

- Gate strictly on `found.tool.isExternal === false`.
- When gated: call `classifyToolDependencyFailure(error)`. If non-null, the response error becomes
  `` `Tool ${found.dto.name} failed (${cause})` ``; if null, unchanged
  `` `Tool ${found.dto.name} failed` ``.
- When gated: add to the existing `tool_handler_threw` log call a `cause` field (nullable) and,
  only when `error instanceof Error`, `errorName: error.name` (a symbolic tag such as `TypeError`
  or `HttpError` — never `.message`) — the safe, server-side-preserved trace the spec asks for.
- When NOT gated (`isExternal !== false` — third-party/untrusted): zero change, identical to
  today's code, so the Proxy hostile-throw test is untouched.

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

This fails today (current code always returns the bare generic message, no `cause` suffix) and
passes after the fix.

Re-run `tests/unit/mcp-gateway-recovery.test.ts` unmodified — must stay green (`trapCalls` stays
`0`), proving third-party/untrusted tools are untouched.

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
