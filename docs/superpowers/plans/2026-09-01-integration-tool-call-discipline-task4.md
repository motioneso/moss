# Task 4 build plan — ceilings and size budget (#2175)

Scope: plan's Task 4 only. Locked numbers (do not re-litigate): 12 calls/request, 8,000 chars/response, 24,000 chars/request.

## Design decisions

- **Per-request scope key:** `actorUserId + requestId` (from `ToolContext.requestId`), not the
  30-second duplicate-suppression window in `call-memory.ts` (that's `actorUserId + chatSessionId`
  and outlives a single request). New store in `call-memory.ts`: `createRequestBudget()`, exposing
  `reserveCall(scope): boolean` (checks the 12-call ceiling and the 24,000-char budget, increments
  the call count only if it returns true) and `recordChars(scope, chars): void`. A short TTL
  (5 min) bounds memory growth; no product behavior depends on the TTL.
- **Order in `tool-manifests.ts` execute():** duplicate-suppression check first (unchanged from
  Task 3) → if it would actually call the service, `reserveCall` → if refused, return the
  `requestRefused` envelope (status "error", no service call) → else call the service, measure the
  raw response size in characters (`JSON.stringify` of the outcome data, before any truncation —
  this is "what the service sent", matching the spec's traffic-cost rationale), `recordChars` with
  that raw size, then truncate the detail to 8,000 chars if it exceeded that, setting the
  `truncated` summary. The call whose response crosses the 24,000 combined budget still completes;
  only the next call is refused.
- **Retiring the 64,000 cap:** delete `RESPONSE_CHAR_CAP` and its truncation logic from
  `openapi-invoke.ts` entirely (Step 5) — the proxy's 8,000 cap now covers both MCP and OpenAPI.
  Removes the one existing test that exercised the old 64k truncation
  (`tests/unit/integrations-openapi-invoke.test.ts`, "truncates a response body...").
- **Where the cap lives:** a small helper in `limits.ts`, `capChars(detail, cap)`, returning
  `{ detail, truncated, rawChars }` — used by `tool-manifests.ts` for both call paths, since MCP
  (`mcp-client.ts`) has no cap of its own today.
- Gateway's 16,000-char cut in `packages/ai/src/gateway/output-validation.ts` — untouched, per plan
  Step 6.

## Tests (`tests/unit/integrations-limits.test.ts`, new file)

- Response exactly at 8,000 chars is not truncated; one char over is, with the truncated summary.
- Combined per-request budget crossing mid-burst: the call that crosses it still returns data; the
  next call is refused.
- Call ceiling: the 13th call in a request is refused without hitting the service.
- A refusal is a normal envelope (`status: "error"`, `requestRefused` summary), not a thrown error.

No changes to Tasks 1-3 code beyond what Task 4 requires (removing the retired 64k cap import from
`openapi-invoke.ts`).
