# Module page write tools

Issue #1699. Unblocks Meals phase 2 (#3317) and Food page writes (#926).
Status: Draft (2026-10-25), awaiting Ben's approval.
Grounded on: `origin/main` at `ad69bc66e`.

## Problem

A downloaded module's own page can read through its tools but cannot save anything through them.

- `POST /api/ai/assistant-tools/:name/invoke` runs read tools only. Any other risk creates a
  pending action row and returns 403 `confirmation_required` without calling the tool
  (`packages/ai/src/routes.ts:968-990`).
- Nothing can ever run that pending row. Approving it over REST finds no live chat waiter and
  marks it expired (`packages/ai/src/gateway/action-request-lifecycle.ts:101-129`). The row holds
  only an input summary, so the call could not be replayed anyway (`routes.ts:973-982`).
- The queue route accepts small params but is async only: 202 plus a job id, a 5-second per-actor
  singleton, no result channel (`apps/api/src/external-module-jobs.ts:52`, `:81`, `:86`).
- Page writes such as ticking a shopping-list line happen many times a minute. Routing each one
  through a chat approval is unusable (Meals plan, Fork B).

### Issue claims checked

| Claim (2026-08-18)                                            | Now                                                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Read invoke 403s non-read tools at `routes.ts:645`            | True; moved to `routes.ts:968-990`                                                                                   |
| REST resolve "flips the DB row with nothing listening"        | Outdated. It now expires the row and returns 409 (`action-request-lifecycle.ts:107-129`)                             |
| Tool manifest can "declare it reversible"                     | Wrong. No reversibility field exists (`packages/module-sdk/src/external-module.ts:214-231`)                          |
| `executionPolicy` / `selfOperationGrant` exist on declaration | True (`external-module.ts:221-222`); they govern Moss acting alone, not a person's click (`gateway/policy.ts:42-80`) |
| Queue route async, 5 s singleton, no result channel           | True (`external-module-jobs.ts:10`, `:81`, `:86`)                                                                    |

## Seams this design relies on

| Capability                                                                       | Citation                                                                                 |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| External tools carry `isExternal`, `requiresConfirmation` and a worker `execute` | `packages/module-registry/src/external/tool-manifests.ts:225-241`                        |
| `requiresConfirmation` built from manifest `confirmWhen` / `confirmAbove`        | `tool-manifests.ts:137-153`                                                              |
| Host forces `actorUserId` into worker input, spread last                         | `apps/api/src/external-module-tools.ts:171-178`                                          |
| Worker SQL door uses the module's own tables, read-only for read risk            | `packages/module-registry/src/external/worker-rpc-host.ts:348-363`                       |
| External tools need no write-capable `ToolServices`                              | `tool-manifests.ts:240-241` (invoker takes db, input, context only)                      |
| Input validation shared with the read path                                       | `routes.ts:1014-1018`                                                                    |
| Result sanitising and size screen shared with the read path                      | `routes.ts:1039-1043`                                                                    |
| Module-reported error carries a `code`                                           | `external-module-tools.ts:311-324`                                                       |
| Per-session rate-limit key                                                       | `routes.ts:946-951`, `sessionRateLimitKey` from `@moss/module-sdk/server`                |
| Trusted-origin check pattern on a cookie POST                                    | `apps/api/src/companion-routes.ts:169-176`                                               |
| Platform route allowlist (routes owned by no module)                             | `packages/module-registry/src/route-guard.ts:35`, `:169-176`                             |
| Chat-blocked route rule for the read invoke                                      | `packages/module-registry/src/route-chat-rules.ts:62`                                    |
| Pending action rows, owner-only, with `expires_at`                               | `packages/ai/sql/0016_ai_assistant_actions.sql`, `0296_ai_action_origin_and_timeout.sql` |
| Origin-less action rows are never adopted into a chat thread                     | `packages/ai/sql/0298_ai_action_outcome_delivery.sql:1-3`                                |
| Host props handed to a module page, with an optional-prop precedent              | `apps/web/src/external-modules/loader.ts:11-21`                                          |
| Module bundle loads by dynamic import into the host page                         | `loader.ts:74-77`                                                                        |

## Decisions

### 1. Route

`POST /api/modules/:moduleId/tools/:name/invoke`

- A platform route in `apps/api`, beside the queue route. Added to `PLATFORM_UNGUARDED_ROUTES`.
- Serves downloaded modules only. The tool must come from the external tool manifests, carry
  `isExternal: true`, and belong to `:moduleId`.
- Unknown module, inactive module, unknown tool, or a tool owned by another module all return the
  same 404. This matches the web asset route's posture.
- The existing read invoke route is unchanged.

### 2. Request and response

Request body:

```ts
interface ModuleToolInvokeRequest {
  readonly input: Record<string, unknown>;
  /** Present only on the second call for a tool that needed confirmation. */
  readonly confirmationId?: string;
}
```

Responses reuse the read invoke's `invocation` envelope.

| Status                | Body                                                                                   | When                                                 |
| --------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 200                   | `{ invocation: { status: "succeeded", result } }`                                      | Tool ran                                             |
| 409                   | `{ invocation: { status: "blocked", reason: "confirmation_required" }, confirmation }` | Tool needs a person's confirmation                   |
| 409                   | `{ code: "confirmation_invalid" }`                                                     | Confirmation id expired, used, or does not match     |
| 400                   | `{ error }`                                                                            | Input fails the tool's input schema                  |
| 422                   | `{ code: "module_rejected", moduleCode? }`                                             | Module returned `status: "error"`                    |
| 413                   | `{ error }`                                                                            | Result too large to return                           |
| 401 / 403 / 404 / 429 | as named                                                                               | No session / untrusted origin / see 1 / rate limited |

```ts
interface ModuleToolConfirmation {
  readonly id: string;
  readonly expiresAt: string;
  readonly moduleName: string;
  readonly actionLabel: string;
  readonly risk: "write" | "outbound" | "destructive";
  readonly inputSummary: Record<string, unknown>;
}
```

- `moduleCode` passes through only when it matches the identifier shape (lower-case, dot, dash,
  underscore, at most 64 characters). Anything else is dropped. The page maps the code to its own
  copy. Free text from the module never reaches the response.

### 3. Which risk levels run

| Tool risk     | Runs directly                              | Needs confirmation               |
| ------------- | ------------------------------------------ | -------------------------------- |
| `read`        | Always                                     | Never                            |
| `write`       | When `requiresConfirmation` resolves false | When it resolves true, or throws |
| `destructive` | Never                                      | Always                           |
| `outbound`    | Never                                      | Always (see open question 2)     |

- The action family tier and `selfOperationGrant` are not consulted. Those settings say what Moss
  may do on its own. A page call is the person's own action. See Fork A.
- `requiresConfirmation` fails closed: a throw means confirm, as in the gateway
  (`packages/ai/src/gateway/gateway.ts`, `computeConfirmOverride`).
- Input validation runs before classification. Bad input returns 400 and never opens a dialog.

### 4. How a page-originated confirmation resolves

1. The first call classifies the tool as needing confirmation. The server writes a pending row to
   the existing action table with `origin = 'module_page'`, a SHA-256 digest of the canonical
   input, and a 2-minute `expires_at`. It returns 409 with `ModuleToolConfirmation`.
2. The host shows its own confirmation dialog, with host-authored wording built from the
   confirmation. The module never renders or words it.
3. On Confirm, the host repeats the call with the same input and `confirmationId`.
4. The server consumes the row in one conditional update. It flips the row from pending to
   confirmed only when owner, module, tool and input digest all match and the row has not
   expired. Zero rows updated returns `confirmation_invalid`. The row cannot be used twice.
5. The tool then runs on the same path as a direct call.
6. On Cancel, the host resolves the row as `cancelled` through the existing
   `POST /api/ai/assistant-actions/:id/resolve`. That path needs no live waiter for a cancel
   (`action-request-lifecycle.ts:131-142`). An abandoned row expires on its own.

- Chat cannot approve a page row. The REST approve path expires any row without a live waiter.
- A page cannot use a chat row. Chat rows have no input digest, so the match in step 4 fails.
- The AI module owns the action table. It exposes two functions on its public API, and the
  platform route calls them. The route never queries the table directly.

```ts
createModulePageConfirmation(db: DataContextDb, input: {
  moduleId: string; moduleName: string; toolName: string; permissionId: string;
  risk: "write" | "outbound" | "destructive"; inputSummary: Record<string, unknown>;
  inputDigest: Buffer; requestId: string;
}): Promise<{ id: string; expiresAt: Date }>;

consumeModulePageConfirmation(db: DataContextDb, input: {
  id: string; moduleId: string; toolName: string; inputDigest: Buffer;
}): Promise<boolean>;
```

- Schema: a new migration in `packages/ai/sql/` adds nullable `origin text` (check `module_page`
  or null) and nullable `input_digest bytea`. The `risk` check already admits `outbound`
  (`packages/ai/sql/0206_outbound_action_risk.sql:1-4`). No applied migration is edited.

### 5. Host contract for the page

A new optional prop on the module page, following the `assistantSurface` precedent
(`loader.ts:17-18`):

```ts
interface ExternalModuleToolsHandleV1 {
  invoke(name: string, input: Record<string, unknown>): Promise<ModuleToolOutcome>;
}

type ModuleToolOutcome =
  | { readonly status: "succeeded"; readonly result: Record<string, unknown> }
  | { readonly status: "cancelled" }
  | { readonly status: "rejected"; readonly moduleCode?: string }
  | { readonly status: "invalid_input" }
  | { readonly status: "failed" };
```

- The host binds `moduleId` by closure, as `createModuleHostActions` does
  (`apps/web/src/external-modules/host-actions.ts:64-78`).
- The handle drives the confirmation dialog itself. The page sees one awaited outcome.
- No contract version bump. A page built for the new host that loads on an older host finds the
  prop missing and must fail closed.

## Security and RLS

- **Actor.** Always the session user from `resolveAccessContext`. The worker receives
  `actorUserId` from the host, spread after caller input (`external-module-tools.ts:171-178`).
- **RLS.** The tool runs inside `withDataContext` for that actor. The worker writes only the
  module's own tables through its runtime role (`worker-rpc-host.ts:348-363`). No admin bypass.
- **Module-active gate.** Checked per request for the actor, before any classification.
- **Origin.** The request must carry an `Origin` in the trusted origin list. A missing `Origin` is
  refused (`companion-routes.ts:169-176`). This blocks other websites. It does not separate a
  module page from the host page, which share one origin.
- **Rate limit.** Own bucket, keyed by session fingerprint plus module id. Default 120 per minute,
  optional override `JARVIS_RL_MODULE_TOOL_MAX`. No new required setting.
- **Chat cannot call it.** A `self_authority` rule matching the new path is added beside the read
  invoke's rule (`route-chat-rules.ts:62`). The route is also absent from any manifest, so it is
  not in the action catalog.
- **Jobs and secrets.** Nothing is enqueued. Tool input is never logged or stored. The
  confirmation row keeps the existing input summary and a digest, both owner-only.

### What this route does not protect against

A module's page bundle loads into the host page by dynamic import (`loader.ts:77`). It runs with
the person's full session and can already call any route the host can, including other modules'
REST routes. So the `:moduleId` in the path is chosen by the caller, and a hostile bundle can name
another module. It could also complete its own confirmation without showing the dialog.

The confirmation step guards against honest mistakes and keeps "destructive always asks" true for
well-behaved modules. It is not a boundary against a hostile installed module. That boundary stays
where it is today: install review, RLS, and per-module table roles. Real isolation needs each
module page in a sandboxed frame. That is out of scope and listed as open question 4.

## Design forks

### Fork A: what decides whether a write runs without asking

| Option                                                                    | Verdict    |
| ------------------------------------------------------------------------- | ---------- |
| A1. Risk level plus the tool's own `requiresConfirmation` rules           | **Chosen** |
| A2. The issue's sketch: run only when `selfOperationGrant` and tier allow | Rejected   |

Steelman for A2: it reuses consent the person already saw at install (#1246) and adds no new
trust idea. The server cannot tell a click from a script, so treating page code like Moss acting
alone is the more cautious reading. A person who set a module to always confirm would see that
respected everywhere.

Why A1 wins:

- The tier answers "may Moss do this without me?" A click on the module's own page is the person
  doing it. First-party pages such as Tasks save on click whatever the Tasks tier says.
- A2 gives no containment. A page can already reach write-risk worker code through the queue run
  route with no tier check (`apps/worker/src/external-module-job-handler.ts:209`).
- A2 would make Meals unusable for anyone who leaves the default tier, which is the case the
  issue exists to fix.
- `requiresConfirmation` still lets a module author force a confirm for risky inputs.

### Fork B: how a destructive confirmation resolves

| Option                                                                      | Verdict    |
| --------------------------------------------------------------------------- | ---------- |
| B1. Single-use server confirmation id, bound to input, host-rendered dialog | **Chosen** |
| B2. Reuse the chat approval flow and its resolve route                      | Rejected   |
| B3. No server step; the module shows its own "are you sure" and calls once  | Rejected   |

Steelman for B3: no browser-side confirmation can be proven to come from a person (see above), so
the server step buys no security against a hostile module. One call is simpler for authors and
avoids a migration.

Why B1 wins over B3:

- It keeps one rule everywhere: destructive tools always ask (`gateway/policy.ts:54`).
- The host words the dialog, so every module's delete prompt looks and reads the same.
- A module bug that calls delete in a loop cannot delete anything without a matching second call.
- It leaves a durable record that a destructive page action was confirmed.

Why B2 loses: the chat waiter lives in memory in one gateway process, the row cannot replay the
input, and the resolve route now expires rows with no waiter (`action-request-lifecycle.ts:107-129`).

### Fork C: new module-scoped route or widen the read invoke

Steelman for widening `POST /api/ai/assistant-tools/:name/invoke`: one route, one envelope, less
code. Rejected because that route serves every module, including first-party tools whose write
services are only handed over after a chat approval (`routes.ts:1019-1026`). Widening it would
loosen first-party writes too. The new route admits external tools only.

## What does not change

- The read invoke route, its 403 for writes, and its rate limit.
- Chat confirmation semantics, action family tiers, YOLO, and self-operation grants.
- The queue run route and its singleton.
- Module page loading, CSS confinement and the `openAssistant` host action.
- No module may declare REST routes.

## Tests

Each line states the behaviour, then why a broken build fails it.

| #   | Behaviour                                                                                                                             | A broken build fails because                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | A write tool with no confirm rule returns 200 and its sanitised result; the worker stub saw the call once                             | A build that still routes writes to pending rows returns 409                                                                         |
| T2  | **Security, observed failing.** A destructive tool called without `confirmationId` returns 409 and the worker stub records zero calls | With the destructive branch deleted, the stub records one call. Run once with the branch removed and record the red result in the PR |
| T3  | **Security, observed failing.** A tool owned by module B called through `/api/modules/A/...` returns 404 and runs nothing             | With the owner check removed, the call succeeds. Record the red run in the PR                                                        |
| T4  | A confirmation id used twice: first 200, second `confirmation_invalid`                                                                | A check-then-update instead of one conditional update lets both run                                                                  |
| T5  | A confirmation id with different input returns `confirmation_invalid`                                                                 | A build that ignores the digest deletes whatever the second call names                                                               |
| T6  | A confirmation id from another user returns `confirmation_invalid`                                                                    | RLS or the owner match is missing                                                                                                    |
| T7  | A chat-created pending row id passed as `confirmationId` returns `confirmation_invalid`                                               | A build that matches only on id and tool lets a page approve a chat request                                                          |
| T8  | A write whose `confirmWhen` matches returns 409; a throwing hook also returns 409                                                     | A fail-open hook runs the write                                                                                                      |
| T9  | Inactive module returns 404 with the same body as an unknown module                                                                   | A distinct body reveals the module exists                                                                                            |
| T10 | Missing or foreign `Origin` returns 403 `invalid_origin`                                                                              | Without the check a cross-site form post runs a write                                                                                |
| T11 | Body carrying `actorUserId` of another user writes as the session user                                                                | Spread order reversed lets the caller pick the actor                                                                                 |
| T12 | Module returns `status: "error", code: "pantry.duplicate"` gives 422 with that code; a free-text code is dropped                      | A build that forwards module text leaks it to the page                                                                               |
| T13 | App action catalog refuses the new path                                                                                               | Missing chat rule lets Moss skip its own confirmation                                                                                |
| T14 | Live path: on a dev instance, Meals page ticks a list line (200) and deletes a plan through the host dialog                           | Unit stubs cannot show the real worker, RLS role and dialog working together                                                         |

## App map

- Core: add `CORE_APP_ERRORS` entries in `packages/shared/src/app-map-core.ts` for the host-owned
  failures a person can see on any module page. These are "confirmation expired, try again" and
  "too many changes, wait a moment".
- Core: describe the host confirmation dialog for module deletes in the existing module page
  wording.
- Each module declares its own page actions in its manifest `appMap`. Meals and Food do so in
  their own PRs.

## Open questions

**Decided by Ben, 2026-10-25.**

- Q1: yes. A page click runs a module's write tools whatever the Moss action tier says. Risky tools and tools that ask for their own confirmation still confirm.
- Q2: outbound tools always ask first, as drafted.
- Q3: 120 changes per minute per module is confirmed.
- Q4: sandboxed module page frames become a later task issue.
- Q6: page writes write an activity record, as chat writes do.
- Q5 stays with the plan author.

| #   | Question                                                                                                          | Owner                   |
| --- | ----------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | Approve Fork A: a page click runs a module's write tools whatever the Moss action tier says                       | Ben                     |
| 2   | Should a click run an `outbound` tool directly (the person pressed Send), or always ask as drafted?               | Ben                     |
| 3   | Is 120 changes per minute per module the right default for list-ticking pages?                                    | Ben                     |
| 4   | Do we want a later issue for sandboxed module page frames, the only real defence against a hostile bundle?        | Ben                     |
| 5   | Does anything act on rows in `confirmed` status (recovery, audit views) that would mis-handle `module_page` rows? | Plan author, seams pass |
| 6   | Should page writes write an activity record, as chat writes do?                                                   | Ben                     |
