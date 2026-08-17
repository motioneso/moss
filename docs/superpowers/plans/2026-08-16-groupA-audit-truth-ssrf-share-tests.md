# Plan — groupA: audit-outcome truth, host-fetch SSRF hardening, manage-share write tests

**Spec:** `docs/superpowers/specs/2026-08-16-post1632-groupA-audit-truth-ssrf-share-tests.md`
**Issues:** #1252, #946, #1490 — one PR, three independent phases, kill-gate after phase 1.
**Branch:** `groupA-audit-truth-ssrf-share-tests`

All three phases are independent (different packages, no shared files). Ordered by risk: #1252
first (only phase with an open design decision), then #946, then #1490.

---

## Phase 1 — #1252: audit outcome truth (`packages/ai/src/gateway/gateway.ts`)

### Decision: closed set of conventional error shapes + `error_class`

A payload counts as **module-reported error** iff, after `executeTool` returns and *before*
`sanitizeAssistantToolResult`/`renderAndCap` run, the raw `result.data` (`Record<string, unknown>`,
confirmed at `packages/module-sdk/src/index.ts:76-80`) matches any of:

1. `data.status === "error"` (exact string)
2. `data.ok === false` (exact boolean)
3. `typeof data.error === "string" && data.error.length > 0`

Only checked when `found.tool.isExternal !== false` (the existing external-tool test, already used
at gateway.ts:187,428) — first-party tools are never subject to this. `error_class` value on match:
`"module_reported"`.

**Why detection must run on the raw payload, not `structuredData`:** `sanitizeAssistantToolResult`
(`output-validation.ts:44-67`, via `sanitizeToolOutputObject` at `output-validation.ts:129-147`)
unconditionally allow-lists to schema-declared keys — any key not in `outputSchema.properties` is
dropped, no `additionalProperties` passthrough exists. If a module's `outputSchema` doesn't declare
`status`/`ok`/`error`, those fields would already be stripped by the time `structuredData` is built,
making detection on `structuredData` silently ineffective for exactly the payloads it needs to
catch. `structuredData` is otherwise unused today (grep confirms zero consumers outside
gateway.ts/types.ts) so this isn't a behavior-visible distinction — it's a correctness bug this plan
avoids introducing.

**Why `data` (the rendered `{text}` object, `renderAndCap` at `output-validation.ts:78-90`) is
unusable for detection:** it's always `{ text: string }` — never the original object shape.

### Signature change

`runHandler` (`gateway.ts:536-571`) currently returns `Promise<GatewayToolResponse>` and is called
at 3 sites (~218, ~257, ~678). Change its return type to a private, gateway-internal wrapper so the
public `GatewayToolResponse` envelope — and therefore everything MCP/route consumers see
(`packages/chat/src/mcp-transport.ts:195` reads only `res.data.text`) — is untouched:

```ts
type RunHandlerOutcome = {
  readonly response: GatewayToolResponse;
  readonly moduleReportedErrorClass: string | null;
};

private async runHandler(
  found: ExecutableTool,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<RunHandlerOutcome>
```

Detection helper (local, unexported, gateway.ts):

```ts
function detectModuleReportedError(payload: Record<string, unknown>): boolean
```

### Call-site changes (3 sites: ~218/230, ~257/270, ~678/689)

Each currently does:
```ts
const result = await this.runHandler(found, input, ctx);
...
void this.recordAudit(access, found, {
  outcome: result.ok ? "success" : "failed",
  errorClass: result.ok ? null : "handler_error",
  ...
});
return result;
```

Becomes:
```ts
const { response: result, moduleReportedErrorClass } = await this.runHandler(found, input, ctx);
...
void this.recordAudit(access, found, {
  outcome: result.ok && moduleReportedErrorClass === null ? "success" : "failed",
  errorClass: result.ok ? moduleReportedErrorClass : "handler_error",
  ...
});
return result;
```

All other uses of `result` (notifier.emit, `found.tool.affectsQueryKeys`, the final `return result`)
stay as `result` — only the destructuring line and the two `recordAudit` fields change. The catch
branch inside `runHandler` returns `{ response: { ok: false, error: ... }, moduleReportedErrorClass: null }`.

### Tests (unit, in `packages/ai/src` test tree — locate existing gateway.ts test file, extend it)

- External tool handler returns `{ status: "error", ... }` with `ok: true` → audit row asserts
  `outcome: "failed"`, `errorClass: "module_reported"`; model-visible envelope (`data.text`)
  unchanged from what the handler would have produced without this change.
- Same for `{ ok: false }` and `{ error: "message" }` shapes.
- External tool handler returns a normal success payload (none of the 3 shapes) → audit row still
  `outcome: "success"`, `errorClass: null`.
- First-party (`isExternal: false`) tool returning a payload that happens to contain
  `{ status: "error" }` in a schema-declared field → audit row unaffected (`outcome: "success"`) —
  proves the `isExternal !== false` gate.
- Handler throw path (existing `handler_error` case) unaffected — still `outcome: "failed"`,
  `errorClass: "handler_error"`.
- Regression: control test for a handler returning `{ ok: true, ... }` nested under a
  schema-declared key (not top-level) does NOT trip detection (only top-level shape matches, per
  the closed set — no recursion).

### Exit criteria (from spec, unchanged)

Regression test drives an external tool returning a conventional error-shape payload, audit row
records `failed` + `module_reported`; control test (normal success) still audits `success`;
first-party tool behavior unchanged; model-visible envelope asserted byte-identical to pre-change.

**Kill gate:** if extending `runHandler`'s return shape turns out to have a 4th caller not found
above (re-grep `this.runHandler(` before editing), stop and re-plan rather than widening scope —
report to Coordinator instead of improvising a broader refactor.

---

## Phase 2 — #946: SSRF BlockList hardening (`packages/host-fetch/src/index.ts`)

### BlockList fix (1 line)

Add to the ipv6 subnet list (`index.ts:142-154`, alongside the existing `["::", 128]` etc. entries):
```ts
["::ffff:0:0", 96],
```
This closes the gap: `isBlocked()` (`index.ts:376-380`) only regex-normalizes *dotted-form*
v4-mapped addresses (`::ffff:1.2.3.4`) before checking the ipv4 list; hex-form v4-mapped addresses
(e.g. `::ffff:a9fe:a9fe` = 169.254.169.254, the classic cloud-metadata SSRF target) fall through to
the raw ipv6 `BLOCKED.check`, which has no `::ffff:0:0/96` entry today. Adding the subnet directly
closes it regardless of literal form.

### Six tests, `tests/unit/host-pinned-fetch.test.ts`

1. **Hex-form v4-mapped literal** — extend the existing `it.each` blocked-DNS-answer table
   (`host-pinned-fetch.test.ts:37-44`) with `["hex-form v4-mapped IPv6 (metadata endpoint)",
   "::ffff:a9fe:a9fe", 6]`. Fails today (pre-fix) because no ipv6 subnet covers it; the one-line fix
   above makes it pass.
2. **Non-443 port** — `fetchFn("https://api.example.com:8443/data")` (or any port literal) →
   `rejects.toMatchObject({ code: "invalid_request" })`, asserting `validateUrl` (`index.ts:341-346`)
   rejects `url.port && url.port !== "443"` before any DNS/request call happens (assert
   `resolve`/`request` mocks never invoked, mirroring the existing blocked-address test's
   `requested` flag pattern).
3. **Userinfo in URL** — `fetchFn("https://user:pass@api.example.com/data")` →
   `invalid_request`, asserting `validateUrl`'s `url.username || url.password` check.
4. **Streaming size cap** — `request` mock streams an async iterator whose cumulative
   `byteLength` exceeds `maxResponseBytes` (pass a small `maxResponseBytes` option) →
   `rejects.toMatchObject({ code: "response_too_large" })`, asserting the accumulation loop
   (`index.ts:~231-240`) aborts mid-stream rather than buffering unbounded.
5. **Cross-origin redirect header wipe, incl. same-host different-port** — `request` mock
   returns a 302 with `location` pointing at (a) a different host and (b) the *same* hostname but a
   different port; assert the second hop's `headers` sent to `request` do **not** include a
   caller-supplied sensitive header (e.g. `authorization`) in both cases — proving `next.origin !==
   url.origin` (`index.ts:~219`) treats port as origin-significant (`URL.origin` includes port), not
   just hostname.
6. **Redirect-to-blocked re-validation** — `resolve` mock returns a public address on hop 0 and a
   blocked address (e.g. `169.254.169.254`) on hop 1 after a redirect; assert the second hop still
   throws `HostPinningViolationError` with `code: "blocked_address"` — proving `validateUrl` +
   `isBlocked` re-run every hop (`index.ts:189` is inside the `for (let hop = 0; ; ...)` loop), not
   just once before the loop.

### Exit criteria (from spec, unchanged)

All six tests green; each fails when its guard is knocked out — spot-verify at minimum test 1 (by
temporarily removing the `::ffff:0:0` entry) and test 6 (by temporarily moving `validateUrl` outside
the loop) per test-truthfulness discipline. No reachable-path behavior change (the only production
diff is the one BlockList line).

---

## Phase 3 — #1490: manage-share cross-owner write regression tests (`packages/tasks`)

**Tests only — no production code change**, per spec non-goal. If any new test finds the path is
NOT closed, stop and report to Coordinator rather than silently patching `repository.ts` (that would
turn a "prove it's fixed" phase into an undisclosed production change mid-plan).

### Where the 3 assertions live

File: `tests/integration/tasks.test.ts` (existing home of the #1055 cross-owner regression test at
line 814 — `git show d3c151928`; the later split commit `78d4d0574` only pulled `TaskDriftRepository`
into its own file, tasks.test.ts is still the right home for `TasksRepository.create()` regression
tests). Confirm no closer-fitting file exists before adding — none of `tasks-suggested-status.test.ts`,
`tasks-agency-tools.test.ts`, or `tasks-tools.test.ts` currently exercise `create()`'s idempotency
probe directly (spot-checked: they exercise higher-level routes/tools, not the repository).

### Why this differs from the existing #1055 test (line 814)

That test covers a `view`-level share — `create()` correctly makes B a *new* row instead of matching
A's. The regression risk #1490 targets is sharper: `app.tasks`'s `tasks_update` RLS policy
(`packages/tasks/sql/0019_tasks_owner_or_share.sql:33-51`) legitimately grants UPDATE to a
**`manage`**-level share holder (`owner_user_id = actor OR app.has_share('task', id, 'manage')`) —
so at the RLS layer, B genuinely *can* write to A's row through other code paths. The invariant under
test is that `create()`'s idempotency-resurface UPDATE branches (`repository.ts:219-241`,
`242-252`) can only ever be reached via `existing`, and `existing`'s query is owner-scoped
(`repository.ts:216`, the #1055/#1483 fix, commit `7fc432f39`) — so even a `manage` share, which
would pass `tasks_update`'s RLS check if reached, must never be reachable through this probe path at
all.

### Assertion 1 — manage-level share cannot cross-owner-UPDATE via the probe path

- A creates a task with `source: "sync"`, `externalKey: "sync:collide-1"`, `status: "suggested"`
  (or `"archived"`, to hit the archived→suggested branch at `repository.ts:219-241`).
- A grants B a `level: "manage"` share on it (`sharesRepository.grant`, same call shape as the
  existing test at line 822, `level: "manage"` instead of `"view"`).
- B calls `repository.create()` with the same `source`/`externalKey` and a `suggestionMetadata`
  that would trigger a resurface UPDATE if `existing` matched A's row.
- Assert: result is a **new row** (`result.id !== A's task id`, `result.owner_user_id === ids.userB`),
  not an update to A's row — proving the manage grant, despite being update-capable at the RLS
  layer, never lets `create()`'s probe treat A's row as B's `existing`.

### Assertion 2 — owner A's row is byte-untouched after B's `create()`

Immediately after assertion 1's `create()` call, re-fetch A's original task (as A) and assert every
column relevant to the resurface branches is unchanged: `title`, `status`, `suggestion_metadata`,
`updated_at` (`updated_at` specifically — an UPDATE would bump it even if other fields coincidentally
matched).

### Assertion 3 — worker-role coverage of the probe path, incl. fail-closed unset-context case

Both live call sites run under `jarvis_worker_runtime`, not `jarvis_app_runtime`:
`packages/connectors/src/monitor-jobs.ts:255-266` (`deps.taskPort.create`) and
`packages/module-registry/src/index.ts` `buildCalendarFollowThroughPort` (~734-742,
`tasksRepository.create`). Mirror `tasks-helpers.ts`'s existing worker-role connection pattern
(`handleNextTaskJob`, lines ~60-65: `createDatabase({ connectionString: connectionStrings.worker,
maxConnections: 1 })` + `new DataContextRunner(scopedWorkerDb)`) — add a `workerDataContext()`
helper to `tasks-helpers.ts` returning that runner, reused by this test:

- Positive: repeat assertion 1's scenario through the worker-role runner (same owner-scoped
  probe, same result) — proves `jarvis_worker_runtime`'s grants don't widen the RLS/probe
  interaction versus the app role.
- Fail-closed: call `repository.create()` on the worker-role instance with a bare non-`DataContextDb`
  object (`{} as never`, mirroring the existing app-role guard test at `tasks.test.ts:728-731`) and
  assert it throws `"Repository access requires withDataContext"` — proving the
  `assertDataContextDb` brand guard (which is what actually prevents an ungoverned/no-actor call
  from ever reaching SQL) holds for the worker-role-backed repository instance too, not just the
  app-role one already covered.

### Exit criteria (from spec, unchanged)

Tests fail on a codebase where the #1055 fix is reverted (verify by scratch-reverting the
owner-scoped `existing` probe filter at `repository.ts:216`, confirming assertions 1–2 go red, then
restoring) and pass on the current tree.

---

## Cross-phase invariants (from spec, unchanged)

- No lane touches `AccessContext`, adds a migration, or crosses a module boundary.
- Each PR/commit carries a release-note sentence, or states plainly it's not user-visible (#946 and
  #1490 are test-only hardening — not user-visible; #1252 is an audit-log correctness fix — not
  user-visible either, but worth a sentence for the security-audit trail).

## Verification (run after each phase, per `verify-gate` skill — never run `pnpm verify:foundation`
directly without it)

```bash
pnpm --filter @moss/ai test -- gateway            > /tmp/p1-ai-gateway.log 2>&1; echo "EXIT=$?"   # expect 0
pnpm --filter @moss/host-fetch test               > /tmp/p2-host-fetch.log 2>&1; echo "EXIT=$?"   # expect 0
# tests/unit and tests/integration are root-level, not package-filtered (per "root tests never run
# via package filter" memory) — use the verify-gate skill's scoped runner for tests/unit/host-pinned-fetch.test.ts
# and tests/integration/tasks.test.ts, never a raw `pnpm test` against the shared dev DB.
```

## Kill gate

**After Phase 1**, before starting Phase 2: if the `runHandler` return-shape change surfaces a
caller this plan didn't account for, or the detection helper needs to inspect anything beyond
top-level scalar/boolean checks (e.g. nested payload shapes), stop and report to Coordinator —
that's a scope change, not an implementation detail, and needs a decision before Phase 2/3 proceed.
Owner: Coordinator.
