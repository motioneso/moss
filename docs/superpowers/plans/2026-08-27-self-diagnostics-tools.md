# Build plan: self-diagnostics assistant tools (#2032)

Approved source: issue #2032 SPEC comment.

## Grounded seams

- `packages/ai/src/platform-diagnostics.ts:37-60` defines the query, report, and read-only service.
- `packages/ai/src/platform-diagnostics.ts:104-177` builds the report from injected read ports.
- `packages/settings/src/app-map-tool.ts:81-96` is the read-tool shape and fail-closed service lookup.
- `packages/chat/src/gateway-services.ts:195-218` puts platform diagnostics in `readToolServices` only.
- `packages/ai/src/gateway/gateway.ts:562-577` prevents read tools from receiving write services.
- `packages/news/src/personalization-routes.ts:195-213` is the shared asynchronous refresh trigger.
- `packages/news/src/chat-tools.ts:36-64` provides the configured dependencies and fail-closed seam.
- `packages/settings/src/source-inspector.ts:8-85` exposes bounded, sanitized source search results.
- `packages/module-registry/src/index.ts:2713-2746` constructs the platform diagnostics service.

The current branch has the earlier diagnostics machinery, but the report has no source result
field and no assistant tools. No migration, route, database access path, or generic action runner
is needed.

## Decisions

- Add `source` to the diagnostics report sections and return `source: SourceSearchResult | null`.
  When requested and a question is supplied, the service calls the existing inspector's bounded
  `search`; otherwise it returns null. The service receives `Pick<SourceInspector, "search">` and
  never creates a filesystem reader itself.
- Keep the settings package independent of `@moss/ai`: the tool uses a local structural type for
  `observe`, with the report fields declared explicitly in its output schema.
- The diagnostics input uses `question`, `module`, `include`, and `limit`; `question` maps to the
  service query, `module` maps to its existing domain filter, and all strings are bounded. Unknown
  input fields are rejected by `additionalProperties: false`; the handler also trims and bounds
  values before calling the service.
- The diagnostics tool has `settings.view` permission, read risk, no `requiresServices`, and is
  available only through the gateway read service bag.
- The refresh action calls `triggerNewsRefresh` once and returns `{ status: "queued" | "accepted",
asynchronous: true }`. It never says the refresh completed. It uses the existing
  `news_personalization` family, write risk, automatic execution policy, and install-time grant.

## Phase 1: expose the read-only diagnostics tool

Files: `packages/settings/src/platform-diagnostics-tool.ts`, `packages/settings/src/index.ts`,
`packages/settings/src/manifest.ts`, `packages/ai/src/platform-diagnostics.ts`,
`packages/module-registry/src/index.ts`.

Export bounded input/output schemas and `platformDiagnosticsExecute(input, ctx, services)` with the
`ToolExecute` signature. The handler reads only `services?.platformDiagnostics`, calls `observe`
with the actor and request context, and fails closed if absent. Add the source result contract to
the AI service and thread `createSourceInspector().search` at the existing composition seam.
Register `settings.platformDiagnostics` with `settings.view` and `risk: "read"`; do not add
`requiresServices`.

Test first with `tests/unit/platform-diagnostics-tool.test.ts`: valid bounded input reaches only
the supplied read service; unknown fields and overlong question/module values are rejected or
bounded; output sanitization drops undeclared fields; and a missing service fails closed. These
tests fail against a direct database/filesystem read or a tool that receives write services.

Kill gate: after the unit test and tool manifest validation pass, stop if the output cannot expose
the existing report without a second sanitizer or if the source result would require arbitrary file
reads. The lane agent makes this call and records it in the fleet log.

## Phase 2: add the confirmed asynchronous news refresh action

Files: `packages/news/src/chat-tools.ts`, `packages/news/src/manifest.ts`,
`packages/news/src/index.ts`.

Add `newsRefreshNewsExecute` and `summarizeNewsRefresh`. Use the configured repository, queue, and
actor through `triggerNewsRefresh`; return only the bounded queued/accepted status and an explicit
asynchronous marker. Register `news.refreshNews` beside the existing personalization tools with
empty bounded input, bounded output, confirmation summary, `news.prefs`, write risk,
`news_personalization`, `executionPolicy: "auto"`, and `selfOperationGrant: "granted_at_install"`.
Do not change the gateway confirmation, audit, or generic action code.

Add focused gateway coverage to `tests/integration/news-chat-tools.test.ts`: no refresh call before
confirmation; confirmation names `news.refreshNews`; confirmed execution calls the shared trigger;
the result says queued or accepted and asynchronous, never completed; and a missing queue remains
accepted without a false completion claim.

## Phase 3: assistant-path coverage and live proof

Extend `tests/integration/news-chat-tools.test.ts` or add
`tests/integration/self-diagnostics-chat.test.ts` using `AssistantToolGateway` to cover an actor's
diagnosis, confirmation, queued refresh, job completion, and second diagnosis. Assert safe
timestamps/status/item counts only, no provider bodies/article text/secrets, read services contain
diagnostics while write services do not, runtime is redacted for non-admins, and actor B cannot see
actor A's state or operational records. Reuse existing database reset, job wait, and audit wait
helpers.

Add `tests/uat/specs/2032-self-diagnostics.uat.spec.ts` and a blocking row in
`.claude/skills/coordinate/uat-trigger-map.tsv`. The UAT must exercise the real Moss conversation
on a live dev instance: diagnosis, confirmation, refresh, queued status, and successful recheck.
Post the command, exit code, visible assistant evidence, and updated freshness facts to the PR.
If the environment cannot drive the real chat turn, report code-complete, unverified rather than
claiming completion.

## Verification

- `pnpm vitest run tests/unit/platform-diagnostics-tool.test.ts` — expected exit 0.
- `pnpm vitest run tests/integration/news-chat-tools.test.ts tests/integration/self-diagnostics-chat.test.ts` — expected exit 0; run through the verify-gate procedure if database-backed.
- `pnpm format:check && pnpm lint && pnpm typecheck` — expected exit 0.
- `scripts/run-gate.sh start` then `scripts/run-gate.sh wait --follow` — expected exit 0; use the isolated gate database and inspect the runner exit code.
- `git diff --name-only origin/main...HEAD | rg 'migration|sql'` — expected no output.
- Run the blocking UAT selected by `resolve-uat-triggers.sh`; expected exit 0, or report code-complete, unverified with the reason.

All verification commands are unpiped. No database-touching test runs outside the verify-gate
procedure.
