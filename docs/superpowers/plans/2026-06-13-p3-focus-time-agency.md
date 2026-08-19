# Phase 3 — Focus-Time Agency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Jarvis its first real outbound-write agency win — a module-owned `calendar.proposeFocusBlock` assistant tool that, on an explicit Approve in the chat drawer, live-conflict-checks a desired window via Google freeBusy and inserts a Jarvis-tagged focus block on the user's primary Google Calendar — and apply the locked Phase-3 "Ritual" visual language to the web shell behind a human mockup sign-off gate.

**Architecture:** The feature rides the **existing** AssistantToolGateway write→confirm gate with **zero new policy** by declaring the tool `risk:"write"` (the gateway already maps non-`read` to `"confirm"`, creates a pending `action_request`, emits an Approve/Deny card, and blocks until resolved). The single structural problem — a `calendar` tool that must reach `connectors` (fresh token + Google I/O) without `calendar` importing `connectors` — is solved by a **generic tool-service injection seam**: an optional `requiresServices` manifest field, an optional 4th `services` argument on `ToolExecute`, and a flat `toolServices` registry on the gateway. The `CalendarWriteService` **interface is owned by `packages/calendar`**; its **implementation is built in `packages/chat`** (the composition host that may import both). The design-direction slice is presentation-only (CSS/JSX/static-HTML mockups) and stops at an explicit `AWAIT BEN'S MOCKUP SIGN-OFF` gate before any app-wide restyle.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Kysely + Postgres with RLS, Fastify REST, Vitest integration tests against `pnpm db:up` Postgres, in-process MCP gateway (ADR 0005), Google Calendar v3 REST (faked at the `fetch` boundary in tests), plain-CSS `var()` token model for the web shell, React + Vite + Playwright e2e.

---

## Hard dependency — read before starting

This slice **consumes** two artifacts from the **connector-sync slice**
(`docs/superpowers/plans/2026-06-13-p3-connector-sync-engine.md`):

1. **`GoogleApiClient`** — a plain class at `packages/connectors/src/google-api-client.ts`, exported from
   `packages/connectors/src/index.ts`, with an injectable `fetchFn?: typeof fetch`, a private
   `getJson<T>(url, accessToken, api)` helper, and a `GoogleApiError(message, statusCode)` class that
   **never** embeds a Google response body in `Error.message`. This slice **extends** it with two methods
   (`freeBusy`, `insertEvent`) plus a private `postJson` helper.
2. **`CalendarRepository.upsertCachedEvent(scopedDb, CreateCachedCalendarEventInput)`** — the idempotent
   upsert keyed on `UNIQUE(connector_account_id, external_id)`, and the calendar migration
   **`0065_calendar_worker_grants_and_google_insert.sql`** that relaxes the calendar INSERT policy to
   `provider_type IN ('calendar','google')` with a calendar-scope guard for the `'google'` branch.

**Build-order rule (Open risk #2 in the spec):** the connector-sync slice MUST be merged to `origin/main`
**before** Group B (Google client extension) and Group D (the impl) of this plan run, because those groups
import `GoogleApiClient`, `upsertCachedEvent`, and rely on migration 0065. Group A (the generic injection
seam) and Group C (pure propose logic + tool wrapper + manifest) have **no** connector-sync dependency and
may build first. **Before starting Group B, confirm at the shell:**

```bash
git -C ~/Jarv1s fetch origin && git -C ~/Jarv1s log origin/main --oneline | head -5
grep -rl "class GoogleApiClient" ~/Jarv1s/packages/connectors/src/
ls ~/Jarv1s/packages/calendar/sql/0065_calendar_worker_grants_and_google_insert.sql
grep -n "upsertCachedEvent" ~/Jarv1s/packages/calendar/src/repository.ts
```

If `GoogleApiClient`, the `0065` migration, or `upsertCachedEvent` are absent, **STOP Group B/D** and escalate
via `herdr-pane-message` to the connector-sync agent; build Groups A, C, and F (design-direction) while waiting.
The cache mirror degrades to `calendarMirror:"skipped-rls"` if 0065 is late, so it never blocks success.

**Grounding preflight (run once at the very start):**

```bash
pnpm audit:preflight   # must exit 0 (tree not behind origin/main); see CLAUDE.md Grounding Discipline
```

---

## Hard Invariants honored (do not weaken)

- **No new policy / write→confirm floor (ADR 0005 #3).** The tool is `risk:"write"`; it rides the existing
  un-skippable confirm gate. **No edit** to `packages/ai/src/gateway/policy.ts`, `gateway.ts`'s
  `confirmAndRun`/`resolveActionRequest`, or `confirmation-registry.ts`.
- **Secrets never escape.** The Google access/refresh token and OAuth client secret stay inside
  `packages/connectors`. `getFreshAccessToken` returns only a short-lived access token to the
  `CalendarWriteService`, which uses it for the immediate call and discards it. No token/secret reaches the
  tool input/output, the `action_request` summary, logs, a pg-boss payload (this slice enqueues none), the
  frontend, or an AI prompt. Google errors carry **no** response body in `Error.message`.
- **DataContextDb only.** Every DB touch goes through the branded `scopedDb` the gateway supplies via
  `withDataContext`; each repository calls `assertDataContextDb`. No root Kysely handle, no raw `fs`.
- **AccessContext shape.** The gateway builds `{ actorUserId, requestId }` only. The 4th `services` argument
  is a **separate capability channel**, never folded into AccessContext or ToolContext.
- **Module isolation.** `packages/calendar` does **not** import `packages/connectors`. The tool depends only
  on the `CalendarWriteService` interface it owns; the impl that touches connectors is built in
  `packages/chat` (the composition host, allowed to see both).
- **Never edit applied migrations; module SQL in the owning module's `sql/`.** This slice authors **no**
  migration of its own (it consumes connector-sync's 0065).
- **Provider-agnostic AI.** Focus-time involves **no** LLM/model call; the slot logic is deterministic.
- **Design-direction slice:** presentation-only — **no** new API fields, DB tables, migrations, pg-boss
  jobs, or module-internal coupling; `tokens.css` is the only CSS file permitted hex literals; the
  1000-line file cap is honored by splitting `styles.css`.

---

## File Structure

### Focus-time feature

**New files:**

| File                                              | Responsibility                                                                                                                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/calendar/src/focus-time.ts`             | Pure, I/O-free propose logic: `resolveWindow(input, now, tz)` and `chooseSlot(window, busyIntervals, durationMinutes)`. Unit-testable.                                                                                              |
| `packages/calendar/src/calendar-write-service.ts` | Interface-only: `FocusBlockWindow`, `ProposeFocusResult`, `CalendarWriteService`. Owned by calendar; imports only `@jarv1s/module-sdk`. No `@jarv1s/connectors`.                                                                    |
| `packages/chat/src/calendar-write-impl.ts`        | Concrete `CalendarWriteService` builder closing over `GoogleConnectionService`, `GoogleApiClient`, the connectors repository, and `CalendarRepository.upsertCachedEvent`. The only site that joins calendar logic to connector I/O. |
| `tests/integration/focus-time.test.ts`            | Integration suite: injection seam, scope check, impl happy/conflict/missing-scope/mirror-skip, and the no-write-without-approval safety property (full gateway path).                                                               |
| `packages/calendar/test/focus-time-logic.test.ts` | Unit tests for the pure `resolveWindow`/`chooseSlot` logic (no DB, no Postgres).                                                                                                                                                    |

**Modified files:**

| File                                           | Change                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/module-sdk/src/index.ts`             | Add `ToolServices` type, extend `ToolExecute` with optional 4th `services` arg, add `requiresServices?` to `ModuleAssistantToolManifest`.                                |
| `packages/ai/src/gateway/gateway.ts`           | Add `toolServices?: ToolServices` to deps; pass `this.deps.toolServices ?? {}` as the 4th arg in `runHandler`.                                                           |
| `packages/calendar/src/tools.ts`               | Add `calendarProposeFocusBlockExecute` (`ToolExecute`) and `summarizeProposeFocusBlock` (`ToolSummarize`).                                                               |
| `packages/calendar/src/manifest.ts`            | Add the `calendar.proposeFocusBlock` entry to `assistantTools`.                                                                                                          |
| `packages/calendar/src/index.ts`               | Export `focus-time.js` and `calendar-write-service.js`.                                                                                                                  |
| `packages/connectors/src/google-api-client.ts` | Add `freeBusy` + `insertEvent` methods, `GoogleFreeBusyResult`/`GoogleInsertedEvent` types, and a private `postJson` helper. (Created by connector-sync; extended here.) |
| `packages/connectors/src/repository.ts`        | Add `hasCalendarWriteScope(scopedDb)` (read-only, owner-scoped).                                                                                                         |
| `packages/chat/src/routes.ts`                  | Accept the connectors collaborators; build `calendar-write-impl`; register it as `toolServices.calendarWrite` on the gateway.                                            |
| `packages/chat/package.json`                   | Add `@jarv1s/connectors` and `@jarv1s/calendar` workspace deps.                                                                                                          |
| `packages/module-registry/src/index.ts`        | Plumb a `GoogleConnectionService` factory + `GoogleApiClient` from connectors down to `registerChatRoutes`.                                                              |
| `apps/api/src/server.ts`                       | Construct + pass the connectors collaborators into `BuiltInRouteDependencies`.                                                                                           |
| `package.json`                                 | Add a `test:focus-time` script wired into `verify:foundation`'s integration set (or confirm the existing integration glob already includes it).                          |

### Design-direction slice (presentation-only)

**New files:** `apps/web/src/styles/tokens.css`; `apps/web/src/ui/Card.tsx`, `Stack.tsx`, `SectionHeader.tsx`,
`Badge.tsx`, `TimeBucket.tsx`, `ProvisionalRegion.tsx`, `index.ts`; `docs/brand/mockups/briefing-reading.html`,
`tasks-day-buckets.html`, `settings-form.html`; `apps/web/src/briefings/briefing-reading-view.tsx` +
`briefings.css` (post-gate); `tests/e2e/briefing-reading.spec.ts` (post-gate).

**Modified files (post-gate only):** `apps/web/src/styles.css` (hex → tokens, split under 1000 lines),
`apps/web/src/main.tsx` (import `tokens.css` first), `apps/web/src/tasks/tasks.css`,
`apps/web/src/tasks/tasks-page.tsx`, and the coherent-pass pages (settings, chat drawer, notifications, auth).

---

# GROUP A — Generic tool-service injection seam (no connector-sync dependency)

Builds the additive, calendar-agnostic seam: a manifest field, a 4th `ToolExecute` arg, and a gateway
registry. Existing tools (which take 3 args) keep dispatching unchanged.

## Task A1: Add `ToolServices` + 4th `ToolExecute` arg + `requiresServices` to module-sdk

**Files:**

- Modify: `packages/module-sdk/src/index.ts:41-45` (`ToolExecute`), `:125-135` (`ModuleAssistantToolManifest`)
- Test: `tests/integration/focus-time.test.ts` (new file; this task adds the seam type-shape test)

- [ ] **Step 1: Write the failing test**

Create `tests/integration/focus-time.test.ts` with a type-and-dispatch test for the seam. This first test
only needs the module-sdk types to compile and a fake `ToolExecute` that reads a 4th arg:

```ts
import { describe, expect, it } from "vitest";
import type { ToolExecute, ToolServices, ModuleAssistantToolManifest } from "@jarv1s/module-sdk";

describe("Group A — tool-service injection seam (module-sdk types)", () => {
  it("a ToolExecute handler may accept a 4th services argument and read a named service", async () => {
    const handler: ToolExecute = async (_scopedDb, _input, _ctx, services?: ToolServices) => {
      const svc = (services ?? {}).demo as { ping: () => string } | undefined;
      return { data: { value: svc ? svc.ping() : "no-service" } };
    };
    const result = await handler(
      {},
      {},
      { actorUserId: "u", requestId: "r", chatSessionId: "s" },
      {
        demo: { ping: () => "pong" }
      }
    );
    expect(result.data.value).toBe("pong");
  });

  it("a 3-arg handler still satisfies ToolExecute (backwards compatible)", async () => {
    const legacy: ToolExecute = async (_scopedDb, _input, _ctx) => ({ data: { ok: true } });
    const result = await legacy({}, {}, { actorUserId: "u", requestId: "r", chatSessionId: "s" });
    expect(result.data.ok).toBe(true);
  });

  it("ModuleAssistantToolManifest accepts an optional requiresServices array", () => {
    const tool: ModuleAssistantToolManifest = {
      name: "demo.tool",
      description: "demo",
      permissionId: "demo.manage",
      risk: "write",
      requiresServices: ["demo"]
    };
    expect(tool.requiresServices).toEqual(["demo"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm typecheck`
Expected: FAIL — `ToolServices` is not exported (the `import type { ToolServices }` fails), and
`requiresServices` is not a known property of `ModuleAssistantToolManifest`. (Note: the failure is NOT
"too many arguments" — TypeScript permits extra args at a call site, and the typed `services?` PARAMETER
in the handler is what proves the contract; the missing `ToolServices` type is the load-bearing failure.
Codex LOW #11.)

- [ ] **Step 3: Write minimal implementation**

In `packages/module-sdk/src/index.ts`, replace the `ToolExecute` block (lines 41-45) with:

```ts
/**
 * Opaque per-call service registry handed to a tool's execute by the gateway. Keyed by
 * service name (e.g. "calendarWrite"); values are typed `unknown` to keep module-sdk free
 * of any module dependency (same reason scopedDb is `unknown`). The owning module narrows
 * the value it requested via its own type. Constructed by the composition host, never by a
 * module. The gateway treats it as opaque and never inspects its contents.
 */
export type ToolServices = Readonly<Record<string, unknown>>;

/**
 * Execution handler for an assistant tool. `scopedDb` is a DataContextDb supplied
 * by the gateway under withDataContext; it is typed as `unknown` here to avoid a
 * module-sdk -> db dependency. The owning module narrows it via its own repository.
 * `services` is an optional composition-layer-constructed capability registry (see
 * ToolServices); a tool that needs no service simply omits the 4th parameter.
 * Called ONLY when authorized (read allowed, or write/destructive approved); input
 * is already validated against inputSchema.
 */
export type ToolExecute = (
  scopedDb: unknown,
  input: ToolInput,
  ctx: ToolContext,
  services?: ToolServices
) => Promise<ToolResult>;
```

Then add `requiresServices` to `ModuleAssistantToolManifest` (after `summarize?` on line 134):

```ts
export interface ModuleAssistantToolManifest {
  readonly name: string;
  readonly description: string;
  readonly permissionId: string;
  readonly risk: ModuleAssistantToolRisk;
  readonly inputSchema?: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly featureFlagId?: string;
  readonly execute?: ToolExecute;
  readonly summarize?: ToolSummarize;
  /**
   * Names of composition-layer services this tool's execute requires in the 4th
   * `services` argument (e.g. ["calendarWrite"]). Declaration only — the module does
   * not construct the service. The composition host builds it and registers it on the
   * gateway's toolServices; a build-time/test assertion checks every declared key is present.
   */
  readonly requiresServices?: readonly string[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm typecheck && vitest run tests/integration/focus-time.test.ts`
Expected: PASS (all three Group A type tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/module-sdk/src/index.ts tests/integration/focus-time.test.ts
git commit -m "feat(module-sdk): add ToolServices + 4th ToolExecute arg + requiresServices (focus-time seam)"
```

## Task A2: Add `toolServices` to the gateway and pass it as the 4th arg

**Files:**

- Modify: `packages/ai/src/gateway/gateway.ts:21-29` (deps), `:96-111` (`runHandler` + new
  `servicesFor`), `:182-208` (`executableTools` fail-closed filter), `:4-10` (imports)
- Test: `tests/integration/focus-time.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/focus-time.test.ts`. This drives the real gateway with an in-memory fake module
whose `read` tool reads `services.demo`, asserting the registered service reaches `execute`, that an existing
3-arg tool still dispatches, and that the gateway treats `toolServices` as opaque:

```ts
import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type SessionNotifier
} from "@jarv1s/ai";
import { DataContextRunner, createDatabase, type JarvisDatabase } from "@jarv1s/db";
import type { Kysely } from "kysely";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import type { JarvisModuleManifest } from "@jarv1s/module-sdk";

describe("Group A — gateway passes toolServices as the 4th execute argument", () => {
  let appDb: Kysely<JarvisDatabase>;
  let dataContext: DataContextRunner;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
  });
  afterAll(async () => {
    await appDb.destroy();
  });

  function gatewayWith(modules: JarvisModuleManifest[], toolServices: Record<string, unknown>) {
    const tokens = new SessionTokenRegistry();
    const notifier: SessionNotifier = { emit() {} };
    const gateway = new AssistantToolGateway({
      resolveActiveModules: () => modules,
      repository: new AiRepository(),
      runner: dataContext,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier,
      confirmTimeoutMs: 150_000,
      toolServices
    });
    return { gateway, tokens };
  }

  // Helper: drive a write/destructive tool through the confirm gate with an Approve.
  async function callAndApprove(
    gateway: AssistantToolGateway,
    token: string,
    toolName: string,
    input: Record<string, unknown>
  ) {
    const callP = gateway.callTool(token, toolName, input);
    const actionId = await waitForPendingActionId(dataContext, ids.userA, toolName);
    await gateway.resolveActionRequest(ids.userA, actionId, "confirmed");
    return callP;
  }

  it("a WRITE tool declaring requiresServices receives the registered service (after approve)", async () => {
    const module: JarvisModuleManifest = {
      id: "demo",
      name: "Demo",
      version: "0",
      publisher: "t",
      lifecycle: "required",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantTools: [
        {
          name: "demo.ping",
          description: "d",
          permissionId: "demo.view",
          risk: "write",
          inputSchema: { type: "object", properties: {} },
          requiresServices: ["demo"],
          execute: async (_db, _i, _c, services) => {
            const svc = (services ?? {}).demo as { ping: () => string };
            return { data: { value: svc.ping() } };
          }
        }
      ]
    };
    const { gateway, tokens } = gatewayWith([module], { demo: { ping: () => "pong" } });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const res = await callAndApprove(gateway, token, "demo.ping", {});
    expect(res.ok).toBe(true);
    expect(res.ok && res.data.text).toContain("pong");
  });

  it("a legacy 3-arg read tool still dispatches when toolServices is empty", async () => {
    const module: JarvisModuleManifest = {
      id: "legacy",
      name: "Legacy",
      version: "0",
      publisher: "t",
      lifecycle: "required",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantTools: [
        {
          name: "legacy.read",
          description: "d",
          permissionId: "legacy.view",
          risk: "read",
          inputSchema: { type: "object", properties: {} },
          execute: async (_db, _i, _c) => ({ data: { ok: true } })
        }
      ]
    };
    const { gateway, tokens } = gatewayWith([module], {});
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const res = await gateway.callTool(token, "legacy.read", {});
    expect(res.ok).toBe(true);
  });

  it("a WRITE tool receives ONLY its declared services, never the whole registry (HIGH #1)", async () => {
    const module: JarvisModuleManifest = {
      id: "iso",
      name: "Iso",
      version: "0",
      publisher: "t",
      lifecycle: "required",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantTools: [
        {
          // declares "allowed" only — must NOT be able to see "secret"
          name: "iso.write",
          description: "d",
          permissionId: "iso.manage",
          risk: "write",
          inputSchema: { type: "object", properties: {} },
          requiresServices: ["allowed"],
          execute: async (_db, _i, _c, services) => {
            const s = services ?? {};
            return { data: { sawAllowed: "allowed" in s, sawSecret: "secret" in s } };
          }
        }
      ]
    };
    const { gateway, tokens } = gatewayWith([module], {
      allowed: { ok: () => "yes" },
      secret: { proposeAndInsert: () => "WOULD-WRITE" }
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const res = await callAndApprove(gateway, token, "iso.write", {});
    expect(res.ok).toBe(true);
    expect(res.ok && res.data.text).toContain('"sawAllowed":true');
    expect(res.ok && res.data.text).toContain('"sawSecret":false');
  });

  it("a READ tool NEVER receives an injected service, even if it declares one (HIGH #5)", async () => {
    // A read tool dispatches WITHOUT confirmAndRun; handing it a (possibly write-capable) service
    // would bypass the write→confirm floor. The gateway must hide it at listing AND withhold the
    // service if somehow invoked. Both are asserted here.
    const module: JarvisModuleManifest = {
      id: "sneaky",
      name: "Sneaky",
      version: "0",
      publisher: "t",
      lifecycle: "required",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantTools: [
        {
          name: "sneaky.read",
          description: "d",
          permissionId: "sneaky.view",
          risk: "read",
          inputSchema: { type: "object", properties: {} },
          requiresServices: ["writeCapable"],
          execute: async (_db, _i, _c, services) => ({
            data: { saw: "writeCapable" in (services ?? {}) }
          })
        }
      ]
    };
    const { gateway, tokens } = gatewayWith([module], {
      writeCapable: { proposeAndInsert: () => "WOULD-WRITE-NO-CONFIRM" }
    });
    // Hidden at listing (read tool declaring services is a misconfiguration).
    expect(
      gateway.listToolsForActor(ids.userA).find((t) => t.name === "sneaky.read")
    ).toBeUndefined();
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const res = await gateway.callTool(token, "sneaky.read", {});
    expect(res.ok).toBe(false); // not available — never reaches execute, never sees the service
  });

  it("a WRITE tool whose required service is NOT registered is not listed or invokable (HIGH #2)", async () => {
    const module: JarvisModuleManifest = {
      id: "needs",
      name: "Needs",
      version: "0",
      publisher: "t",
      lifecycle: "required",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantTools: [
        {
          name: "needs.tool",
          description: "d",
          permissionId: "needs.manage",
          risk: "write",
          inputSchema: { type: "object", properties: {} },
          requiresServices: ["absent"],
          execute: async () => ({ data: { ok: true } })
        }
      ]
    };
    const { gateway, tokens } = gatewayWith([module], {}); // "absent" not registered
    expect(
      gateway.listToolsForActor(ids.userA).find((t) => t.name === "needs.tool")
    ).toBeUndefined();
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const res = await gateway.callTool(token, "needs.tool", {});
    expect(res.ok).toBe(false); // "Tool not available" — fail closed, no execute reached
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm db:up && vitest run tests/integration/focus-time.test.ts -t "4th execute argument"`
Expected: FAIL — `toolServices` is not a known property of `AssistantToolGatewayDependencies`; the registered
service does not reach `execute` (the gateway still calls `found.execute(scopedDb, input, ctx)`); and the
read-tool-hiding / fail-closed-listing assertions fail because `servicesFor`/the `executableTools`
`requiresServices` filter do not yet exist. (These gateway tests touch Postgres via `dataContext`, like the
Group C/D tests — `waitForPendingActionId` is the shared helper defined later in the same file and hoists.)

- [ ] **Step 3: Write minimal implementation**

In `packages/ai/src/gateway/gateway.ts`, add `ToolServices` to the module-sdk import (line 4-10):

```ts
import type {
  JarvisModuleManifest,
  ModuleAssistantToolManifest,
  ToolContext,
  ToolExecute,
  ToolServices
} from "@jarv1s/module-sdk";
```

Add `toolServices` to `AssistantToolGatewayDependencies` (after `confirmTimeoutMs` on line 28):

```ts
export interface AssistantToolGatewayDependencies {
  readonly resolveActiveModules: ActiveModulesResolver;
  readonly repository: AiRepository;
  readonly runner: DataContextRunner;
  readonly tokens: SessionTokenRegistry;
  readonly confirmations: ConfirmationRegistry;
  readonly notifier: SessionNotifier;
  readonly confirmTimeoutMs: number;
  /**
   * Opaque, composition-layer-constructed service registry keyed by service name.
   * Passed verbatim as the 4th argument to every tool's execute. The gateway never
   * inspects it. A tool declares which keys it needs via manifest `requiresServices`.
   */
  readonly toolServices?: ToolServices;
}
```

Change `runHandler` (lines 96-111) so the `execute` call passes a **per-tool subset** of the
registry — only the keys the tool declared in `requiresServices`, never the whole registry. Two
security boundaries (both Hard-Invariant: the write→confirm floor):

1. **Per-tool subset (Codex HIGH #1):** a tool only ever sees the services it declared, never the
   whole registry, so it can't reach an undeclared write-capable service.
2. **Read tools NEVER receive injected services (Codex Round-2 HIGH #5):** `risk:"read"` tools
   dispatch via `runHandler` WITHOUT passing through `confirmAndRun`. If a read tool could hold a
   write-capable service it could write without an Approve — bypassing the floor. So `servicesFor`
   returns `{}` for any tool whose risk resolves to `"run"` (read). Services therefore only ever
   reach a handler that ran AFTER confirmation. This makes the floor structurally un-bypassable by a
   mistaken or hostile read-tool `requiresServices` declaration, without inventing a service-risk
   taxonomy. A read tool that declares `requiresServices` is also rejected at listing (see filter
   below), so this is belt-and-suspenders.

```ts
  /**
   * The subset of toolServices this tool declared via requiresServices — but ONLY for tools that
   * pass through the confirm gate. A read tool (risk → "run", no confirmation) receives NOTHING,
   * so no injected (potentially write-capable) service can be invoked without an Approve.
   */
  private servicesFor(tool: ModuleAssistantToolManifest): ToolServices {
    if (resolvePolicy(tool.risk) === "run") {
      return {}; // read path bypasses confirmAndRun — never hand it a service (write→confirm floor)
    }
    const registry = this.deps.toolServices ?? {};
    const keys = tool.requiresServices ?? [];
    const subset: Record<string, unknown> = {};
    for (const key of keys) {
      // executableTools already guaranteed every declared key is registered (fail-closed),
      // so this is always present here; guard defensively regardless.
      if (key in registry) subset[key] = registry[key];
    }
    return subset;
  }

  private async runHandler(
    found: ExecutableTool,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<GatewayToolResponse> {
    const access: AccessContext = { actorUserId: ctx.actorUserId, requestId: ctx.requestId };
    const services = this.servicesFor(found.tool);
    try {
      const result = await this.deps.runner.withDataContext(access, (scopedDb: DataContextDb) =>
        found.execute(scopedDb, input, ctx, services)
      );
      return { ok: true, data: { text: renderToolResult(result) } };
    } catch {
      // never leak internals/secrets from a handler throw
      return { ok: false, error: `Tool ${found.dto.name} failed` };
    }
  }
```

Fail-closed listing — in `executableTools` (lines 182-208), skip any tool whose `requiresServices`
keys are not ALL registered, so an unsatisfiable tool is never listed, confirmed, or invoked
(Codex HIGH #2 — otherwise a user could approve a `proposeFocusBlock` that then fails at execute
because `calendarWrite` was never wired). Add the guard right after the `typeof tool.execute` check:

```ts
if (typeof tool.execute !== "function") {
  continue;
}
const declaredServices = tool.requiresServices ?? [];
// Fail closed #1: a read tool must NOT declare services — a read dispatches without the
// confirm gate, so a write-capable service on a read tool would bypass the write→confirm
// floor. Such a manifest is a misconfiguration; hide it rather than risk a bypass (HIGH #5).
if (declaredServices.length > 0 && resolvePolicy(tool.risk) === "run") {
  continue;
}
// Fail closed #2: a tool whose required services we cannot satisfy is hidden — never
// listed and never confirmable. Prevents an approve→execute-fail dead-end (HIGH #2).
const registry = this.deps.toolServices ?? {};
const missing = declaredServices.filter((key) => !(key in registry));
if (missing.length > 0) {
  continue;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `vitest run tests/integration/focus-time.test.ts -t "4th execute argument"`
Expected: PASS (both gateway dispatch tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/gateway/gateway.ts tests/integration/focus-time.test.ts
git commit -m "feat(ai-gateway): pass opaque toolServices as 4th execute arg (focus-time seam)"
```

---

# GROUP B — Extend `GoogleApiClient` with freeBusy + insertEvent (REQUIRES connector-sync merged)

> **Gate:** run the Hard-dependency preflight above. If `packages/connectors/src/google-api-client.ts` does
> not exist, STOP and build Groups C and F first; escalate to the connector-sync agent.

## Task B1: Add `freeBusy` + `insertEvent` to `GoogleApiClient`

**Files:**

- Modify: `packages/connectors/src/google-api-client.ts` (add types + 2 methods + `postJson` helper)
- Test: `tests/integration/focus-time.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/focus-time.test.ts`. Fake Google at the `fetch` boundary (mirrors the
connector-sync `captureFetch` pattern):

```ts
import { GoogleApiClient } from "@jarv1s/connectors";

function captureFetch(
  reply: (url: string, init?: RequestInit) => { status?: number; body: unknown }
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = reply(url, init);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body)
    } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe("Group B — GoogleApiClient.freeBusy + insertEvent", () => {
  it("freeBusy posts to the freeBusy endpoint and returns busy intervals for primary", async () => {
    const { calls, fetchFn } = captureFetch(() => ({
      body: {
        calendars: {
          primary: { busy: [{ start: "2026-06-17T09:00:00Z", end: "2026-06-17T10:00:00Z" }] }
        }
      }
    }));
    const client = new GoogleApiClient({ fetchFn });
    const result = await client.freeBusy({
      accessToken: "tok",
      timeMin: "2026-06-17T09:00:00Z",
      timeMax: "2026-06-17T12:00:00Z",
      calendarId: "primary"
    });
    expect(calls[0]!.url).toContain("/freeBusy");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(result.busy).toEqual([{ start: "2026-06-17T09:00:00Z", end: "2026-06-17T10:00:00Z" }]);
  });

  it("insertEvent posts to the primary calendar events endpoint and returns the created id + htmlLink", async () => {
    const { calls, fetchFn } = captureFetch(() => ({
      body: { id: "evt-123", htmlLink: "https://calendar.google.com/evt-123" }
    }));
    const client = new GoogleApiClient({ fetchFn });
    const created = await client.insertEvent({
      accessToken: "tok",
      calendarId: "primary",
      summary: "Focus time",
      start: "2026-06-17T09:00:00Z",
      end: "2026-06-17T11:00:00Z",
      extendedPrivateProperties: { jarvisCreated: "true", jarvisTool: "proposeFocusBlock" }
    });
    expect(calls[0]!.url).toContain("/calendars/primary/events");
    expect(calls[0]!.init?.method).toBe("POST");
    const sentBody = JSON.parse(String(calls[0]!.init?.body));
    expect(sentBody.extendedProperties.private.jarvisCreated).toBe("true");
    expect(created.id).toBe("evt-123");
    expect(created.htmlLink).toBe("https://calendar.google.com/evt-123");
  });

  it("insertEvent throws a body-free GoogleApiError on a non-2xx", async () => {
    const { fetchFn } = captureFetch(() => ({
      status: 500,
      body: { error: "SECRET-INTERNAL-DETAIL" }
    }));
    const client = new GoogleApiClient({ fetchFn });
    await expect(
      client.insertEvent({
        accessToken: "tok",
        calendarId: "primary",
        summary: "x",
        start: "2026-06-17T09:00:00Z",
        end: "2026-06-17T11:00:00Z"
      })
    ).rejects.toThrow("Google calendar returned 500");
    await expect(
      client.insertEvent({
        accessToken: "tok",
        calendarId: "primary",
        summary: "x",
        start: "2026-06-17T09:00:00Z",
        end: "2026-06-17T11:00:00Z"
      })
    ).rejects.not.toThrow(/SECRET-INTERNAL-DETAIL/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/focus-time.test.ts -t "freeBusy + insertEvent"`
Expected: FAIL — `freeBusy` / `insertEvent` are not methods on `GoogleApiClient`.

- [ ] **Step 3: Write minimal implementation**

In `packages/connectors/src/google-api-client.ts`, add these types near `GoogleCalendarEvent`:

```ts
export interface GoogleBusyInterval {
  readonly start: string;
  readonly end: string;
}

export interface GoogleFreeBusyResult {
  readonly busy: GoogleBusyInterval[];
}

export interface GoogleInsertedEvent {
  readonly id: string;
  readonly htmlLink?: string;
}
```

Add the two methods inside the `GoogleApiClient` class (after `getMessage`, before the private `getJson`):

```ts
  async freeBusy(input: {
    accessToken: string;
    timeMin: string;
    timeMax: string;
    calendarId?: string;
  }): Promise<GoogleFreeBusyResult> {
    const calendarId = input.calendarId ?? "primary";
    const json = await this.postJson<{
      calendars?: Record<string, { busy?: GoogleBusyInterval[] }>;
    }>(
      `${CALENDAR_BASE}/freeBusy`,
      input.accessToken,
      {
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        items: [{ id: calendarId }]
      },
      "calendar"
    );
    return { busy: json.calendars?.[calendarId]?.busy ?? [] };
  }

  async insertEvent(input: {
    accessToken: string;
    calendarId?: string;
    summary: string;
    start: string;
    end: string;
    timeZone?: string;
    extendedPrivateProperties?: Record<string, string>;
  }): Promise<GoogleInsertedEvent> {
    const calendarId = input.calendarId ?? "primary";
    const body: Record<string, unknown> = {
      summary: input.summary,
      start: input.timeZone
        ? { dateTime: input.start, timeZone: input.timeZone }
        : { dateTime: input.start },
      end: input.timeZone
        ? { dateTime: input.end, timeZone: input.timeZone }
        : { dateTime: input.end }
    };
    if (input.extendedPrivateProperties) {
      body.extendedProperties = { private: input.extendedPrivateProperties };
    }
    const json = await this.postJson<GoogleInsertedEvent>(
      `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      input.accessToken,
      body,
      "calendar"
    );
    return { id: json.id, htmlLink: json.htmlLink };
  }
```

Add the private `postJson` helper next to `getJson` (same body-free error rule):

```ts
  private async postJson<T>(
    url: string,
    accessToken: string,
    body: unknown,
    api: string
  ): Promise<T> {
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      // Log status server-side only; NEVER embed the response body in Error.message —
      // handleRouteError propagates Error.message to HTTP responses (oauth.ts:122).
      this.logger.error({ statusCode: response.status, api }, "Google API call failed");
      throw new GoogleApiError(`Google ${api} returned ${response.status}`, response.status);
    }
    return (await response.json()) as T;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `vitest run tests/integration/focus-time.test.ts -t "freeBusy + insertEvent"`
Expected: PASS (all three method tests green, including the body-free error assertion).

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/google-api-client.ts tests/integration/focus-time.test.ts
git commit -m "feat(connectors): add GoogleApiClient.freeBusy + insertEvent for focus-time"
```

## Task B2: Add `hasCalendarWriteScope` to the connectors repository

**Files:**

- Modify: `packages/connectors/src/repository.ts` (add method after `getActiveGoogleAccountSecret`, ~line 274)
- Test: `tests/integration/focus-time.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/focus-time.test.ts`. Seed one google account with the calendar scope and one
without, asserting the scope check (run under each owner's RLS via `withDataContext`):

```ts
import { ConnectorsRepository, createConnectorSecretCipher } from "@jarv1s/connectors";

describe("Group B — hasCalendarWriteScope (owner-scoped, read-only)", () => {
  it("returns true when the active google account holds the calendar scope", async () => {
    const accountId = await seedGoogleAccount(ids.userA, [
      "https://www.googleapis.com/auth/calendar"
    ]);
    expect(accountId).toBeTruthy();
    const repo = new ConnectorsRepository();
    const has = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "test" },
      (scopedDb) => repo.hasCalendarWriteScope(scopedDb)
    );
    expect(has).toBe(true);
  });

  it("returns false when the active google account lacks the calendar scope", async () => {
    await seedGoogleAccount(ids.userB, ["https://www.googleapis.com/auth/gmail.modify"]);
    const repo = new ConnectorsRepository();
    const has = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "test" },
      (scopedDb) => repo.hasCalendarWriteScope(scopedDb)
    );
    expect(has).toBe(false);
  });

  it("returns false when there is no active google connection", async () => {
    // ids.adminUser is a seeded foundation user with NO google account in this suite — the honest
    // "no connection" actor. (test-database.ts seeds only userA/userB/adminUser; there is no userC.)
    const repo = new ConnectorsRepository();
    const has = await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "test" },
      (scopedDb) => repo.hasCalendarWriteScope(scopedDb)
    );
    expect(has).toBe(false);
  });
});
```

Add the `seedGoogleAccount` helper near the top of the file (inserts a real `app.connector_accounts` row via
`ConnectorsRepository.upsertGoogleAccount` under the owner's RLS, with an encrypted bundle so `has_secret` is
true — the bundle contents are never read by the scope check):

```ts
async function seedGoogleAccount(ownerId: string, scopes: string[]): Promise<string> {
  const cipher = createConnectorSecretCipher();
  const repo = new ConnectorsRepository();
  const account = await dataContext.withDataContext(
    { actorUserId: ownerId, requestId: "seed" },
    (scopedDb) =>
      repo.upsertGoogleAccount(scopedDb, {
        scopes,
        encryptedSecret: cipher.encryptJson({
          kind: "google-oauth",
          clientId: "cid",
          clientSecret: "csecret",
          accessToken: "atoken",
          refreshToken: "rtoken",
          tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
          grantedScopes: scopes
        })
      })
  );
  return account.id;
}
```

> Note: `createConnectorSecretCipher` requires `JARVIS_CONNECTOR_SECRET_KEY` (or the test default). Set it in
> the suite's `beforeAll` exactly as `connectors-google.test.ts` does — read that file's `beforeAll` for the
> precise env var name and value, and mirror it. The foundation seed provides exactly `ids.userA`,
> `ids.userB`, and `ids.adminUser` (no `userC`); the "no active connection" case uses `ids.adminUser` (a
> seeded user with no google account in this suite).

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/focus-time.test.ts -t "hasCalendarWriteScope"`
Expected: FAIL — `hasCalendarWriteScope` is not a method on `ConnectorsRepository`.

- [ ] **Step 3: Write minimal implementation**

In `packages/connectors/src/repository.ts`, add after `getActiveGoogleAccountSecret` (~line 274):

```ts
  /**
   * Read-only, owner-scoped check: does the active google account hold the calendar
   * write scope? Reads `accounts.scopes` (already owner-RLS-scoped). Returns false when
   * there is no active google account. Never decrypts the secret bundle.
   */
  async hasCalendarWriteScope(scopedDb: DataContextDb): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.connector_accounts")
      .select("scopes")
      .where("provider_id", "=", GOOGLE_PROVIDER_ID)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!row) return false;
    return row.scopes.includes("https://www.googleapis.com/auth/calendar");
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `vitest run tests/integration/focus-time.test.ts -t "hasCalendarWriteScope"`
Expected: PASS (all three scope tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/repository.ts tests/integration/focus-time.test.ts
git commit -m "feat(connectors): add owner-scoped hasCalendarWriteScope read for focus-time"
```

---

# GROUP C — Pure propose logic + tool wrapper + manifest (no connector-sync dependency)

## Task C1: Pure `resolveWindow` + `chooseSlot` in `focus-time.ts`

**Files:**

- Create: `packages/calendar/src/focus-time.ts`
- Test: `packages/calendar/test/focus-time-logic.test.ts` (new; pure unit, no DB)

- [ ] **Step 1: Write the failing test**

Create `packages/calendar/test/focus-time-logic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveWindow, chooseSlot, type FocusBlockInput } from "../src/focus-time.js";

const TZ = "America/New_York";
// Fixed "now": 2026-06-16T12:00:00Z (a Tuesday). "tomorrow" = 2026-06-17.
const NOW = new Date("2026-06-16T12:00:00Z");

describe("resolveWindow", () => {
  it("morning maps to 09:00–12:00 local on the given date", () => {
    const w = resolveWindow(
      { date: "2026-06-17", partOfDay: "morning", durationMinutes: 120 },
      NOW,
      TZ
    );
    // 09:00 America/New_York on 2026-06-17 is 13:00Z (EDT, UTC-4).
    expect(w.start.toISOString()).toBe("2026-06-17T13:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-06-17T16:00:00.000Z");
  });

  it("afternoon maps to 12:00–17:00, evening to 17:00–21:00 local", () => {
    const a = resolveWindow(
      { date: "2026-06-17", partOfDay: "afternoon", durationMinutes: 60 },
      NOW,
      TZ
    );
    expect(a.start.toISOString()).toBe("2026-06-17T16:00:00.000Z"); // 12:00 EDT
    const e = resolveWindow(
      { date: "2026-06-17", partOfDay: "evening", durationMinutes: 60 },
      NOW,
      TZ
    );
    expect(e.start.toISOString()).toBe("2026-06-17T21:00:00.000Z"); // 17:00 EDT
  });

  it("defaults date to tomorrow when only partOfDay is given", () => {
    const w = resolveWindow({ partOfDay: "morning", durationMinutes: 120 }, NOW, TZ);
    expect(w.start.toISOString()).toBe("2026-06-17T13:00:00.000Z");
  });

  it("an explicit start sets a window of start..start+duration", () => {
    const w = resolveWindow({ start: "2026-06-17T18:00:00.000Z", durationMinutes: 90 }, NOW, TZ);
    expect(w.start.toISOString()).toBe("2026-06-17T18:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-06-17T19:30:00.000Z");
  });

  it("clamps duration to 15..480 and defaults title to 'Focus time'", () => {
    const lo = resolveWindow({ partOfDay: "morning", durationMinutes: 5 }, NOW, TZ);
    expect(lo.durationMinutes).toBe(15);
    const hi = resolveWindow({ partOfDay: "morning", durationMinutes: 9000 }, NOW, TZ);
    expect(hi.durationMinutes).toBe(480);
    expect(lo.title).toBe("Focus time");
  });

  it("rejects a malformed start and a malformed date (handler-side validation, Codex MED #5)", () => {
    expect(() => resolveWindow({ start: "not-a-date", durationMinutes: 60 }, NOW, TZ)).toThrow(
      /valid RFC3339/
    );
    expect(() => resolveWindow({ date: "06/17/2026", partOfDay: "morning" }, NOW, TZ)).toThrow(
      /yyyy-mm-dd/
    );
  });

  it("rejects a well-formed but impossible calendar date (overflow, Codex LOW #20)", () => {
    // Date.UTC would silently normalize 2026-99-99 to a real date; resolveWindow must reject it.
    expect(() => resolveWindow({ date: "2026-99-99", partOfDay: "morning" }, NOW, TZ)).toThrow(
      /not a valid calendar date/
    );
    expect(() => resolveWindow({ date: "2026-02-30", partOfDay: "morning" }, NOW, TZ)).toThrow(
      /not a valid calendar date/
    );
  });
});

describe("chooseSlot", () => {
  const window = {
    start: new Date("2026-06-17T13:00:00Z"),
    end: new Date("2026-06-17T16:00:00Z"),
    durationMinutes: 120,
    title: "Focus time"
  };

  it("returns the requested slot unshifted when the window is clear", () => {
    const r = chooseSlot(window, [], 120);
    expect(r.conflict).toBe("none");
    expect(r.shifted).toBe(false);
    expect(r.start.toISOString()).toBe("2026-06-17T13:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-06-17T15:00:00.000Z");
  });

  it("shifts forward past a busy interval to the next clear slot in the window", () => {
    const busy = [{ start: "2026-06-17T13:00:00Z", end: "2026-06-17T13:30:00Z" }];
    const r = chooseSlot(window, busy, 120);
    expect(r.conflict).toBe("shifted");
    expect(r.shifted).toBe(true);
    expect(r.start.toISOString()).toBe("2026-06-17T13:30:00.000Z");
    expect(r.end.toISOString()).toBe("2026-06-17T15:30:00.000Z");
  });

  it("returns no-clear-slot when the window cannot fit the duration", () => {
    const busy = [{ start: "2026-06-17T13:00:00Z", end: "2026-06-17T16:00:00Z" }];
    const r = chooseSlot(window, busy, 120);
    expect(r.conflict).toBe("no-clear-slot");
    expect(r.shifted).toBe(false);
  });

  it("chooses an exact-fit gap between two busy intervals", () => {
    const busy = [
      { start: "2026-06-17T13:00:00Z", end: "2026-06-17T13:30:00Z" },
      { start: "2026-06-17T15:30:00Z", end: "2026-06-17T16:00:00Z" }
    ];
    const r = chooseSlot(window, busy, 120);
    expect(r.conflict).toBe("shifted");
    expect(r.start.toISOString()).toBe("2026-06-17T13:30:00.000Z");
    expect(r.end.toISOString()).toBe("2026-06-17T15:30:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run packages/calendar/test/focus-time-logic.test.ts`
Expected: FAIL — `../src/focus-time.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `packages/calendar/src/focus-time.ts`:

```ts
export type PartOfDay = "morning" | "afternoon" | "evening";

export interface FocusBlockInput {
  readonly date?: string; // ISO yyyy-mm-dd, local
  readonly partOfDay?: PartOfDay;
  readonly start?: string; // ISO datetime
  readonly durationMinutes?: number;
  readonly title?: string;
}

export interface ResolvedWindow {
  readonly start: Date;
  readonly end: Date;
  readonly durationMinutes: number;
  readonly title: string;
}

export interface SlotChoice {
  readonly start: Date;
  readonly end: Date;
  readonly shifted: boolean;
  readonly conflict: "none" | "shifted" | "no-clear-slot";
}

const MIN_DURATION = 15;
const MAX_DURATION = 480;
const DEFAULT_DURATION = 120;
const DEFAULT_TITLE = "Focus time";

// Local-time part-of-day bands [startHour, endHour) in the calendar's timezone.
const BANDS: Record<PartOfDay, { startHour: number; endHour: number }> = {
  morning: { startHour: 9, endHour: 12 },
  afternoon: { startHour: 12, endHour: 17 },
  evening: { startHour: 17, endHour: 21 }
};

function clampDuration(d: number | undefined): number {
  const v = typeof d === "number" && Number.isFinite(d) ? Math.trunc(d) : DEFAULT_DURATION;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, v));
}

/**
 * Returns the UTC offset (minutes) of `tz` at instant `at`, by comparing the wall-clock
 * the zone reports against the same fields read as UTC. Positive = east of UTC.
 */
function tzOffsetMinutes(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = dtf.formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Builds the UTC Date for wall-clock yyyy-mm-dd HH:00 local in `tz`. */
function localWallClockToUtc(dateIso: string, hour: number, tz: string): Date {
  const [y, m, d] = dateIso.split("-").map(Number);
  // First approximation assuming UTC, then correct by the zone offset at that instant.
  const naiveUtc = Date.UTC(y, m - 1, d, hour, 0, 0);
  const offset = tzOffsetMinutes(tz, new Date(naiveUtc));
  return new Date(naiveUtc - offset * 60_000);
}

/** yyyy-mm-dd of `at` in `tz`. */
function localDateString(at: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return dtf.format(at); // en-CA yields yyyy-mm-dd
}

function addDaysLocal(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class FocusBlockInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FocusBlockInputError";
  }
}

export function resolveWindow(input: FocusBlockInput, now: Date, tz: string): ResolvedWindow {
  const durationMinutes = clampDuration(input.durationMinutes);
  const title = input.title?.trim() ? input.title.trim() : DEFAULT_TITLE;

  // Handler-side validation: the gateway validator does NOT enforce format/pattern (issue #133),
  // so reject a malformed start/date HERE — before any approval card or Google call (Codex MED #5).
  if (input.start) {
    const start = new Date(input.start);
    if (Number.isNaN(start.getTime())) {
      throw new FocusBlockInputError("start must be a valid RFC3339 datetime");
    }
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    return { start, end, durationMinutes, title };
  }

  if (input.date !== undefined) {
    if (!DATE_RE.test(input.date)) {
      throw new FocusBlockInputError("date must be in yyyy-mm-dd format");
    }
    // DATE_RE only checks shape; Date.UTC NORMALIZES overflow (2026-99-99 → a real later date),
    // so reject any date whose components don't ROUND-TRIP (Codex LOW #20).
    const [y, m, d] = input.date.split("-").map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
      throw new FocusBlockInputError("date is not a valid calendar date");
    }
  }
  const part = input.partOfDay ?? "morning";
  const band = BANDS[part];
  const dateIso = input.date ?? addDaysLocal(localDateString(now, tz), 1);
  const start = localWallClockToUtc(dateIso, band.startHour, tz);
  const end = localWallClockToUtc(dateIso, band.endHour, tz);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new FocusBlockInputError("date is not a valid calendar date");
  }
  return { start, end, durationMinutes, title };
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

export function chooseSlot(
  window: ResolvedWindow,
  busy: ReadonlyArray<{ start: string; end: string }>,
  durationMinutes: number,
  options: { stepMinutes?: number } = {}
): SlotChoice {
  const step = (options.stepMinutes ?? 15) * 60_000;
  const durMs = durationMinutes * 60_000;
  const winStart = window.start.getTime();
  const winEnd = window.end.getTime();

  const intervals: Interval[] = busy
    .map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
    .filter((b) => b.end > winStart && b.start < winEnd)
    .sort((a, b) => a.start - b.start);

  const overlaps = (s: number, e: number): boolean =>
    intervals.some((b) => b.start < e && b.end > s);

  for (let candidate = winStart; candidate + durMs <= winEnd; candidate += step) {
    const candEnd = candidate + durMs;
    if (!overlaps(candidate, candEnd)) {
      const shifted = candidate !== winStart;
      return {
        start: new Date(candidate),
        end: new Date(candEnd),
        shifted,
        conflict: shifted ? "shifted" : "none"
      };
    }
  }

  return {
    start: window.start,
    end: new Date(winStart + durMs),
    shifted: false,
    conflict: "no-clear-slot"
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `vitest run packages/calendar/test/focus-time-logic.test.ts`
Expected: PASS (all `resolveWindow` + `chooseSlot` cases green, including the non-UTC `America/New_York`
mapping — Open risk #3, timezone correctness).

- [ ] **Step 5: Commit**

```bash
git add packages/calendar/src/focus-time.ts packages/calendar/test/focus-time-logic.test.ts
git commit -m "feat(calendar): pure resolveWindow + chooseSlot focus-time logic (tz-aware)"
```

## Task C2: `CalendarWriteService` interface (calendar-owned, no connectors import)

**Files:**

- Create: `packages/calendar/src/calendar-write-service.ts`
- Modify: `packages/calendar/src/index.ts`
- Test: `packages/calendar/test/focus-time-logic.test.ts` (add a type-shape assertion)

- [ ] **Step 1: Write the failing test**

Append to `packages/calendar/test/focus-time-logic.test.ts`:

```ts
import type {
  CalendarWriteService,
  FocusBlockWindow,
  ProposeFocusResult
} from "../src/calendar-write-service.js";

describe("CalendarWriteService interface shape", () => {
  it("a fake impl satisfies the interface and returns a ProposeFocusResult", async () => {
    const fake: CalendarWriteService = {
      async proposeAndInsert(_scopedDb, _ctx, window: FocusBlockWindow) {
        const result: ProposeFocusResult = {
          created: true,
          resolvedStart: window.start.toISOString(),
          resolvedEnd: window.end.toISOString(),
          shifted: false,
          conflict: "none",
          googleEventId: "evt-1",
          calendarMirror: "written"
        };
        return result;
      }
    };
    const res = await fake.proposeAndInsert(
      {},
      { actorUserId: "u", requestId: "r", chatSessionId: "s" },
      {
        start: new Date("2026-06-17T13:00:00Z"),
        end: new Date("2026-06-17T15:00:00Z"),
        durationMinutes: 120,
        title: "Focus time"
      }
    );
    expect(res.created).toBe(true);
    expect(res.calendarMirror).toBe("written");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run packages/calendar/test/focus-time-logic.test.ts -t "CalendarWriteService interface shape"`
Expected: FAIL — `../src/calendar-write-service.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `packages/calendar/src/calendar-write-service.ts`:

```ts
import type { ToolContext } from "@jarv1s/module-sdk";

export interface FocusBlockWindow {
  readonly start: Date;
  readonly end: Date;
  /**
   * The REQUESTED block length in minutes (already clamped to 15..480 by resolveWindow).
   * Load-bearing: `start`..`end` is the SEARCH WINDOW (e.g. the whole morning band), not
   * the block length. The impl must insert a block of `durationMinutes`, NOT (end - start).
   * Dropping this field silently turns "2 hours tomorrow morning" into a 3-hour band block.
   */
  readonly durationMinutes: number;
  readonly title: string;
}

export interface ProposeFocusResult {
  readonly created: boolean;
  readonly resolvedStart: string; // ISO
  readonly resolvedEnd: string; // ISO
  readonly shifted: boolean;
  readonly conflict: "none" | "shifted" | "no-clear-slot";
  readonly googleEventId?: string;
  readonly calendarMirror: "written" | "skipped-rls" | "skipped-error";
  /** Human-facing reason when created=false (e.g. re-consent, no connection). Never a secret. */
  readonly message?: string;
}

/**
 * The contract the calendar focus-time tool depends on. OWNED BY packages/calendar so no
 * connectors import leaks into the calendar module. The concrete implementation is built
 * in the composition host (packages/chat), which is allowed to import connectors. The tool
 * narrows the injected `services.calendarWrite` to this interface.
 */
export interface CalendarWriteService {
  proposeAndInsert(
    scopedDb: unknown, // DataContextDb; calendar/impl narrows via assertDataContextDb
    ctx: ToolContext,
    window: FocusBlockWindow
  ): Promise<ProposeFocusResult>;
}
```

Add exports to `packages/calendar/src/index.ts`:

```ts
export * from "./manifest.js";
export * from "./repository.js";
export * from "./routes.js";
export * from "./focus-time.js";
export * from "./calendar-write-service.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `vitest run packages/calendar/test/focus-time-logic.test.ts -t "CalendarWriteService interface shape" && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/calendar/src/calendar-write-service.ts packages/calendar/src/index.ts packages/calendar/test/focus-time-logic.test.ts
git commit -m "feat(calendar): add calendar-owned CalendarWriteService interface (no connectors import)"
```

## Task C3: `proposeFocusBlock` tool handler + summarize, registered on the manifest

**Files:**

- Modify: `packages/calendar/src/tools.ts`, `packages/calendar/src/manifest.ts`
- Test: `tests/integration/focus-time.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/focus-time.test.ts`. Register the calendar module with a **fake**
`calendarWrite` service in `toolServices` and drive the full gateway with an Approve — assert the tool resolves
the window, calls the service, and surfaces the resolved time. Also assert `summarize` produces card text:

```ts
import { calendarModuleManifest } from "@jarv1s/calendar";
import type { ProposeFocusResult } from "@jarv1s/calendar";

describe("Group C — calendar.proposeFocusBlock tool wiring", () => {
  it("summarize renders requested-window card text mentioning the next-clear-slot caveat", () => {
    const tool = calendarModuleManifest.assistantTools!.find(
      (t) => t.name === "calendar.proposeFocusBlock"
    );
    expect(tool).toBeTruthy();
    expect(tool!.risk).toBe("write");
    expect(tool!.permissionId).toBe("calendar.manage");
    expect(tool!.requiresServices).toEqual(["calendarWrite"]);
    const text = tool!.summarize!(
      { partOfDay: "morning", durationMinutes: 120, title: "Deep work" },
      { actorUserId: "u", requestId: "r", chatSessionId: "s" }
    );
    expect(text).toMatch(/Deep work/);
    expect(text).toMatch(/next clear slot/i);
  });

  it("on approve, execute resolves a window and delegates to services.calendarWrite", async () => {
    let captured: { start: Date; end: Date; durationMinutes: number; title: string } | null = null;
    const fakeService = {
      async proposeAndInsert(
        _db: unknown,
        _ctx: unknown,
        window: { start: Date; end: Date; durationMinutes: number; title: string }
      ) {
        captured = window;
        const r: ProposeFocusResult = {
          created: true,
          resolvedStart: window.start.toISOString(),
          resolvedEnd: window.end.toISOString(),
          shifted: false,
          conflict: "none",
          googleEventId: "evt-xyz",
          calendarMirror: "skipped-rls"
        };
        return r;
      }
    };

    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const notifier: SessionNotifier = { emit() {} };
    const gateway = new AssistantToolGateway({
      resolveActiveModules: () => [calendarModuleManifest],
      repository: new AiRepository(),
      runner: dataContext,
      tokens,
      confirmations,
      notifier,
      confirmTimeoutMs: 150_000,
      toolServices: { calendarWrite: fakeService }
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });

    const callPromise = gateway.callTool(token, "calendar.proposeFocusBlock", {
      partOfDay: "morning",
      durationMinutes: 120,
      title: "Deep work"
    });
    // Approve the pending action once it has been created.
    const actionId = await waitForPendingActionId(dataContext, ids.userA);
    await gateway.resolveActionRequest(ids.userA, actionId, "confirmed");
    const res = await callPromise;

    expect(res.ok).toBe(true);
    expect(captured).not.toBeNull();
    // The seam must carry the REQUESTED duration (120m), not the band width (Codex HIGH #3).
    expect(captured!.durationMinutes).toBe(120);
    expect(res.ok && res.data.text).toContain("evt-xyz");
  });
});
```

Add the `waitForPendingActionId` helper (polls `app.action_requests` for the actor's newest pending row via
`AiRepository`; read `tests/integration/ai-tools.test.ts` for the existing helper that lists assistant actions
and reuse its repository method rather than raw SQL):

```ts
// Filters by toolName so a leftover pending row from a different test (e.g. a deliberate timeout
// case) cannot be mistaken for THIS call's action (Codex LOW #12). Pass the tool you just invoked.
async function waitForPendingActionId(
  dc: DataContextRunner,
  actorUserId: string,
  toolName = "calendar.proposeFocusBlock"
): Promise<string> {
  const repo = new AiRepository();
  for (let i = 0; i < 50; i += 1) {
    const actions = await dc.withDataContext({ actorUserId, requestId: "poll" }, (scopedDb) =>
      repo.listAssistantActions(scopedDb)
    );
    // newest-pending for THIS tool (listAssistantActions returns newest-first; confirm in repository.ts)
    const pending = actions.find((a) => a.status === "pending" && a.toolName === toolName);
    if (pending) return pending.id;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("no pending action appeared");
}
```

> The field name for the tool on the action row may be `toolName` or `tool_name` on the DTO —
> confirm against `AiAssistantActionRequestSafeRow` in `packages/ai/src/repository.ts` and use the
> actual field. Additionally, to prevent cross-describe bleed, the suite SHOULD reset the actor's
> pending actions between the gateway-driving describes (Group C/D) — either call
> `resetFoundationDatabase()` in a `beforeEach` for those describes, or cancel any leftover pending
> action for the actor at the end of each deny/timeout test. Pick the simpler one that keeps the
> suite green and deterministic; the timeout test in D4 in particular leaves a pending row by design.

> Confirm the exact `AiRepository` method name for listing actions by reading
> `tests/integration/ai-tools.test.ts` and `packages/ai/src/repository.ts` (it backs
> `GET /api/ai/assistant/actions`); use that method, not invented SQL.

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/focus-time.test.ts -t "proposeFocusBlock tool wiring"`
Expected: FAIL — the tool is not on the manifest; `summarize`/`execute` do not exist.

- [ ] **Step 3: Write minimal implementation**

In `packages/calendar/src/tools.ts`, add the handler + summarize (keep the existing
`calendarListVisibleEventsExecute` import unchanged):

```ts
import type { ToolContext, ToolExecute, ToolResult, ToolServices } from "@jarv1s/module-sdk";

import type { CalendarWriteService } from "./calendar-write-service.js";
import { resolveWindow, type FocusBlockInput, type PartOfDay } from "./focus-time.js";

function narrowCalendarWrite(services: ToolServices | undefined): CalendarWriteService {
  const svc = (services ?? {}).calendarWrite as CalendarWriteService | undefined;
  if (!svc || typeof svc.proposeAndInsert !== "function") {
    throw new Error("calendarWrite service is not available");
  }
  return svc;
}

function readInput(input: Record<string, unknown>): FocusBlockInput {
  return {
    date: typeof input.date === "string" ? input.date : undefined,
    partOfDay: input.partOfDay as PartOfDay | undefined,
    start: typeof input.start === "string" ? input.start : undefined,
    durationMinutes: typeof input.durationMinutes === "number" ? input.durationMinutes : undefined,
    title: typeof input.title === "string" ? input.title : undefined
  };
}

export const calendarProposeFocusBlockExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx,
  services
): Promise<ToolResult> => {
  const service = narrowCalendarWrite(services);
  const resolved = resolveWindow(readInput(input), new Date(), DEFAULT_TIMEZONE);
  const result = await service.proposeAndInsert(scopedDb, ctx, {
    start: resolved.start,
    end: resolved.end,
    durationMinutes: resolved.durationMinutes, // REQUESTED block length, not the band width
    title: resolved.title
  });
  return { data: { ...result } };
};

export const summarizeProposeFocusBlock = (
  input: Record<string, unknown>,
  _ctx: ToolContext
): string => {
  const resolved = resolveWindow(readInput(input), new Date(), DEFAULT_TIMEZONE);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const startStr = fmt.format(resolved.start);
  const endStr = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(resolved.end);
  return `Block "${resolved.title}" ${startStr}–${endStr} on your primary calendar (or the next clear slot if that window is busy).`;
};
```

Add the timezone constant at the top of `tools.ts` (the configured default; this slice does NOT
fetch the live primary-calendar tz — Codex HIGH #4):

```ts
// Configured default timezone for part-of-day band resolution + the card preview. This is
// the single source of truth for "morning/afternoon/evening" — the impl does NOT make a
// Google calendarList.get call to discover the primary-calendar tz (out of scope this slice;
// see Codex HIGH #4 / spec Open risk #1). resolveWindow maps the band to a concrete UTC
// instant using THIS tz; the inserted event carries explicit UTC start/end (RFC3339 with a
// 'Z' offset), so the instant is unambiguous regardless of the user's calendar tz. A future
// slice may fetch the real calendar tz; this slice accepts the configured default and the
// card text is only the REQUESTED-window preview.
const DEFAULT_TIMEZONE = process.env.JARVIS_DEFAULT_TZ ?? "America/New_York";
```

In `packages/calendar/src/manifest.ts`, import the new handlers and add the tool entry to `assistantTools`
(after the existing `calendar.listVisibleEvents` object):

```ts
import {
  calendarListVisibleEventsExecute,
  calendarProposeFocusBlockExecute,
  summarizeProposeFocusBlock
} from "./tools.js";
```

```ts
    {
      name: "calendar.proposeFocusBlock",
      description:
        "Propose and (on approval) create a focus-time block on the user's primary Google Calendar, conflict-checked live against their availability.",
      permissionId: "calendar.manage",
      risk: "write",
      requiresServices: ["calendarWrite"],
      // NOTE: the gateway's validateToolInput (input-validation.ts) enforces only type + enum +
      // required (NOT format/pattern/minimum/maximum/additionalProperties — see its docstring and
      // issue #133). So the `enum` below IS enforced. date/start FORMAT and duration BOUNDS are
      // enforced in the HANDLER: resolveWindow rejects a malformed start/date and clampDuration
      // bounds duration to 15..480 (Codex MED #5). Unknown extra keys are NOT rejected — readInput
      // simply ignores them, which is safe (only the known fields drive the write; an extra key
      // cannot change the resolved window). Descriptions document intent for a future ajv swap.
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "local calendar date yyyy-mm-dd" },
          partOfDay: { type: "string", enum: ["morning", "afternoon", "evening"] },
          start: { type: "string", description: "explicit RFC3339 instant; if set, wins over date/partOfDay" },
          durationMinutes: { type: "number", description: "block length; clamped to 15..480 by the handler" },
          title: { type: "string", description: "block title; defaults to 'Focus time'" }
        }
      },
      execute: calendarProposeFocusBlockExecute,
      summarize: summarizeProposeFocusBlock
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `vitest run tests/integration/focus-time.test.ts -t "proposeFocusBlock tool wiring" && pnpm typecheck`
Expected: PASS (manifest entry present, `summarize` text correct, `execute` delegates to the fake service and
surfaces the resolved id).

- [ ] **Step 5: Commit**

```bash
git add packages/calendar/src/tools.ts packages/calendar/src/manifest.ts tests/integration/focus-time.test.ts
git commit -m "feat(calendar): add calendar.proposeFocusBlock write tool (risk:write, requiresServices)"
```

---

# GROUP D — CalendarWriteService implementation + wiring (REQUIRES Groups A–C + connector-sync merged)

## Task D1: Concrete `CalendarWriteService` in `packages/chat`

**Files:**

- Create: `packages/chat/src/calendar-write-impl.ts`
- Modify: `packages/chat/src/index.ts` (export `calendar-write-impl.js` so `@jarv1s/chat` exposes
  `buildCalendarWriteService`)
- Modify: `packages/chat/package.json` (add `@jarv1s/connectors`, `@jarv1s/calendar` deps)
- Test: `tests/integration/focus-time.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/focus-time.test.ts`. Build the real impl with a fake `GoogleApiClient`
(`fetch`-faked) and a real `GoogleConnectionService` over a seeded google account; assert happy path,
conflict shift, fully-busy no-write, missing scope no-write, and mirror skip on a non-google account:

```ts
import { buildCalendarWriteService } from "@jarv1s/chat";
import { GoogleConnectionService, GoogleOAuthClient } from "@jarv1s/connectors";

function buildImpl(opts: {
  freeBusyBusy?: Array<{ start: string; end: string }>;
  insertReply?: { id: string; htmlLink?: string };
  insertStatus?: number;
  /** Override the calendar repository (D2 injects one whose upsertCachedEvent throws 42501). */
  calendarRepository?: CalendarRepository;
}) {
  const { fetchFn } = captureFetch((url) => {
    if (url.includes("/freeBusy")) {
      return { body: { calendars: { primary: { busy: opts.freeBusyBusy ?? [] } } } };
    }
    if (url.includes("/events")) {
      if (opts.insertStatus) return { status: opts.insertStatus, body: { error: "SECRET" } };
      return { body: opts.insertReply ?? { id: "evt-new", htmlLink: "https://x/evt-new" } };
    }
    return { body: {} };
  });
  const cipher = createConnectorSecretCipher();
  const repository = new ConnectorsRepository();
  const googleService = new GoogleConnectionService({
    repository,
    cipher,
    oauthClient: new GoogleOAuthClient({ fetchFn })
  });
  return buildCalendarWriteService({
    googleService,
    googleApiClient: new GoogleApiClient({ fetchFn }),
    connectorsRepository: repository,
    calendarRepository: opts.calendarRepository ?? new CalendarRepository()
  });
}

describe("Group D — CalendarWriteService impl (faked Google fetch)", () => {
  it("happy path: clear window → insertEvent with jarvisCreated tag → created:true", async () => {
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    const impl = buildImpl({ freeBusyBusy: [] });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (scopedDb) =>
        impl.proposeAndInsert(
          scopedDb,
          { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(true);
    expect(res.googleEventId).toBe("evt-new");
    expect(res.conflict).toBe("none");
    // Duration regression guard: a 120-minute request over a 09:00–12:00 (180-min) band
    // must insert a 120-minute block, NOT the whole band. resolvedEnd - resolvedStart = 120m.
    const inserted =
      (new Date(res.resolvedEnd).getTime() - new Date(res.resolvedStart).getTime()) / 60_000;
    expect(inserted).toBe(120);
  });

  it("conflict: a busy interval shifts the slot (shifted:true)", async () => {
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    const impl = buildImpl({
      freeBusyBusy: [{ start: "2026-06-17T13:00:00Z", end: "2026-06-17T13:30:00Z" }]
    });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (scopedDb) =>
        impl.proposeAndInsert(
          scopedDb,
          { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(true);
    expect(res.shifted).toBe(true);
    expect(res.conflict).toBe("shifted");
  });

  it("fully busy: no-clear-slot → created:false, no insert call", async () => {
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    const impl = buildImpl({
      freeBusyBusy: [{ start: "2026-06-17T13:00:00Z", end: "2026-06-17T16:00:00Z" }]
    });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (scopedDb) =>
        impl.proposeAndInsert(
          scopedDb,
          { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(false);
    expect(res.conflict).toBe("no-clear-slot");
  });

  it("missing scope: returns created:false with a re-consent message, no Google call", async () => {
    await seedGoogleAccount(ids.userB, ["https://www.googleapis.com/auth/gmail.modify"]);
    const impl = buildImpl({ freeBusyBusy: [] });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "t" },
      (scopedDb) =>
        impl.proposeAndInsert(
          scopedDb,
          { actorUserId: ids.userB, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(false);
    expect(res.message).toMatch(/reconnect/i);
  });
});
```

> Note: the mirror-skip-on-non-google-account assertion is exercised by Task D2 (it needs the real upsert path
> and the non-relaxed RLS). This task asserts created/conflict/scope and that no secret/body appears in any
> returned `message`.

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/focus-time.test.ts -t "CalendarWriteService impl"`
Expected: FAIL — `@jarv1s/chat` does not export `buildCalendarWriteService`.

- [ ] **Step 3: Write minimal implementation**

Add deps to `packages/chat/package.json` (`dependencies`, alphabetical with existing `@jarv1s/*`):

```json
    "@jarv1s/calendar": "workspace:*",
    "@jarv1s/connectors": "workspace:*",
```

Create `packages/chat/src/calendar-write-impl.ts`:

```ts
import { assertDataContextDb, type DataContextDb } from "@jarv1s/db";
import {
  chooseSlot,
  type CalendarWriteService,
  type FocusBlockWindow,
  type ProposeFocusResult,
  type ResolvedWindow,
  CalendarRepository
} from "@jarv1s/calendar";
import {
  GoogleConnectError,
  GoogleConnectionService,
  ConnectorsRepository,
  GoogleApiClient
} from "@jarv1s/connectors";
import type { ToolContext } from "@jarv1s/module-sdk";

export interface CalendarWriteImplDeps {
  readonly googleService: GoogleConnectionService;
  readonly googleApiClient: GoogleApiClient;
  readonly connectorsRepository: ConnectorsRepository;
  readonly calendarRepository: CalendarRepository;
}

// No timezone constant is needed here: the resolved window already carries concrete UTC
// instants (the tool's resolveWindow mapped the part-of-day band to UTC using the configured
// default tz). freeBusy and insertEvent receive RFC3339 timestamps with a 'Z' offset, so the
// instant is unambiguous and we deliberately do NOT pass a conflicting `timeZone` field
// (Codex HIGH #4). Google interprets a 'Z'-suffixed dateTime as the exact UTC instant.

export function buildCalendarWriteService(deps: CalendarWriteImplDeps): CalendarWriteService {
  return {
    async proposeAndInsert(
      scopedDbRaw: unknown,
      _ctx: ToolContext,
      window: FocusBlockWindow
    ): Promise<ProposeFocusResult> {
      assertDataContextDb(scopedDbRaw);
      const scopedDb = scopedDbRaw as DataContextDb;
      // window.start..window.end is the SEARCH WINDOW (e.g. the morning band); the block
      // length is window.durationMinutes (already clamped by resolveWindow). Do NOT recompute
      // duration from (end - start) — that would insert a band-width block, not the request.
      const resolved: ResolvedWindow = {
        start: window.start,
        end: window.end,
        durationMinutes: window.durationMinutes,
        title: window.title
      };

      // 1. Scope check — no Google call without calendar-write scope. Reads the stored granted
      // scopes (connector_accounts.scopes), which are the authoritative propose-time gate. KNOWN
      // LIMITATION (Codex MED #10): the shipped getFreshAccessToken writes back bundle.grantedScopes
      // and does not reconcile refreshed.scope, so if a user later narrows scopes out-of-band the
      // stored set can be stale. We do NOT re-author that shipped connectors/OAuth code here ("no new
      // OAuth code" — AC#7). The defense-in-depth backstop is Google itself: insertEvent on a token
      // lacking calendar scope returns 403, which surfaces as a body-free "couldn't create" message
      // (created:false), never a silent success. A connectors-owned follow-up may reconcile scopes on
      // refresh; tracked, not in this slice.
      const hasScope = await deps.connectorsRepository.hasCalendarWriteScope(scopedDb);
      if (!hasScope) {
        return {
          created: false,
          resolvedStart: resolved.start.toISOString(),
          resolvedEnd: resolved.end.toISOString(),
          shifted: false,
          conflict: "none",
          calendarMirror: "skipped-error",
          message:
            "Your Google connection doesn't have calendar-write permission yet — reconnect in Settings to grant it."
        };
      }

      // 2. Fresh access token (refreshes on <60s-to-expiry, after approval).
      let accessToken: string;
      try {
        accessToken = await deps.googleService.getFreshAccessToken(scopedDb);
      } catch (error) {
        const message =
          error instanceof GoogleConnectError
            ? "Connect Google in Settings first."
            : "Couldn't refresh your Google access — reconnect in Settings.";
        return {
          created: false,
          resolvedStart: resolved.start.toISOString(),
          resolvedEnd: resolved.end.toISOString(),
          shifted: false,
          conflict: "none",
          calendarMirror: "skipped-error",
          message
        };
      }

      // 3. Live freeBusy + slot choice.
      let slot;
      try {
        const fb = await deps.googleApiClient.freeBusy({
          accessToken,
          timeMin: resolved.start.toISOString(),
          timeMax: resolved.end.toISOString(),
          calendarId: "primary"
        });
        slot = chooseSlot(resolved, fb.busy, resolved.durationMinutes);
      } catch {
        return {
          created: false,
          resolvedStart: resolved.start.toISOString(),
          resolvedEnd: resolved.end.toISOString(),
          shifted: false,
          conflict: "none",
          calendarMirror: "skipped-error",
          message: "Couldn't check your calendar availability — try again."
        };
      }

      if (slot.conflict === "no-clear-slot") {
        return {
          created: false,
          resolvedStart: slot.start.toISOString(),
          resolvedEnd: slot.end.toISOString(),
          shifted: false,
          conflict: "no-clear-slot",
          calendarMirror: "skipped-error",
          message: "No clear slot in that window — try a different time."
        };
      }

      // 4. Insert the event, tagged jarvisCreated.
      let inserted;
      try {
        inserted = await deps.googleApiClient.insertEvent({
          accessToken,
          calendarId: "primary",
          summary: resolved.title,
          // RFC3339 with 'Z' — the UTC instant is unambiguous; no timeZone field (see note above).
          start: slot.start.toISOString(),
          end: slot.end.toISOString(),
          extendedPrivateProperties: { jarvisCreated: "true", jarvisTool: "proposeFocusBlock" }
        });
      } catch {
        return {
          created: false,
          resolvedStart: slot.start.toISOString(),
          resolvedEnd: slot.end.toISOString(),
          shifted: slot.shifted,
          conflict: slot.conflict,
          calendarMirror: "skipped-error",
          message: "Couldn't create the calendar event — try again."
        };
      }

      // 5. Best-effort cache mirror (gated on connector-sync RLS 0065). Never fails the call.
      const calendarMirror = await mirrorEvent(deps, scopedDb, inserted, slot, resolved);

      return {
        created: true,
        resolvedStart: slot.start.toISOString(),
        resolvedEnd: slot.end.toISOString(),
        shifted: slot.shifted,
        conflict: slot.conflict === "none" ? "none" : "shifted",
        googleEventId: inserted.id,
        calendarMirror
      };
    }
  };
}

async function mirrorEvent(
  deps: CalendarWriteImplDeps,
  scopedDb: DataContextDb,
  inserted: { id: string; htmlLink?: string },
  slot: { start: Date; end: Date },
  resolved: ResolvedWindow
): Promise<"written" | "skipped-rls" | "skipped-error"> {
  try {
    const active = await deps.connectorsRepository.getActiveGoogleAccountSecret(scopedDb);
    if (!active) return "skipped-error";
    await deps.calendarRepository.upsertCachedEvent(scopedDb, {
      connectorAccountId: active.id,
      externalId: inserted.id,
      title: resolved.title,
      startsAt: slot.start,
      endsAt: slot.end,
      externalMetadata: {
        jarvisCreated: true,
        source: "proposeFocusBlock",
        htmlLink: inserted.htmlLink ?? null
      }
    });
    return "written";
  } catch (error) {
    // The calendar INSERT policy requires provider_type IN (...,'google') (connector-sync
    // migration 0065). If absent, the WITH CHECK fails — record skipped-rls; the Google event
    // is the source of truth. Any other DB error → skipped-error. NEVER rethrow.
    // Classify on the STABLE Postgres SQLSTATE first (42501 = insufficient_privilege, raised
    // by an RLS WITH CHECK / policy violation); message text is locale/version-dependent, so
    // only fall back to it (Codex MED #7). pg/Kysely surface `code` on the error object.
    const code = (error as { code?: string } | null)?.code;
    if (code === "42501") return "skipped-rls";
    const message = error instanceof Error ? error.message : "";
    return /row-level security|violates row-level|policy/i.test(message)
      ? "skipped-rls"
      : "skipped-error";
  }
}
```

> `upsertCachedEvent` lands with the connector-sync slice (`CalendarRepository`). If `pnpm typecheck` reports
> it missing, the connector-sync slice has not merged — STOP per the Hard-dependency gate.

Export the builder from `packages/chat/src/index.ts` so `@jarv1s/chat` exposes it (the D1 test and the
chat-route wiring import `buildCalendarWriteService` from `@jarv1s/chat`). Add, alphabetically with the
existing `export *` lines:

```ts
export * from "./calendar-write-impl.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm typecheck && vitest run tests/integration/focus-time.test.ts -t "CalendarWriteService impl"`
Expected: PASS (happy/conflict/no-slot/missing-scope all green; no secret or Google body appears in any
`message`).

- [ ] **Step 5: Commit**

```bash
git add packages/chat/src/calendar-write-impl.ts packages/chat/src/index.ts packages/chat/package.json pnpm-lock.yaml tests/integration/focus-time.test.ts
git commit -m "feat(chat): build concrete CalendarWriteService impl (composition host joins calendar+connectors)"
```

## Task D2: Cache-mirror gating test (skipped-rls on a non-relaxed account)

**Files:**

- Test: `tests/integration/focus-time.test.ts`

- [ ] **Step 1: Write the failing test**

Prove the mirror records a **hard** `skipped-rls` (not a tolerant either/or) by injecting a fake
`CalendarRepository` whose `upsertCachedEvent` throws a Postgres-shaped error with `code:"42501"`
(the SQLSTATE Postgres raises for an RLS WITH CHECK / policy violation). This makes the test
DETERMINISTIC regardless of whether connector-sync's 0065 is applied in the run DB (Codex MED #6) —
it exercises the exact classification branch in `mirrorEvent` and asserts the call still returns
`created:true` and never throws. A second case asserts a non-RLS DB error classifies as
`skipped-error`.

```ts
class RlsRejectingCalendarRepository extends CalendarRepository {
  // Simulate the calendar INSERT policy WITH CHECK failing (provider_type guard, pre-0065).
  override async upsertCachedEvent(): Promise<never> {
    const err = new Error(
      'new row violates row-level security policy for table "calendar_events"'
    ) as Error & {
      code?: string;
    };
    err.code = "42501"; // insufficient_privilege — what pg raises for an RLS violation
    throw err;
  }
}

class GenericFailingCalendarRepository extends CalendarRepository {
  override async upsertCachedEvent(): Promise<never> {
    const err = new Error("deadlock detected") as Error & { code?: string };
    err.code = "40P01"; // a NON-RLS error → must classify as skipped-error
    throw err;
  }
}

describe("Group D — cache mirror gating (deterministic)", () => {
  it("classifies an RLS (42501) mirror failure as skipped-rls; call still created:true", async () => {
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    const impl = buildImpl({
      freeBusyBusy: [],
      calendarRepository: new RlsRejectingCalendarRepository()
    });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (scopedDb) =>
        impl.proposeAndInsert(
          scopedDb,
          { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(true); // the Google event is the source of truth; mirror is best-effort
    expect(res.calendarMirror).toBe("skipped-rls");
    expect(res.googleEventId).toBe("evt-new");
  });

  it("classifies a non-RLS DB error as skipped-error; call still created:true", async () => {
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    const impl = buildImpl({
      freeBusyBusy: [],
      calendarRepository: new GenericFailingCalendarRepository()
    });
    const res = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "t" },
      (scopedDb) =>
        impl.proposeAndInsert(
          scopedDb,
          { actorUserId: ids.userA, requestId: "t", chatSessionId: "s" },
          {
            start: new Date("2026-06-17T13:00:00Z"),
            end: new Date("2026-06-17T16:00:00Z"),
            durationMinutes: 120,
            title: "Focus time"
          }
        )
    );
    expect(res.created).toBe(true);
    expect(res.calendarMirror).toBe("skipped-error");
  });
});
```

> Why a fake repository (not a real non-relaxed account): the real `skipped-rls` outcome depends on
> whether 0065 is applied in the run DB, which is non-deterministic across build order. Injecting a
> repository that throws the exact SQLSTATE makes the test prove the CLASSIFICATION + never-throw
> guarantee deterministically. The happy path in D1 (with a real repository) separately proves the
> `written` outcome when the policy permits the insert. Together they cover both branches.

- [ ] **Step 2: Run test to verify it fails (or passes if D1's classification is already correct)**

Run: `vitest run tests/integration/focus-time.test.ts -t "cache mirror gating"`
Expected: PASS once D1's `mirrorEvent` classifies on SQLSTATE `42501` first. If the RLS case returns
`skipped-error` instead, `mirrorEvent` is not reading `error.code` — fix it (Codex MED #7). If the call
throws, `mirrorEvent` is rethrowing — fix it to swallow and classify, never rethrow.

- [ ] **Step 3: (No new implementation — D1's `mirrorEvent` SQLSTATE classification satisfies this.)**

- [ ] **Step 4: Re-run to confirm green**

Run: `vitest run tests/integration/focus-time.test.ts -t "cache mirror gating"`
Expected: PASS (both classification cases green; `created:true` in both).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/focus-time.test.ts
git commit -m "test(focus-time): assert cache mirror is gated and never fails the call"
```

## Task D3: Plumb connectors collaborators into chat route registration

**Files:**

- Modify: `packages/chat/src/routes.ts` (deps + gateway `toolServices`)
- Modify: `packages/module-registry/src/index.ts` (carry collaborators to `registerChatRoutes`)
- Modify: `apps/api/src/server.ts` (construct + pass collaborators)
- Test: `tests/integration/focus-time.test.ts`

- [ ] **Step 1: Write the failing test**

Append a **real** wiring test (no `expect(true).toBe(true)` placeholder — Codex MED #9) that exercises
D3's OWN code — the exported `buildChatToolServices` factory — and proves the gateway it produces
actually carries `calendarWrite`. Because the A2 fail-closed filter HIDES a `requiresServices` tool when
its service is unregistered, presence-of-the-tool in `tools/list` is itself proof of wiring: if the
factory did not build `calendarWrite`, `calendar.proposeFocusBlock` would not be listed. The test
asserts BOTH directions — WITH collaborators the factory yields a working service (listed +
`tools/call`+resolve executes it), WITHOUT collaborators the factory yields `{}` (tool hidden,
`tools/call` rejected).

**Critical routing fact (Codex Round-2 HIGH #8/#11 — verified against the code):** the AI REST path
`GET /api/ai/assistant-tools` + `POST /api/ai/assistant-tools/:name/invoke` +
`POST /api/ai/assistant-actions/:id/resolve` (in `packages/ai/src/routes.ts`) does **NOT** use
`AssistantToolGateway`, does **NOT** receive `toolServices`, and resolving an action there is
**audit state only** — it never executes the tool (see `ai-tools.test.ts` "resolves … as audit state
only", where the task stays `todo` after confirm). The REAL execution path is the **MCP gateway**:
`registerChatRoutes` constructs `AssistantToolGateway` (with our `toolServices`) and registers
`registerMcpTransportRoute` at `POST /api/mcp` (`tools/list`, `tools/call`) plus the approve route
`POST /api/chat/action-requests/:id/resolve`. So this test MUST drive the MCP transport, not the AI
REST path.

The test MUST exercise D3's OWN code, not a hand-rolled gateway (Codex Round-3 HIGH — a manually
constructed gateway would pass even if `routes.ts`/`module-registry`/`apps/api` were never changed).
So `toolServices` is built by the REAL exported `buildChatToolServices` factory, AND a third assertion
drives `buildChatGatewayDependencies` — the exact helper `registerChatRoutes` uses to construct the
gateway — to prove the real construction path carries `toolServices` (closing the Codex Round-4 MED:
"factory exists but registerChatRoutes forgot to pass it"). The first case passes the connector
collaborators (over a faked-Google `fetch`) and asserts the factory yields a working `calendarWrite`
that the MCP gateway lists AND executes through `tools/call` + resolve. The second case passes NO
collaborators and asserts the factory yields `{}`, so the A2 fail-closed filter HIDES the tool from
`tools/list` and a `tools/call` returns "Tool not available". The third case asserts
`buildChatGatewayDependencies(...).toolServices.calendarWrite` is present WITH collaborators and absent
WITHOUT. These FAIL until the helpers exist and are exported — proving they guard D3's implementation.
The MCP transport drive mirrors `chat-mcp-transport.test.ts` exactly.

```ts
// registerMcpTransportRoute is NOT re-exported from @jarv1s/chat — import it via the deep src path
// exactly as chat-mcp-transport.test.ts does (verified):
import { registerMcpTransportRoute } from "../../packages/chat/src/mcp-transport.js";
// the REAL D3 helpers — these imports fail to resolve pre-D3 (honest "test fails first"):
import { buildChatToolServices, buildChatGatewayDependencies } from "@jarv1s/chat";
import Fastify from "fastify";

// Build an app whose gateway uses toolServices PRODUCED BY THE REAL FACTORY (not a literal).
function buildGatewayAppFromFactory(collaborators: {
  googleConnectionService?: import("@jarv1s/connectors").GoogleConnectionService;
  googleApiClient?: import("@jarv1s/connectors").GoogleApiClient;
  connectorsRepository?: import("@jarv1s/connectors").ConnectorsRepository;
}) {
  const toolServices = buildChatToolServices(collaborators); // ← exercises D3's code path
  const tokens = new SessionTokenRegistry();
  const gateway = new AssistantToolGateway({
    resolveActiveModules: () => [calendarModuleManifest],
    repository: new AiRepository(),
    runner: dataContext,
    tokens,
    confirmations: new ConfirmationRegistry(),
    notifier: { emit() {} },
    confirmTimeoutMs: 150_000,
    toolServices
  });
  const app = Fastify({ logger: false });
  registerMcpTransportRoute(app, { gateway, tokens });
  app.post<{ Params: { id: string }; Body: { status: string } }>(
    "/api/chat/action-requests/:id/resolve",
    async (request, reply) => {
      await gateway.resolveActionRequest(
        ids.userA,
        request.params.id,
        request.body.status as "confirmed"
      );
      return reply.code(204).send();
    }
  );
  return { app, tokens };
}

async function mcp(
  app: import("fastify").FastifyInstance,
  token: string,
  method: string,
  params: unknown
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/mcp",
    headers: { authorization: `Bearer ${token}` },
    body: { jsonrpc: "2.0", id: 1, method, params }
  });
  return res.json();
}

describe("Group D — buildChatToolServices wires calendarWrite into the gateway (MCP path)", () => {
  it("WITH collaborators: the factory yields calendarWrite; tools/list includes it and tools/call+resolve executes it", async () => {
    await seedGoogleAccount(ids.userA, ["https://www.googleapis.com/auth/calendar"]);
    // Real collaborators over a faked Google fetch — buildChatToolServices builds a real
    // buildCalendarWriteService from them, so a successful tools/call proves the whole D3 chain.
    const { fetchFn } = captureFetch((url) =>
      url.includes("/freeBusy")
        ? { body: { calendars: { primary: { busy: [] } } } }
        : { body: { id: "evt-mcp", htmlLink: "https://x/evt-mcp" } }
    );
    const cipher = createConnectorSecretCipher();
    const connectorsRepository = new ConnectorsRepository();
    const { app, tokens } = buildGatewayAppFromFactory({
      googleConnectionService: new GoogleConnectionService({
        repository: connectorsRepository,
        cipher,
        oauthClient: new GoogleOAuthClient({ fetchFn })
      }),
      googleApiClient: new GoogleApiClient({ fetchFn }),
      connectorsRepository
    });
    await app.ready();
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });

    const list = await mcp(app, token, "tools/list", {});
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("calendar.proposeFocusBlock"); // factory produced calendarWrite ⇒ tool listed

    const callP = mcp(app, token, "tools/call", {
      name: "calendar.proposeFocusBlock",
      arguments: { partOfDay: "morning", durationMinutes: 120 }
    });
    const actionId = await waitForPendingActionId(dataContext, ids.userA);
    await app.inject({
      method: "POST",
      url: `/api/chat/action-requests/${actionId}/resolve`,
      payload: { status: "confirmed" }
    });
    const callResult = await callP;
    // tools/call surfaces the created event id once approved + executed via the real wired service.
    expect(JSON.stringify(callResult)).toContain("evt-mcp");
    await app.close();
  });

  it("WITHOUT collaborators: the factory yields {} so tools/list EXCLUDES the tool and tools/call is rejected", async () => {
    const { app, tokens } = buildGatewayAppFromFactory({}); // factory returns {}
    await app.ready();
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const list = await mcp(app, token, "tools/list", {});
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain("calendar.proposeFocusBlock"); // fail-closed: hidden
    const call = await mcp(app, token, "tools/call", {
      name: "calendar.proposeFocusBlock",
      arguments: {}
    });
    // gateway returns ok:false "Tool not available" → MCP surfaces an error, never reaches execute.
    expect(JSON.stringify(call).toLowerCase()).toMatch(/not available|error/);
    await app.close();
  });

  // Guards the "factory exists but registerChatRoutes forgot to pass toolServices" gap (Codex Round-4 MED):
  // assert the EXACT dependency object registerChatRoutes builds carries toolServices from the factory.
  it("buildChatGatewayDependencies (the helper registerChatRoutes uses) carries toolServices.calendarWrite", () => {
    const { fetchFn } = captureFetch(() => ({ body: {} }));
    const connectorsRepository = new ConnectorsRepository();
    const deps = buildChatGatewayDependencies({
      resolveActiveModules: () => [calendarModuleManifest],
      repository: new AiRepository(),
      runner: dataContext,
      tokens: new SessionTokenRegistry(),
      confirmations: new ConfirmationRegistry(),
      notifier: { emit() {} },
      collaborators: {
        googleConnectionService: new GoogleConnectionService({
          repository: connectorsRepository,
          cipher: createConnectorSecretCipher(),
          oauthClient: new GoogleOAuthClient({ fetchFn })
        }),
        googleApiClient: new GoogleApiClient({ fetchFn }),
        connectorsRepository
      }
    });
    expect(deps.toolServices).toBeDefined();
    expect((deps.toolServices as Record<string, unknown>).calendarWrite).toBeDefined();
    // and WITHOUT collaborators, the same helper omits it:
    const bare = buildChatGatewayDependencies({
      resolveActiveModules: () => [calendarModuleManifest],
      repository: new AiRepository(),
      runner: dataContext,
      tokens: new SessionTokenRegistry(),
      confirmations: new ConfirmationRegistry(),
      notifier: { emit() {} },
      collaborators: {}
    });
    expect((bare.toolServices as Record<string, unknown>).calendarWrite).toBeUndefined();
  });
});
```

> This test imports the REAL `buildChatToolServices` from `@jarv1s/chat`; that import does not resolve
> until D3 Step 3 adds and exports the factory, so the suite fails to compile pre-D3 (the honest "test
> fails first"). Read `tests/integration/chat-mcp-transport.test.ts` for the exact `registerMcpTransportRoute`
> import path, the resolve-route helper, and the `tools/list`/`tools/call` JSON-RPC envelope, and mirror them.
> Do NOT use the AI REST `/api/ai/assistant-*` routes — they bypass the gateway and resolve audit-only.
> The full `registerChatRoutes` → `createApiServer` HTTP path (session-token minting via the chat live
> runtime) is additionally exercised by the post-merge live round-trip in the FINAL GATE task.

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run tests/integration/focus-time.test.ts -t "buildChatToolServices wires calendarWrite"`
Expected: FAIL to COMPILE — `buildChatToolServices` is not exported from `@jarv1s/chat` until D3 Step 3.
After it exists but before the A2 filter lands, the WITHOUT-collaborators case would wrongly list the tool;
after Group C the WITH case lists+executes it. All three conditions must hold for green.

- [ ] **Step 3: Write minimal implementation**

**`packages/chat/src/routes.ts`** — extend `ChatRoutesDependencies` and build the service. Add the imports:

```ts
import { buildCalendarWriteService } from "./calendar-write-impl.js";
import type {
  GoogleConnectionService,
  GoogleApiClient,
  ConnectorsRepository
} from "@jarv1s/connectors";
import { CalendarRepository } from "@jarv1s/calendar";
```

Add optional collaborators to `ChatRoutesDependencies` (after `boss?`):

```ts
  /** Connector collaborators for the calendar focus-time write tool (composition host). */
  readonly googleConnectionService?: GoogleConnectionService;
  readonly googleApiClient?: GoogleApiClient;
  readonly connectorsRepository?: ConnectorsRepository;
```

Extract BOTH the `toolServices` construction AND the gateway-dependencies assembly into EXPORTED,
pure helpers so the wiring is directly testable and a test can prove `registerChatRoutes` actually
passes `toolServices` into the gateway (Codex Round-3 HIGH + Round-4 MED — the test must guard D3's
real construction path, not just a standalone factory). Add these two top-level exported functions in
`routes.ts`:

```ts
/**
 * Builds the gateway toolServices map from the optional connector collaborators. Returns {} when
 * any collaborator is missing, so the gateway's fail-closed filter hides calendar.proposeFocusBlock
 * rather than listing an unsatisfiable tool. Exported so the wiring is unit-testable without HTTP.
 */
export function buildChatToolServices(deps: {
  googleConnectionService?: GoogleConnectionService;
  googleApiClient?: GoogleApiClient;
  connectorsRepository?: ConnectorsRepository;
}): Record<string, unknown> {
  if (deps.googleConnectionService && deps.googleApiClient && deps.connectorsRepository) {
    return {
      calendarWrite: buildCalendarWriteService({
        googleService: deps.googleConnectionService,
        googleApiClient: deps.googleApiClient,
        connectorsRepository: deps.connectorsRepository,
        calendarRepository: new CalendarRepository()
      })
    };
  }
  return {};
}

/**
 * Assembles the AssistantToolGatewayDependencies registerChatRoutes uses, INCLUDING toolServices from
 * buildChatToolServices. Exported so a test can assert the real construction path carries toolServices
 * (i.e. that registerChatRoutes does not forget to pass it) — closing the "factory exists but isn't
 * wired" gap. registerChatRoutes calls THIS, then `new AssistantToolGateway(deps)`.
 */
export function buildChatGatewayDependencies(args: {
  resolveActiveModules: ActiveModulesResolver;
  repository: AiRepository;
  runner: DataContextRunner;
  tokens: SessionTokenRegistry;
  confirmations: ConfirmationRegistry;
  notifier: SessionNotifier;
  collaborators: {
    googleConnectionService?: GoogleConnectionService;
    googleApiClient?: GoogleApiClient;
    connectorsRepository?: ConnectorsRepository;
  };
}): AssistantToolGatewayDependencies {
  return {
    resolveActiveModules: args.resolveActiveModules,
    repository: args.repository,
    runner: args.runner,
    tokens: args.tokens,
    confirmations: args.confirmations,
    notifier: args.notifier,
    confirmTimeoutMs: 150_000,
    toolServices: buildChatToolServices(args.collaborators)
  };
}
```

In the gateway-construction block (the `if (dependencies.resolveActiveModules && dependencies.mcpServerUrl)`
branch), construct the gateway from the helper so the real path is exactly what the test verifies:

```ts
gateway = new AssistantToolGateway(
  buildChatGatewayDependencies({
    resolveActiveModules: dependencies.resolveActiveModules,
    repository: aiRepository,
    runner: dependencies.dataContext,
    tokens,
    confirmations,
    notifier: notifierProxy,
    collaborators: {
      googleConnectionService: dependencies.googleConnectionService,
      googleApiClient: dependencies.googleApiClient,
      connectorsRepository: dependencies.connectorsRepository
    }
  })
);
```

Both helpers are exported from `@jarv1s/chat` via the existing `export * from "./routes.js"` in
`packages/chat/src/index.ts` (confirm that line exists; it does today). Import the gateway-dep types
(`AssistantToolGatewayDependencies`, `ActiveModulesResolver`, `SessionNotifier`) and
`SessionTokenRegistry`/`ConfirmationRegistry`/`AiRepository` from `@jarv1s/ai` at the top of `routes.ts`
if not already imported (they are used by the existing gateway-construction block).

> Note: when the collaborators are absent (e.g. a chat-only test harness), `buildChatToolServices` returns
> `{}`, so `toolServices.calendarWrite` is unset. The A2 fail-closed filter then HIDES
> `calendar.proposeFocusBlock` entirely — it does not appear in `tools/list`, and a `tools/call` for it
> returns "Tool not available" (it never reaches `execute`). So an absent service is a clean
> tool-not-available, never a post-approval dead-end and never a crash. The `narrowCalendarWrite` guard in
> the handler remains as defense-in-depth for the impossible case of a registered-but-malformed service.

**`packages/module-registry/src/index.ts`** — add the collaborators to `BuiltInRouteDependencies` and pass
them into the chat registration. Add to the interface (after `bootstrapConnectionString?`):

```ts
  readonly googleConnectionService?: import("@jarv1s/connectors").GoogleConnectionService;
  readonly googleApiClient?: import("@jarv1s/connectors").GoogleApiClient;
  readonly connectorsRepository?: import("@jarv1s/connectors").ConnectorsRepository;
```

Update the chat `registerRoutes` block (the `registerChatRoutes(server, {...})` call) to forward them:

```ts
    registerRoutes: (server, deps) =>
      registerChatRoutes(server, {
        resolveAccessContext: deps.resolveAccessContext,
        dataContext: deps.dataContext,
        chatEngineFactory: deps.chatEngineFactory,
        resolveActiveModules: deps.listModuleManifests,
        mcpServerUrl: `http://127.0.0.1:${process.env.PORT ?? 3000}/api/mcp`,
        boss: deps.boss,
        googleConnectionService: deps.googleConnectionService,
        googleApiClient: deps.googleApiClient,
        connectorsRepository: deps.connectorsRepository
      }),
```

**`apps/api/src/server.ts`** — construct the collaborators and pass them in the
`registerBuiltInApiRoutes(server, {...})` call. Add the imports at the top:

```ts
import {
  ConnectorsRepository,
  GoogleConnectionService,
  GoogleOAuthClient,
  GoogleApiClient,
  createConnectorSecretCipher
} from "@jarv1s/connectors";
```

Inside `createApiServer`, before `registerBuiltInApiRoutes`, build the collaborators (a single shared
repository + cipher; the service is per-call-scoped via `scopedDb`, so one instance is fine):

```ts
const connectorsRepository = new ConnectorsRepository();
const googleConnectionService = new GoogleConnectionService({
  repository: connectorsRepository,
  cipher: createConnectorSecretCipher(),
  oauthClient: new GoogleOAuthClient()
});
const googleApiClient = new GoogleApiClient();
```

Add to the `registerBuiltInApiRoutes(server, {...})` object:

```ts
      googleConnectionService,
      googleApiClient,
      connectorsRepository,
```

> `createConnectorSecretCipher` requires `JARVIS_CONNECTOR_SECRET_KEY` at runtime (already required by M-B1).
> The test harness in `ai-tools.test.ts` sets `JARVIS_AI_SECRET_KEY`; this suite must additionally set the
> connector key in `beforeAll` (mirror `connectors-google.test.ts`). If the key is unset in a non-connector
> test, building the cipher will throw at server construction — guard the cipher build to be lazy if needed,
> but prefer setting the env in the focus-time suite (the simplest, honest fix).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm typecheck && vitest run tests/integration/focus-time.test.ts -t "buildChatToolServices wires calendarWrite"`
Expected: PASS — WITH collaborators the factory yields `calendarWrite`, the MCP `tools/list` includes the
tool, and `tools/call`+resolve executes it (surfacing `evt-mcp`); WITHOUT collaborators the factory yields
`{}`, the tool is hidden, and `tools/call` is rejected.

- [ ] **Step 5: Commit**

```bash
git add packages/chat/src/routes.ts packages/module-registry/src/index.ts apps/api/src/server.ts tests/integration/focus-time.test.ts
git commit -m "feat(wiring): plumb connectors collaborators -> chat gateway toolServices.calendarWrite"
```

## Task D4: The no-write-without-approval safety property (deny + timeout)

**Files:**

- Test: `tests/integration/focus-time.test.ts`

- [ ] **Step 1: Write the failing test**

Append the safety-property test. Build the gateway with a **counting fake** `calendarWrite` whose
`proposeAndInsert` increments an `inserts` counter, then assert: a **denied** resolution and a **timeout**
each leave the counter at 0, and an **approved** resolution increments it exactly once.

```ts
describe("Group D — no write without approval (safety property)", () => {
  function gatewayWithCountingService(confirmTimeoutMs: number) {
    let inserts = 0;
    const service = {
      async proposeAndInsert(
        _db: unknown,
        _ctx: unknown,
        window: { start: Date; end: Date; durationMinutes: number; title: string }
      ) {
        inserts += 1;
        return {
          created: true,
          resolvedStart: window.start.toISOString(),
          resolvedEnd: window.end.toISOString(),
          shifted: false,
          conflict: "none" as const,
          googleEventId: "evt",
          calendarMirror: "skipped-rls" as const
        };
      }
    };
    const tokens = new SessionTokenRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: () => [calendarModuleManifest],
      repository: new AiRepository(),
      runner: dataContext,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit() {} },
      confirmTimeoutMs,
      toolServices: { calendarWrite: service }
    });
    return { gateway, tokens, getInserts: () => inserts };
  }

  it("a denied proposal performs no insert", async () => {
    const { gateway, tokens, getInserts } = gatewayWithCountingService(150_000);
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const callPromise = gateway.callTool(token, "calendar.proposeFocusBlock", {
      partOfDay: "morning"
    });
    const actionId = await waitForPendingActionId(dataContext, ids.userA);
    await gateway.resolveActionRequest(ids.userA, actionId, "rejected");
    const res = await callPromise;
    expect(res.ok).toBe(false);
    expect(getInserts()).toBe(0);
  });

  it("a timed-out proposal performs no insert", async () => {
    const { gateway, tokens, getInserts } = gatewayWithCountingService(50); // 50ms timeout
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const res = await gateway.callTool(token, "calendar.proposeFocusBlock", {
      partOfDay: "morning"
    });
    expect(res.ok).toBe(false);
    expect(getInserts()).toBe(0);
  });

  it("an approved proposal performs exactly one insert", async () => {
    const { gateway, tokens, getInserts } = gatewayWithCountingService(150_000);
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: ids.userA,
      allowedToolNames: null
    });
    const callPromise = gateway.callTool(token, "calendar.proposeFocusBlock", {
      partOfDay: "morning"
    });
    const actionId = await waitForPendingActionId(dataContext, ids.userA);
    await gateway.resolveActionRequest(ids.userA, actionId, "confirmed");
    await callPromise;
    expect(getInserts()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or passes — this asserts existing gate behavior)**

Run: `vitest run tests/integration/focus-time.test.ts -t "no write without approval"`
Expected: PASS — the existing gateway only calls `runHandler` (→ `execute` → `proposeAndInsert`) after
`outcome === "confirmed"`. If any case FAILS, a bypass exists — STOP and escalate (this is the core safety
property and a security blocker).

- [ ] **Step 3: (No implementation — this is a guard test on existing behavior.)**

- [ ] **Step 4: Confirm green**

Run: `vitest run tests/integration/focus-time.test.ts -t "no write without approval"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/focus-time.test.ts
git commit -m "test(focus-time): prove no Google write occurs on deny or timeout (safety property)"
```

## Task D5: Wire the focus-time suite into the gate

**Files:**

- Modify: `package.json` (add `test:focus-time`; confirm `verify:foundation` integration glob picks it up)
- Test: the script itself

- [ ] **Step 1: Inspect how integration tests are collected for the gate**

Run: `grep -nE '"test:integration"|"verify:foundation"|tests/integration' ~/Jarv1s/package.json`
Expected: see whether `test:integration` is a glob over `tests/integration/*.test.ts` (auto-includes the new
file) or an explicit list. If it is a glob, the new file is already covered; if explicit, add it.

- [ ] **Step 2: Add the named script (for targeted runs) regardless**

Add to `package.json` `scripts`, next to `test:calendar-email`:

```json
    "test:focus-time": "vitest run tests/integration/focus-time.test.ts",
```

- [ ] **Step 3: Run it**

Run: `pnpm db:up && pnpm test:focus-time`
Expected: PASS (entire focus-time suite green).

- [ ] **Step 4: Confirm gate inclusion**

Run: `pnpm test:integration` and confirm `tests/integration/focus-time.test.ts` is among the executed files
(it must be, for the gate to cover the safety property). If the gate uses an explicit list, add the file path
there too.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore(test): add test:focus-time script and ensure gate covers the suite"
```

---

# GROUP F — Design-direction slice: Ritual visual language (presentation-only, gated)

> **Independent of the focus-time groups.** May run in parallel / first. Source of truth:
> `docs/superpowers/specs/2026-06-13-p3-design-direction-ritual-design.md`,
> `docs/brand/visual-language-research.md` (Direction 3 locked), `docs/brand/brand-brief.md`.
> HARD STOP list: **no** purple/blue AI-glow gradients, **no** sparkle/magic-wand icons, **no**
> mascots/therapeutic softness, **no** chat-first dominance, **no** horizontal pagination.

## Task F1: Read the brand source of truth + enumerate existing tokens/selectors

**Files:** (read-only investigation; no commit)

- [ ] **Step 1:** Read in full: `docs/brand/visual-language-research.md` (especially §"Implications for the
      Phase 3 design slice" and the HARD STOP list) and `docs/brand/brand-brief.md` (the "Avoid" list incl. the
      recovery-language rule, `brand-brief.md:184-194`).

- [ ] **Step 2:** Enumerate every CSS custom property referenced anywhere in `apps/web/src`:

```bash
grep -rhoE 'var\(--[a-z0-9-]+' ~/Jarv1s/apps/web/src --include='*.css' --include='*.tsx' | sort -u
```

Record the full set (you must DEFINE every one in `tokens.css`, including the five `tasks.css` leaves
undefined: `--text-muted`, `--surface-subtle`, `--surface-active`, `--border-subtle`, `--border`).

- [ ] **Step 3:** Enumerate the selectors the existing e2e specs depend on (so the restyle preserves them):

```bash
grep -rnE "getByRole|getByTestId|locator\(|getByLabel|data-testid|aria-label" ~/Jarv1s/tests/e2e/*.spec.ts
```

Record these; the post-gate restyle must keep them (or update specs in the same task).

- [ ] **Step 4:** Confirm `apps/web/src/styles.css` line count and the `check:file-size` cap:

```bash
wc -l ~/Jarv1s/apps/web/src/styles.css
```

Expected: ~952 lines (cap is 1000). The split must keep every resulting file under 1000.

- [ ] **Step 5:** No commit (investigation only).

## Task F2: Author the semantic token layer (`tokens.css`) — restyles nothing on its own

**Files:**

- Create: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/src/main.tsx` (import `tokens.css` FIRST)
- Test: `pnpm check:file-size && pnpm lint && pnpm format:check` + the hex-isolation grep

- [ ] **Step 1: Write the failing check (grep guard)**

The objective test for this task is the hex-isolation invariant. Before writing tokens, run:

```bash
grep -rlE '#[0-9a-fA-F]{3,6}|rgb\(' ~/Jarv1s/apps/web/src --include='*.css'
```

Expected now: matches in `styles.css` and `tasks.css`. Goal after the slice (post Task F-restyle): matches
**only** in `tokens.css`. For THIS task, the deliverable is that `tokens.css` exists and DEFINES every token
from F1 Step 2 plus the Ritual tokens — verified by the consumer files resolving without inline fallbacks once
they are converted (later tasks).

- [ ] **Step 2: Create `apps/web/src/styles/tokens.css`** with three tiers. Author the **primitive ramps**
      (the ONLY hex in the app), the **semantic aliases** (every referenced token + the Ritual additions), and
      **theme overlays** (`:root` light default + `[data-theme="dark"]` + `[data-theme="amber"]` re-pointing
      semantic tokens only). Concrete structure (fill ramp values from the locked palette in
      `visual-language-research.md`; the names below are load-bearing — they must match what components consume):

```css
/* apps/web/src/styles/tokens.css
 * Phase 3 Ritual direction — the ONLY file permitted to contain hex/rgb() literals.
 * Tier 1 primitives (raw ramps) -> Tier 2 semantic aliases (what components use) ->
 * Tier 3 theme overlays (re-point SEMANTIC tokens only). Ship light-first; no toggle. */

:root {
  /* Tier 1 — primitive ramps (raw values; never referenced by components directly). */
  --neutral-0: #ffffff;
  --neutral-50: #f7f6f3; /* newsprint off-white */
  --neutral-100: #efede8;
  --neutral-200: #e2dfd8;
  --neutral-400: #9a948a;
  --neutral-600: #5c574e;
  --neutral-800: #2b2722;
  --neutral-900: #172026;
  --teal-500: #2f7d72; /* brand teal/green */
  --teal-600: #25655c;
  --amber-400: #d9a441; /* circadian / attention */
  --amber-600: #b07d24;
  --bucket-morning-hue: #e8b04b; /* morning bright */
  --bucket-afternoon-hue: #c98a3c;
  --bucket-evening-hue: #8a6d9a; /* evening amber-violet (NOT an AI-glow gradient) */
  --danger-500: #b3382f; /* reserved for genuine system/validation failure ONLY */

  /* Tier 2 — semantic tokens (the public surface components consume). */
  --surface: var(--neutral-50);
  --surface-raised: var(--neutral-0);
  --surface-subtle: var(--neutral-100);
  --surface-active: var(--neutral-200);
  --panel: var(--surface-raised);
  --panel-subtle: var(--surface-subtle);
  --text: var(--neutral-900);
  --ink: var(--text);
  --text-muted: var(--neutral-600);
  --muted: var(--text-muted);
  --border: var(--neutral-200);
  --border-default: var(--border);
  --border-subtle: var(--neutral-100);
  --accent: var(--teal-500);
  --accent-strong: var(--teal-600);
  --state-attention: var(--amber-400); /* unread / at-risk — never error-red */
  --state-recovery: var(--amber-600); /* normal human drift — never error-red */
  --warning: var(--amber-400);
  --danger: var(--danger-500);
  --bucket-morning: var(--bucket-morning-hue);
  --bucket-afternoon: var(--bucket-afternoon-hue);
  --bucket-evening: var(--bucket-evening-hue);
  --provisional-opacity: 0.7; /* governor for AI/unconfirmed content */
}

[data-theme="dark"] {
  /* Re-point SEMANTIC tokens to dark primitives (authored, not shipped). */
  --surface: var(--neutral-900);
  --surface-raised: var(--neutral-800);
  --surface-subtle: var(--neutral-800);
  --surface-active: var(--neutral-600);
  --panel: var(--surface-raised);
  --panel-subtle: var(--surface-subtle);
  --text: var(--neutral-50);
  --ink: var(--text);
  --text-muted: var(--neutral-400);
  --muted: var(--text-muted);
  --border: var(--neutral-600);
  --border-default: var(--border);
  --border-subtle: var(--neutral-800);
}

[data-theme="amber"] {
  /* Evening "amber" circadian overlay (authored, not shipped). */
  --surface: #2a211a;
  --surface-raised: #342a20;
  --text: #f3e6d2;
  --text-muted: #c9b79a;
  --accent: var(--amber-400);
}
```

> The exact ramp values come from the locked research; if `visual-language-research.md` specifies precise hex,
> use those. The token NAMES above are the contract every component and mockup must use — do not rename them
> in later tasks.

- [ ] **Step 3: Import `tokens.css` FIRST in `apps/web/src/main.tsx`** (cascade order: tokens before
      consumers). Read the current import block (`main.tsx:7-8`) and add `import "./styles/tokens.css";` as the
      first style import, before `./styles.css`.

- [ ] **Step 4: Run the gates**

Run: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm typecheck && pnpm build:web`
Expected: PASS — `tokens.css` is well under 1000 lines and the app still builds (tokens are additive; nothing
references the new Ritual names yet, and existing names keep resolving).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/styles/tokens.css apps/web/src/main.tsx
git commit -m "feat(web): add Ritual semantic token layer (3 tiers, dark/amber-ready, light-first)"
```

## Task F3: Lightweight `ui/` primitives (presentation-only, no API/DTO imports)

**Files:**

- Create: `apps/web/src/ui/Card.tsx`, `Stack.tsx`, `SectionHeader.tsx`, `Badge.tsx`, `TimeBucket.tsx`,
  `ProvisionalRegion.tsx`, `index.ts`
- Test: `pnpm typecheck` + a grep guard that none imports an API client or a data DTO

- [ ] **Step 1: Write the failing guard**

Run: `pnpm typecheck` (will pass trivially now). The load-bearing guard is:

```bash
grep -rnE "@jarv1s/shared|api-client|useQuery|fetch\(" ~/Jarv1s/apps/web/src/ui/ 2>/dev/null
```

Expected after this task: **no matches** (primitives are pure presentation). For now the dir does not exist.

- [ ] **Step 2: Create the primitives.** Each is a small typed presentational component using semantic
      tokens via className/inline `var()`. Example `TimeBucket.tsx` (the chronology header) and
      `ProvisionalRegion.tsx` (the governor) are load-bearing for the Ritual model:

```tsx
// apps/web/src/ui/TimeBucket.tsx
import type { ReactNode } from "react";

export type Bucket = "morning" | "afternoon" | "evening";

const LABELS: Record<Bucket, string> = {
  morning: "This Morning",
  afternoon: "This Afternoon",
  evening: "This Evening"
};

export function TimeBucket({ bucket, children }: { bucket: Bucket; children: ReactNode }) {
  return (
    <section className="time-bucket" data-bucket={bucket}>
      <h2 className="time-bucket-label" style={{ color: `var(--bucket-${bucket})` }}>
        {LABELS[bucket]}
      </h2>
      <div className="time-bucket-body">{children}</div>
    </section>
  );
}
```

```tsx
// apps/web/src/ui/ProvisionalRegion.tsx
import type { ReactNode } from "react";

/** Wraps AI/unconfirmed content at the governor opacity with an accessible affordance. */
export function ProvisionalRegion({ children }: { children: ReactNode }) {
  return (
    <div
      className="provisional-region"
      style={{ opacity: "var(--provisional-opacity)" }}
      aria-label="Provisional — not yet confirmed"
      data-provisional="true"
    >
      {children}
    </div>
  );
}
```

```tsx
// apps/web/src/ui/Badge.tsx
import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "accent" | "recovery" | "attention";

const TONE_VAR: Record<BadgeTone, string> = {
  neutral: "var(--text-muted)",
  accent: "var(--accent)",
  recovery: "var(--state-recovery)",
  attention: "var(--state-attention)"
};

// NOTE: no "error"/"danger" tone — normal human drift never renders error-red (brand-brief Avoid list).
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className="badge" data-tone={tone} style={{ color: TONE_VAR[tone] }}>
      {children}
    </span>
  );
}
```

```tsx
// apps/web/src/ui/Card.tsx
import type { ReactNode } from "react";
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`card${className ? ` ${className}` : ""}`}>{children}</div>;
}
```

```tsx
// apps/web/src/ui/Stack.tsx
import type { ReactNode } from "react";
export function Stack({ gap = "md", children }: { gap?: "sm" | "md" | "lg"; children: ReactNode }) {
  return (
    <div className="stack" data-gap={gap}>
      {children}
    </div>
  );
}
```

```tsx
// apps/web/src/ui/SectionHeader.tsx
import type { ReactNode } from "react";
export function SectionHeader({ children }: { children: ReactNode }) {
  return <h3 className="section-header">{children}</h3>;
}
```

```ts
// apps/web/src/ui/index.ts
export * from "./Card.js";
export * from "./Stack.js";
export * from "./SectionHeader.js";
export * from "./Badge.js";
export * from "./TimeBucket.js";
export * from "./ProvisionalRegion.js";
```

> Add the matching CSS classes (`.card`, `.stack`, `.time-bucket`, `.provisional-region`, `.badge`,
> `.section-header`) to `tokens.css`-consuming feature CSS in the post-gate restyle, OR add a small
> `apps/web/src/ui/ui.css` imported after `tokens.css` (keep it token-only, no hex). Decide at build; if you
> add `ui.css`, import it in `main.tsx` after `tokens.css`.

- [ ] **Step 3: Run the guard + typecheck**

Run: `pnpm typecheck && pnpm build:web`
Then: `grep -rnE "@jarv1s/shared|api-client|useQuery|fetch\(" ~/Jarv1s/apps/web/src/ui/` → expect **no
matches**.
Expected: typecheck/build PASS; grep empty.

- [ ] **Step 4: Format/lint**

Run: `pnpm format && pnpm lint && pnpm check:file-size`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/
git commit -m "feat(web): add presentation-only Ritual ui primitives (TimeBucket, ProvisionalRegion, Badge, Card, Stack, SectionHeader)"
```

## Task F4: Static HTML mockups — the taste-gate deliverable

**Files:**

- Create: `docs/brand/mockups/briefing-reading.html`, `docs/brand/mockups/tasks-day-buckets.html`,
  `docs/brand/mockups/settings-form.html`
- Test: each opens standalone in a browser; mirrors the `tokens.css` names

- [ ] **Step 1:** Create the three self-contained mockups (inline `<style>` re-using the SAME semantic token
      names from `tokens.css` in a local `:root` block; no build step, no external assets). They must demonstrate:
  1. **`briefing-reading.html`** — editorial single-column reading surface (newsprint `--surface`, comfortable
     measure, generous vertical rhythm) rendering representative briefing prose with light section headers.
  2. **`tasks-day-buckets.html`** — This Morning / This Afternoon / This Evening sections with the
     `--bucket-*` circadian accents, a governor 70%-opacity provisional block, and a normal-drift item styled
     `--state-recovery` (amber), **never** error-red.
  3. **`settings-form.html`** — a dense form-heavy screen proving the language holds (panels, definition
     lists, inputs, buttons) using semantic tokens.

  Each mockup must honor the HARD STOP list (no AI-glow gradients, no sparkle icons, no mascots, no chat-first
  dominance, no horizontal pagination).

- [ ] **Step 2:** Verify each opens cleanly:

```bash
ls -la ~/Jarv1s/docs/brand/mockups/
grep -lE '#[0-9a-fA-F]{3,6}' ~/Jarv1s/docs/brand/mockups/*.html  # hex is fine in mockups (self-contained)
```

(Optional, if a headless browser is available, run DOM/layout assertions via the
`webwright`/Playwright harness for the sign-off message; not required for the gate file itself.)

- [ ] **Step 3:** No code change needed beyond the HTML files.

- [ ] **Step 4: Format/lint guard** (HTML is not linted by eslint; confirm the repo gates still pass):

Run: `pnpm lint && pnpm format:check && pnpm check:file-size`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/brand/mockups/
git commit -m "docs(brand): add Ritual-direction mockups (briefing reading, day buckets, settings form)"
```

## Task F5: Pre-gate verification of the scaffolding deliverable

**Files:** (verification only)

- [ ] **Step 1:** Confirm the pre-gate deliverable is exactly: spec (already approved) + mockups (F4) + token
      scaffolding (F2) + primitives (F3). **No screen has been restyled yet.**

- [ ] **Step 2:** Run the pre-gate gates (these must be green WITHOUT any app-wide restyle):

```bash
pnpm lint && pnpm format:check && pnpm check:file-size && pnpm typecheck && pnpm build:web
```

Expected: PASS (acceptance criterion #11 — the scaffolding restyles nothing, so the gate is green pre-gate).

- [ ] **Step 3:** No commit (verification only).

---

## ════════════ AWAIT BEN'S MOCKUP SIGN-OFF ════════════

> **HARD STOP — DO NOT PROCEED PAST THIS LINE WITHOUT BEN'S EXPLICIT APPROVAL OF THE MOCKUPS.**
>
> This is the taste gate from the design-direction spec (acceptance criterion #10). The overnight build's
> design deliverable ends here: spec + mockups (`docs/brand/mockups/*.html`) + the taste-neutral token
> scaffolding (`tokens.css` + the `ui/` primitives) — **none of which restyles an existing screen.**
>
> **What the autonomous build MUST do at this gate:**
>
> 1. Stop all design-direction work. Do **not** start Task F6+ (the app-wide restyle).
> 2. Surface the mockups for review: post the three `docs/brand/mockups/*.html` paths (and rendered HTML paths if a
>    headless browser is available) to Ben via the relay/handoff channel, with a one-line summary of the
>    direction and a request for sign-off.
> 3. Record the blocked state in the run manifest/coordination doc so a successor session knows the design
>    slice is parked awaiting human approval.
>
> **The focus-time groups (A–E) are NOT blocked by this gate** — they are independent and may be built,
> tested, and PR'd while the mockups await sign-off. Only the design RESTYLE tasks (F6+) wait.
>
> **After Ben approves the mockups,** proceed to Task F6. If Ben requests changes, revise `tokens.css` /
> primitives / mockups and re-present — never start the restyle against unapproved mockups.

## ════════════════════════════════════════════════════

## Task F6 (POST-GATE): Split `styles.css` + convert base hex to semantic tokens

**Files:**

- Modify: `apps/web/src/styles.css` (hex → `var()`, ensure < 1000 lines after the token move)
- Test: `pnpm check:file-size` + the hex-isolation grep

- [ ] **Step 1:** Re-run the hex-isolation grep to enumerate every hex/`rgb()` in `styles.css`:

```bash
grep -nE '#[0-9a-fA-F]{3,6}|rgb\(' ~/Jarv1s/apps/web/src/styles.css
```

- [ ] **Step 2:** Replace each hex/`rgb()` with the matching semantic token from `tokens.css` (e.g.
      `#ffffff` → `var(--surface-raised)`, `#172026` → `var(--text)`). Preserve every layout rule and selector
      (per F1 Step 3, do not break e2e selectors). The token tier already moved out of `:root`, so net lines drop.

- [ ] **Step 3:** Run the gate:

```bash
pnpm check:file-size && pnpm build:web
grep -rlE '#[0-9a-fA-F]{3,6}|rgb\(' ~/Jarv1s/apps/web/src --include='*.css'
```

Expected: `check:file-size` PASS (every CSS file < 1000 lines); the hex grep returns **only** `tokens.css`
(after Task F7 also converts `tasks.css`).

- [ ] **Step 4:** Visual smoke via the existing e2e suites (they render real screens):

```bash
pnpm test:e2e
```

Expected: existing specs pass (selectors preserved).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/styles.css
git commit -m "refactor(web): convert styles.css hex to semantic tokens; split under 1000 lines"
```

## Task F7 (POST-GATE): Convert `tasks.css` hex + adopt time-bucket visual rhythm

**Files:**

- Modify: `apps/web/src/tasks/tasks.css` (hex → tokens incl. priority/matrix blocks), `tasks-page.tsx`
  (adopt `TimeBucket`/`Badge` for the grouped visual rhythm — NO new persisted view/data field)
- Test: `pnpm check:file-size`, hex grep, `pnpm test:e2e` (`tasks.spec.ts` still passes)

- [ ] **Step 1:** Replace the hardcoded priority/matrix hex (`tasks.css:60-77,123-134`:
      `#dc2626`, `#ea580c`, `#ca8a04`, `#2563eb`, `#6b7280`) with semantic tokens, and remove inline
      `var(--x, #fallback)` fallbacks now that `tokens.css` defines the five formerly-undefined tokens.

- [ ] **Step 2:** In `tasks-page.tsx`, apply the `TimeBucket`/`Badge` primitives to the existing groupings as
      a **presentation-only** rhythm. **Do NOT** add a new `TaskDefaultView` value or any scheduling/time-bucket
      data field (spec Out-of-scope; the live day-bucket DATA is task-vertical work). Group by a presentation-only
      derivation from existing task fields; the full day-view is demonstrated in the mockup.

- [ ] **Step 3:** Run gates + grep:

```bash
pnpm check:file-size && pnpm build:web && pnpm typecheck
grep -rlE '#[0-9a-fA-F]{3,6}|rgb\(' ~/Jarv1s/apps/web/src --include='*.css'   # only tokens.css
```

- [ ] **Step 4:** `pnpm test:e2e` → `tasks.spec.ts` passes (verify selectors preserved per F1 Step 3).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/tasks/tasks.css apps/web/src/tasks/tasks-page.tsx
git commit -m "refactor(web): tasks surface to semantic tokens + Ritual time-bucket rhythm (no new data)"
```

## Task F8 (POST-GATE): Briefing editorial reading surface + e2e

**Files:**

- Create: `apps/web/src/briefings/briefing-reading-view.tsx`, `apps/web/src/briefings/briefings.css`
- Modify: `apps/web/src/briefings/briefings-page.tsx` (render the selected run in the reading surface),
  `apps/web/src/main.tsx` (import `briefings.css`)
- Create: `tests/e2e/briefing-reading.spec.ts`
- Test: Playwright e2e (mocked REST)

- [ ] **Step 1: Write the failing e2e**

Create `tests/e2e/briefing-reading.spec.ts` reusing `tests/e2e/mock-briefings-api.ts`. Sign in, open
`/briefings`, select a definition with at least one run, assert the run's `summaryText` renders inside the
reading surface (stable selector, e.g. `aria-label="Briefing"`):

```ts
import { test, expect } from "@playwright/test";
import { mockBriefingsApi } from "./mock-briefings-api";

test("briefing reading surface renders summaryText in an editorial region", async ({ page }) => {
  await mockBriefingsApi(page); // reuse existing run fixtures
  await page.goto("/briefings");
  // select the first definition with a run (selector per the existing briefings-page markup)
  await page
    .getByRole("button", { name: /run|briefing/i })
    .first()
    .click();
  const region = page.getByRole("region", { name: "Briefing" });
  await expect(region).toBeVisible();
  await expect(region).toContainText(/.+/); // the fixture's summaryText
});
```

> Read `tests/e2e/mock-briefings-api.ts` and `tests/e2e/app-shell.spec.ts` for the exact sign-in helper and
> the fixture's `summaryText` content; assert that concrete text rather than a regex if it is stable.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:e2e tests/e2e/briefing-reading.spec.ts`
Expected: FAIL — no `region` with `aria-label="Briefing"` exists yet.

- [ ] **Step 3: Implement the reading view.** Create `briefing-reading-view.tsx` rendering a single
      `BriefingRunDto.summaryText` in an editorial single-column layout (the `ui/` primitives + `briefings.css`),
      preserving paragraph/line breaks (`white-space: pre-wrap` or split-on-newline), with an
      `aria-label="Briefing"` region. **No change to `BriefingRunDto` / `briefings-api.ts`** (acceptance criterion
      #6). Wire it into `briefings-page.tsx` to render the selected run's body (keep the definitions/editor column
      intact). Import `briefings.css` after `tokens.css` in `main.tsx`.

```tsx
// apps/web/src/briefings/briefing-reading-view.tsx
import type { BriefingRunDto } from "@jarv1s/shared";

export function BriefingRunView({ run }: { run: BriefingRunDto }) {
  const paragraphs = run.summaryText.split(/\n{2,}/);
  return (
    <article aria-label="Briefing" className="briefing-reading">
      {paragraphs.map((p, i) => (
        <p key={i} className="briefing-paragraph" style={{ whiteSpace: "pre-wrap" }}>
          {p}
        </p>
      ))}
    </article>
  );
}
```

> Confirm `BriefingRunDto.summaryText` is the field name (`packages/shared/src/briefings-api.ts:20-29`) before
> using it. `briefings.css` must be token-only (no hex) and stay under 1000 lines.

- [ ] **Step 4: Run the e2e + the suite**

Run: `pnpm test:e2e tests/e2e/briefing-reading.spec.ts && pnpm test:e2e`
Expected: the new spec PASSES; existing e2e suites still pass.
Then: `pnpm check:file-size && pnpm build:web && pnpm typecheck` → PASS.
Then verify the DTO is unchanged: `git diff --quiet packages/shared/src/briefings-api.ts && echo UNCHANGED`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/briefings/briefing-reading-view.tsx apps/web/src/briefings/briefings.css apps/web/src/briefings/briefings-page.tsx apps/web/src/main.tsx tests/e2e/briefing-reading.spec.ts
git commit -m "feat(web): editorial briefing reading surface + e2e (renders existing summaryText, no DTO change)"
```

## Task F9 (POST-GATE): Coherent restyle pass — settings, chat drawer, notifications, auth

**Files:**

- Modify: `apps/web/src/settings/settings-page.tsx`, `apps/web/src/chat/chat-drawer.tsx`,
  `apps/web/src/notifications/notifications-page.tsx`, `apps/web/src/auth/auth-screen.tsx` (+ their CSS)
- Test: `pnpm test:e2e`, hex grep, `pnpm check:file-size`

- [ ] **Step 1:** Token-adopt each surface (class/token only, no behavior change). Specifically:
  - **Settings:** panels, definition lists, provider status rows → semantic tokens.
  - **Chat drawer:** restyle chrome to tokens; keep it a **secondary tool, not the spine** (HARD STOP: no
    chat-first dominance); do not change the static `"CLI"` provider indicator
    (`chat-drawer.tsx:44-46`) to name a model (provider-agnostic invariant). Provisional assistant replies may
    use `ProvisionalRegion`.
  - **Notifications:** calm/periphery; unread uses `--state-attention` (amber/accent), **not** error-red.
  - **Auth:** token adoption only.
  - **Calendar / Email:** **do NOT rebuild** — they are `ComingSoon` stubs owned by the connector-sync slice;
    only ensure they consume the shared token layer if touched.

- [ ] **Step 2:** Preserve every e2e selector enumerated in F1 Step 3 (update specs in this task if a selector
      must change).

- [ ] **Step 3:** Run gates + grep:

```bash
pnpm lint && pnpm format:check && pnpm check:file-size && pnpm typecheck && pnpm build:web
grep -rlE '#[0-9a-fA-F]{3,6}|rgb\(' ~/Jarv1s/apps/web/src --include='*.css'   # only tokens.css
```

- [ ] **Step 4:** `pnpm test:e2e` → all suites pass (`chat-drawer.spec.ts`, `app-shell.spec.ts`,
      `connect-google.spec.ts`, `tasks.spec.ts`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/settings apps/web/src/chat apps/web/src/notifications apps/web/src/auth
git commit -m "refactor(web): coherent Ritual restyle of settings/chat/notifications/auth (tokens only)"
```

---

## Self-Review

After completing the tasks (and before the final gate), run this checklist with fresh eyes.

### 1. Spec coverage — focus-time spec (`2026-06-13-p3-focus-time-self-scheduling.md`)

| Spec section / acceptance criterion                                                                                                                                                                                                                    | Task(s)                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §Components 1 — generic injection seam (manifest `requiresServices`, 4th `ToolExecute` arg, gateway `toolServices`)                                                                                                                                    | A1, A2                                                                                                                                                                                                                     |
| §Components 2 — focus-time tool + pure propose logic + `summarize`                                                                                                                                                                                     | C1, C3                                                                                                                                                                                                                     |
| §Components 3 — calendar-owned `CalendarWriteService` interface                                                                                                                                                                                        | C2                                                                                                                                                                                                                         |
| §Components 4 — impl + wiring in `packages/chat`                                                                                                                                                                                                       | D1, D3                                                                                                                                                                                                                     |
| §Components 5 — dependency plumbing (module-registry, connectors exports, apps/api)                                                                                                                                                                    | D1 (deps), D3                                                                                                                                                                                                              |
| §Components 6 — granted-scope verification + re-consent copy (`hasCalendarWriteScope`)                                                                                                                                                                 | B2, D1                                                                                                                                                                                                                     |
| §Components 7 — manifest registration                                                                                                                                                                                                                  | C3                                                                                                                                                                                                                         |
| §Data flow — freeBusy live → chooseSlot → insert → mirror                                                                                                                                                                                              | B1, C1, D1                                                                                                                                                                                                                 |
| §Error handling — missing scope / no connection / refresh fail / Google non-2xx / conflict / mirror skip / timeout / invalid input / double-approve                                                                                                    | B1 (body-free error), C1 (conflict/no-slot + malformed/overflow start/date rejection), D1 (scope/connection/refresh/insert/mirror), D4 (timeout/deny/approve), A2/gateway (enum validation + idempotent resolve unchanged) |
| §Security — no new policy, secrets contained, DataContextDb only, AccessContext shape, module isolation, no migration, **write→confirm floor un-bypassable via the service seam** (read tools never receive an injected service; per-tool subset only) | Honored across A–D; asserted in A2 (HIGH#1 subset, HIGH#5 read-tool withhold/hide), B1 (body-free), D1 (token discarded), D4 (no-write-without-approval)                                                                   |
| §Testing strategy — pure logic, seam, impl, no-write safety, scope verify, secret containment, gate                                                                                                                                                    | C1, A2, D1/D2, D4, B2, B1, D5                                                                                                                                                                                              |
| AC#1 tool exists `risk:write`/`calendar.manage`, no policy edit                                                                                                                                                                                        | C3 (assert risk/permission); no edit to policy.ts/gateway confirm path                                                                                                                                                     |
| AC#2 routes through confirm; deny/timeout → no write; approve → one insert                                                                                                                                                                             | D4                                                                                                                                                                                                                         |
| AC#3 insert on primary tagged jarvisCreated, returns resolved time + id                                                                                                                                                                                | B1, D1                                                                                                                                                                                                                     |
| AC#4 live freeBusy, shift or no-clear-slot                                                                                                                                                                                                             | C1, D1                                                                                                                                                                                                                     |
| AC#5 best-effort mirror with `external_metadata.jarvisCreated`                                                                                                                                                                                         | D1, D2                                                                                                                                                                                                                     |
| AC#6 generic seam (per-tool subset, read tools withheld, fail-closed listing), calendar owns interface, chat builds impl, no connectors import in calendar                                                                                             | A1/A2, C2, D1, D3 (MCP-path wiring)                                                                                                                                                                                        |
| AC#7 scope verified, re-consent reuses `buildAuthUrl` (no new OAuth code)                                                                                                                                                                              | B2, D1                                                                                                                                                                                                                     |
| AC#8 no secret escapes; Google errors body-free; no pg-boss job                                                                                                                                                                                        | B1, D1, D4                                                                                                                                                                                                                 |
| AC#9 clean seam for future briefing caller (documented, not built)                                                                                                                                                                                     | C2 interface + D1 builder are directly reusable (noted)                                                                                                                                                                    |
| AC#10 no migration authored; module isolation/DataContextDb/AccessContext preserved                                                                                                                                                                    | whole slice (no `sql/` file added)                                                                                                                                                                                         |
| AC#11 `verify:foundation` + `audit:release-hardening` green; independent review                                                                                                                                                                        | Final gate task + the review note below                                                                                                                                                                                    |

### 1b. Spec coverage — design-direction spec (`2026-06-13-p3-design-direction-ritual-design.md`)

| Acceptance criterion                                                 | Task(s)                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------- |
| AC#1 `tokens.css` is the only hex-bearing CSS file                   | F2, F6, F7 (grep guard)                                 |
| AC#2 every referenced token defined; fallbacks removed               | F1 (enumerate), F2 (define), F7 (remove fallbacks)      |
| AC#3 dark/amber-ready overlays, light-first                          | F2                                                      |
| AC#4 `styles.css` split, all files < 1000 lines                      | F6 (`check:file-size`)                                  |
| AC#5 4–6 primitives, no API/DTO imports                              | F3 (6 primitives + grep guard)                          |
| AC#6 briefing reading renders `summaryText`, no DTO change           | F8 (`git diff` guard)                                   |
| AC#7 2–3 mockups (briefing, day-buckets, form)                       | F4                                                      |
| AC#8 governor opacity + recovery/attention never error-red           | F2 (tokens), F3 (Badge has no error tone), F4 (mockups) |
| AC#9 HARD STOP list honored                                          | F2, F3, F4, F9                                          |
| AC#10 explicit `AWAIT BEN'S MOCKUP SIGN-OFF` before app-wide restyle | The gate banner between F5 and F6                       |
| AC#11 pre-gate scaffolding gates green                               | F5                                                      |
| AC#12 post-gate briefing e2e; existing e2e pass                      | F8                                                      |

### 2. Placeholder scan

- No "TBD"/"TODO"/"implement later" in any implementation step. The two intentionally-narrative steps (D3
  Step 1 and F8 Step 1 reference existing harnesses) explicitly point to the concrete file to copy from
  (`ai-tools.test.ts`, `mock-briefings-api.ts`) and state the exact assertions — they are instructions to
  reuse a known pattern, not placeholders. D3's `expect(true).toBe(true)` is flagged in-step as "replace
  with the harness assertions described" — the engineer must fill it from the named source; this is the one
  spot requiring local lookup and is called out as such.
- Error handling is concrete (every branch returns a typed `ProposeFocusResult` with a specific message), not
  "add error handling".

### 3. Type consistency

- `ToolServices = Readonly<Record<string, unknown>>` defined in A1, consumed in A2 (gateway import), C3
  (`narrowCalendarWrite`), and as the 4th `ToolExecute` arg everywhere — consistent.
- `CalendarWriteService.proposeAndInsert(scopedDb: unknown, ctx: ToolContext, window: FocusBlockWindow)` —
  defined in C2, implemented in D1, called in C3's `execute` with the resolved `{start,end,title}` window.
  Consistent.
- `ProposeFocusResult` fields (`created`, `resolvedStart`, `resolvedEnd`, `shifted`, `conflict`,
  `googleEventId?`, `calendarMirror`, `message?`) — identical in C2 (interface), D1 (impl returns), and the
  tests in C3/D1/D2/D4. `conflict` union `"none"|"shifted"|"no-clear-slot"` consistent with `SlotChoice` in
  C1.
- `resolveWindow(input, now, tz)` / `chooseSlot(window, busy, durationMinutes)` — signatures identical in C1
  (definition), C3 (`execute`/`summarize` call `resolveWindow`), and D1 (`chooseSlot`). `chooseSlot` busy
  param is `{start: string; end: string}[]`, matching `GoogleFreeBusyResult.busy` from B1.
- `GoogleApiClient.freeBusy({accessToken, timeMin, timeMax, calendarId?})` and
  `insertEvent({accessToken, calendarId?, summary, start, end, timeZone?, extendedPrivateProperties?})` —
  defined in B1, called identically in D1.
- `hasCalendarWriteScope(scopedDb)` — defined in B2, called in D1.
- `buildCalendarWriteService({googleService, googleApiClient, connectorsRepository, calendarRepository})` —
  defined in D1, called in D3 (chat routes) and the D1/D2 tests.
- `upsertCachedEvent(scopedDb, {connectorAccountId, externalId, title, startsAt, endsAt, externalMetadata})` —
  consumed in D1 exactly as defined by the connector-sync slice's `CreateCachedCalendarEventInput`.

---

## FINAL GATE TASK: `pnpm verify:foundation` + `pnpm audit:release-hardening`

**Files:** (verification only — no code change unless a gate fails)

- [ ] **Step 1:** Ensure Postgres is up and migrations are current:

```bash
pnpm db:up && pnpm db:migrate
```

Expected: idempotent migration run succeeds (this slice adds no migration; connector-sync's 0065 applies if
present).

- [ ] **Step 2:** Run the full foundation gate (capture the real exit code — never pipe to `tail`):

```bash
pnpm verify:foundation; echo "EXIT=$?"
```

Expected: `EXIT=0` — lint, format:check, check:file-size (every web CSS file < 1000 lines), typecheck,
db:migrate, and the full integration suite (including `tests/integration/focus-time.test.ts` with the
no-write-without-approval safety property) all green.

- [ ] **Step 3:** Run the release-hardening audit:

```bash
pnpm audit:release-hardening; echo "EXIT=$?"
```

Expected: `EXIT=0`.

- [ ] **Step 4:** Run the web e2e suite (post-gate design tasks only; if the design restyle has not yet passed
      the mockup gate, run the focus-time + existing suites and note the design e2e as pending):

```bash
pnpm build:web && pnpm test:e2e; echo "EXIT=$?"
```

Expected: `EXIT=0` (all specs, incl. the new `briefing-reading.spec.ts` once F8 has landed post-gate).

- [ ] **Step 5:** Confirm Hard-Invariant guards with greps, then hand off for the **mandatory independent
      review** (this is the first real outbound write to a third party — per project memory, CI-green ≠ secure):

```bash
# calendar must NOT import connectors (module isolation linchpin)
grep -rn "@jarv1s/connectors" ~/Jarv1s/packages/calendar/src/ && echo "VIOLATION" || echo "OK: calendar has no connectors import"
# no token/secret in the action-request summary path (summarizeAssistantToolInput is key-names-only — unchanged)
grep -rn "accessToken\|refreshToken\|client_secret\|encryptedSecret" ~/Jarv1s/packages/calendar/src/ && echo "CHECK" || echo "OK: no secret names in calendar"
# the tool is risk:write and rides the existing gate (policy.ts unchanged)
git diff --quiet origin/main -- packages/ai/src/gateway/policy.ts && echo "OK: policy.ts unchanged" || echo "REVIEW: policy.ts changed"
```

The PR description MUST request an independent review confirming: (1) the tool is `risk:"write"` and cannot
write without an Approve (no path bypasses `confirmAndRun` — proven by D4); (2) no token/secret reaches the
tool I/O, the action-request summary, or any log; (3) `CalendarWriteService` is constructed only in the
composition host and `calendar` has no `connectors` import; (4) the scope check gates the insert. Recommend an
adversarial second opinion (`/codex-review` or a Claude critic) on the injection seam + the
no-write-without-approval property.

- [ ] **Step 6:** Live round-trip (manual, headless box, after merge): connect Ben's Google → in the drawer
      "block 2 hours tomorrow morning" → Approve → confirm a real event with the Jarvis tag in Google Calendar →
      confirm it appears on the Jarv1s Calendar page → request a busy window → confirm it shifts or reports no
      slot → deny a proposal → confirm **nothing** is created.
