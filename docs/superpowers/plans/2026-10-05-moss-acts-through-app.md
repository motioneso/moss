# Moss acts through its own app: build plan (#3065)

- **Spec:** `docs/superpowers/specs/2026-10-05-moss-acts-through-app-design.md` (approved by Ben,
  2026-10-05, PR #3066)
- **Issue:** #3065
- **Tree checked:** `340f03f4f` (spec branch head; `main` at `60505036c` plus the spec). Plan
  review fixes re-checked at `4918e2efa` (`main` after the spec merged); the cited code is
  unchanged between the two.
- **Scope:** phase 1 in detail, phase 2 in outline. Phase 2 is planned in detail only after the kill
  gate.
- **Delivery:** one worktree, one branch, one PR. Eight builder slices, each sized for one session.
  Phase 1 ships as one unit, so nothing merges until slice 8 records the live proof.

## 1. Seams

Every capability the plan relies on, cited at `340f03f4f`. Anything not citable is in section 1.9.

### 1.1 Sign-in and request handling

| Capability                                                                                              | Where                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One sign-in resolver: bearer session first, then cookie; returns `{ actorUserId, requestId }`           | `packages/auth/src/index.ts:409-475`                                                                                                                                                        |
| Resolver bound onto the runtime object                                                                  | `packages/auth/src/index.ts:206-213`                                                                                                                                                        |
| Runtime created once per server, overridable in tests                                                   | `apps/api/src/server.ts:255-262`                                                                                                                                                            |
| Callers read `authRuntime.resolveAccessContext` off the object; four capture the function value         | `apps/api/src/server.ts:434,448,464,572-574,705,723,923`; `companion-routes.ts:157`                                                                                                         |
| Resolutions per request: guard, handler, chat preHandler, error recorder (up to four)                   | `route-guard.ts:308-315`; `wellness/src/routes.ts:264`; `chat/src/meeting-chat-boundary.ts:72`; `server.ts:723`                                                                             |
| No shared per-request auth cache; one local precedent keyed on the request                              | `packages/calendar/src/day-plan-routes.ts:423,481,593`                                                                                                                                      |
| Error recorder attributes an actor only when `Authorization` or `Cookie` is present                     | `apps/api/src/server.ts:168-175`                                                                                                                                                            |
| Chat `jst_` tokens are refused on app routes (not a UUID session)                                       | `packages/db/src/auth-session.ts:18-20`                                                                                                                                                     |
| No global Origin or CSRF hook on app routes; better-auth's origin check runs only inside its own router | `server.ts:772` (only global hook); better-auth `dist/api/middlewares/origin-check.mjs:40`                                                                                                  |
| Only the two companion pairing routes demand a trusted Origin                                           | `apps/api/src/companion-routes.ts:164-172,223,238`                                                                                                                                          |
| `onRoute` collector records method and URL; `routeOptions.schema` is available there                    | `apps/api/src/server.ts:344-356`                                                                                                                                                            |
| Server factory and the point where boot-time services are built                                         | `apps/api/src/server.ts:226,249-254,572`                                                                                                                                                    |
| Gateway is constructed inside chat route registration, with the Fastify instance in scope               | `packages/chat/src/routes.ts:243,308,312`                                                                                                                                                   |
| No non-test `inject` use exists                                                                         | grep `\.inject(` over `apps/` and `packages/`: test files only                                                                                                                              |
| Global rate limit keys on bearer, cookie, else IP                                                       | `apps/api/src/server.ts:319-326,852-873`                                                                                                                                                    |
| Per-route rate limits use a shared key helper that also falls back to IP                                | `module-sdk/src/rate-limit-key.ts:70-72,81-87,95-101`; exported from `module-sdk/src/server.ts:6`                                                                                           |
| Per-route key helper users                                                                              | `chat/src/live-routes.ts:124-494` (9); `mcp-transport.ts:76`; `ai/src/routes.ts:903`; `settings/src/persona-routes.ts:134`, `proactive-monitoring-routes.ts:61`, `me-account-routes.ts:119` |
| Handlers run data access as the resolved actor                                                          | `packages/db/src/data-context.ts:54-71`                                                                                                                                                     |
| Timezone header hook                                                                                    | `apps/api/src/server.ts:771-778`                                                                                                                                                            |

**Spec open question 1, answered.** An injected `POST`/`PATCH`/`DELETE` with no `Origin` header
passes on every app route. No app-route hook checks origin (`server.ts:772` is the only global
`onRequest` besides the guard), and better-auth's origin middleware returns early when there is no
router request (`origin-check.mjs:40`), which is the case for the direct `getSession` call at
`auth/src/index.ts:451-455`. Companion pairing (`companion-routes.ts:223,238`) does check origin;
it is under `/api/companion`, which the path rule blocks anyway. Slice 2 adds an integration test
that would fail if this changed.

### 1.2 Route guard and manifests

| Capability                                                                                                                | Where                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Route manifest type: method, path, requestSchema, responseSchema, permissionId, featureFlag                               | `packages/module-sdk/src/index.ts:450-457`                        |
| Module manifest `routes` field                                                                                            | `packages/module-sdk/src/index.ts:695`                            |
| Built-in manifests are typed objects with no runtime validator, so a new key survives                                     | `packages/module-registry/src/index.ts:1697,3118,3147,3258`       |
| External modules cannot declare routes (`routes` is forbidden, manifest rebuilt)                                          | `packages/module-registry/src/external/validate.ts:62-79,491,852` |
| Platform routes with no manifest entry                                                                                    | `packages/module-registry/src/route-guard.ts:35-172`              |
| Route key and lookup helpers                                                                                              | `route-guard.ts:20-25,182,200-206`                                |
| Guard: module enablement only; `permissionId` never read                                                                  | `route-guard.ts:281-330`                                          |
| Route coverage assertion runs in `onReady`                                                                                | `route-guard.ts:226`; `server.ts:730-742`                         |
| Self-operation assertion runs in `onReady`                                                                                | `self-operation.ts:243`; `server.ts:749`                          |
| Route counts: 391 manifest routes, 85 with `requestSchema` (155 GET, 130 POST, 39 PATCH, 39 PUT, 28 DELETE in 13 modules) | grep over `packages/*/src/manifest.ts`                            |

The spec's 392 is the earlier count; 391 is what the grep finds at this commit. Slice 1's catalog
test reports the exact figure.

### 1.3 Gateway and tools

| Capability                                                                                          | Where                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Tools are manifest `assistantTools` with inline `execute`                                           | `packages/module-sdk/src/index.ts:590-668`                                                              |
| Handler signature `(scopedDb, input, ctx, services?)`                                               | `module-sdk/src/index.ts:150-155`                                                                       |
| Tool context: actor, request id, chat session id (actor plus surface), timezone; no conversation id | `module-sdk/src/index.ts:98-106`; built `gateway.ts:288-297`                                            |
| Current turn id by chat session                                                                     | `gateway.ts:797`; `ai/src/gateway/session-tokens.ts:150-160`                                            |
| `app.*` tools already live in Settings (`app.getMapSlice`)                                          | `packages/settings/src/manifest.ts:460`; `settings/src/app-map-tool.ts:81`                              |
| Service bundles, and read tools get the read-only bundle                                            | `chat/src/gateway-services.ts:129-219`; `gateway.ts:97,611,689-693`                                     |
| A read tool that declares `requiresServices` is hidden                                              | `gateway.ts:931`                                                                                        |
| Risk enum `read` / `write` / `outbound` / `destructive`                                             | `module-sdk/src/index.ts:64`                                                                            |
| Static `risk` is read at seven places                                                               | `gateway.ts:180,203,239,357,690,802`; `policy.ts:40-43`; `gateway-audit.ts:98`                          |
| `planCall` and YOLO branch; `resolvePolicy`                                                         | `gateway.ts:345-372`; `policy.ts:34-63`                                                                 |
| Confirm override can only force a confirm                                                           | `gateway.ts:713-730`                                                                                    |
| Auto-run rate limit (non-read) and YOLO rate limit                                                  | `gateway.ts:171,179-201`                                                                                |
| Read calls are not audited                                                                          | `gateway.ts:203`                                                                                        |
| Classifier gate dispatch reuses `planCall`; a confirm becomes `would_confirm`                       | `chat/src/live/classifier-gate-wiring.ts:193`; `gateway.ts:223-276`                                     |
| Self-operation categories and rules                                                                 | `ai/src/gateway/self-operation.ts:10-17,36-182`                                                         |
| `externalContent` flag, wrapper, and where it applies                                               | `module-sdk:646`; `output-validation.ts:22-25,80-88`; `run-tool-handler.ts:83-89`; `gateway.ts:616-620` |
| Rendered tool result cap, 16,000 characters                                                         | `ai/src/gateway/output-validation.ts:6,99-105`                                                          |
| Approval: pending row, wait, event shape                                                            | `gateway.ts:785-901` (event `832-838`); `gateway/types.ts:17-31`                                        |
| Approval preview type (email-shaped)                                                                | `module-sdk/src/index.ts:199-203`                                                                       |
| Approval wait timeout, 150 s                                                                        | `chat/src/live/persistent-claude-permission-hook.ts:19`; `confirmation-registry.ts:20-35`               |
| Approval resolve route                                                                              | `chat/src/routes.ts:589`; `gateway.ts:638-680`                                                          |
| Approval card props and render                                                                      | `apps/web/src/chat/action-request-card.tsx:8-16,74-120`                                                 |
| Tools reach Moss through MCP `tools/list`, not the app map                                          | `chat/src/mcp-transport.ts:113-116,393-399`; `gateway.ts:146`                                           |

### 1.4 Outside content: every admission path

| #   | Path                                                        | Where                                                                      | Slice 7 action                                     |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| a   | Memory seed at launch                                       | `chat/src/live/chat-session-launch.ts:93-98,111`                           | admit, taints                                      |
| b   | Replay of prior turns and summary at launch                 | `chat-session-launch.ts:99-119,160-165`; `persistence.ts:213-243`          | no new taint; the thread row carries it            |
| b3  | Native CLI resume                                           | `structured-claude-engine.ts:528-531`; `structured-gemini-engine.ts:91`    | as b                                               |
| c   | Per-turn passive memory recall                              | `chat/src/live/engine-text.ts:84-101`                                      | admit, taints                                      |
| d   | Per-turn cross-tool read (notes, email, calendar, tasks)    | `engine-text.ts:102-110`; `cross-tool-reasoning.ts:6,86-114`               | admit, taints                                      |
| e   | Per-turn notes retrieval                                    | `engine-text.ts:111-121`                                                   | admit, taints                                      |
| f   | Combiner that prepends c, d, e to the user text             | `engine-text.ts:154-160`; `chat-context-blocks.ts:41`                      | accepts admitted blocks only                       |
| g   | Attachment manifest (metadata only)                         | `chat-session-manager.ts:337-339`; `attachments-manifest.ts:12-27`         | no taint; file bytes come by tool                  |
| h   | Module control context from the request body                | `chat-session-manager.ts:340-342`; `live-routes.ts:817,855`                | admit, taints                                      |
| i   | Seed route                                                  | `live-routes.ts:446-479`; `chat-session-launch.ts:193-205`                 | admit, taints                                      |
| j   | Evening interview seed (briefing text)                      | `live-routes.ts:398-432,610-630`; `module-registry/src/index.ts:3713-3726` | admit, taints                                      |
| k   | Persona and system prompt                                   | `chat/src/live/runtime.ts:100-125,886-920`                                 | no taint                                           |
| l   | Tool results                                                | `ai/src/gateway/run-tool-handler.ts:80-90`                                 | taint unless the effective tool is `user_authored` |
| m   | Classifier-gate handled turn                                | `classifier-gate-lifecycle.ts:185`                                         | covered by l (gate calls go through the gateway)   |
| n   | Meeting chat                                                | `meetings/src/meeting-chat-service.ts:58,96`                               | out of scope: separate tool-less generation        |
| o   | Claude CLI native vault reads (`Read`, `Glob`, `Grep`)      | see 1.4.2                                                                  | hook reports first, taint recorded, then allow     |
| p   | Outside-agent (ACP) reads, web fetches, web searches, shell | `ai/src/gateway/acp-permission.ts:101,225,256-276,399`; `gateway.ts:564`   | taint on every allowed read, web or shell ask      |

Rows c, d and e run on every turn. A block taints only when it is admitted non-empty: an empty
recall, an empty notes block or an empty cross-tool read records nothing (decision 2.19).

#### 1.4.1 Read tools: the mark is opt-in today

`externalContent` is opt-in (`module-sdk/src/index.ts:641-646`; read at `gateway.ts:616-620`).
There are 51 `risk: "read"` declarations in 23 files and 13 `externalContent: true` marks. Read
tools that return text the user did not write, unmarked at this commit:

| Tool                                                                                   | Where                                    |
| -------------------------------------------------------------------------------------- | ---------------------------------------- |
| `email.listVisibleMessages`                                                            | `email/src/manifest.ts:207`              |
| `calendar.listVisibleEvents`                                                           | `calendar/src/manifest.ts:307`           |
| `chat.readAttachment`                                                                  | `chat/src/manifest.ts:380`               |
| `chat.getCurrentView` (visible screen text, which can show mail)                       | `chat/src/live/current-view-tool.ts:87`  |
| `chat.listTodaysTurns` (turns from other threads, so taint crosses threads)            | `chat/src/manifest.ts:352`               |
| `memory.recall`                                                                        | `memory/src/manifest.ts:227`             |
| `people.getContext`, `people.resolve`, `people.listRecent`                             | `people/src/tools.ts:86,100,116`         |
| `commitments.list`, `commitments.threadJudgements`, `commitments.get`                  | `commitments/src/manifest.ts:85,108,123` |
| `commitments.listVisible`                                                              | `structured-state/src/manifest.ts:48`    |
| `news.topHeadlinesToday`                                                               | `news/src/manifest.ts:321`               |
| `sports.followedFactsToday`                                                            | `sports/src/manifest.ts:417`             |
| `notifications.listVisible`                                                            | `notifications/src/manifest.ts:266`      |
| `tasks.list`, `get`, `focus`, `atRisk`, `overdue`, `listLists`, `listTags`, `activity` | `tasks/src/manifest.ts:533-624`          |
| `scratchpad.read`                                                                      | `scratchpad/src/manifest.ts:119`         |

A hand list drifts as modules add tools, so slice 7 inverts the default (decision 2.20): a read
tool's result taints unless the tool declares `content: "user_authored"`. The table is the slice 7
starting checklist, not the mechanism.

#### 1.4.2 Native file reads by engine

| Engine and path                                 | Native reads of the notes folders?                                        | Where                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude, persistent runtime (live chat)          | yes; hook allows vault reads before it reads the token, server never told | allowlist `claude-persistent-runtime.ts:268,282`; hook allow `persistent-claude-permission-hook.ts:295-296`; token `:301`; `postPermission` `:234-246` |
| Claude, one-shot engine                         | yes; hook has no server URL or token at all                               | `structured-claude-engine.ts:542,550-553`; hook allow `persistent-claude-permission-hook.ts:552-553`; writer `:329-358`                                |
| Claude, tmux launch                             | yes, through the same persistent hook                                     | `module-build-launch-commands.ts:95,102-105`                                                                                                           |
| Gemini, one-turn engine and tmux launch         | no; built-in tools list is empty                                          | `structured-gemini-engine.ts:170-179`; `module-build-launch-commands.ts:243-259`                                                                       |
| Codex, persistent exec runtime and tmux launch  | no; shell and patch off, read-only sandbox, no notes folder passed        | `codex-persistent-runtime.ts:310-331`; `module-build-launch-commands.ts:129-163`                                                                       |
| Outside agents over ACP (Codex, Claude, Google) | possibly, and web fetches too; every ask reaches the gateway in-process   | `acp/src/client.ts:325,606,647`; `chat/src/routes.ts:500-523`; `acp-permission.ts:4-5,225`                                                             |

Vault roots: `vault-allowlist.ts:18-33`; set in prod (`docs/operations/deploy.md:67`,
`infra/docker-compose.prod.yml:205`). The native permission route is `POST /internal/permission`
(`chat/src/mcp-transport.ts:358-383`, body parser `:441-457`, manifest `chat/src/manifest.ts:332`).
It treats every body as a new permission ask, so a read report needs its own route (contract 4.6).

Outside agents bring outside text in through more than file reads. Their policy allows in-folder
reads, every web search and public web fetches with no card, and always asks for shell
(`acp/src/permissions.ts:13-19`; `classifyWeb` at `:259-263`). `WebFetch` and `WebSearch` are the
web family (`acp/src/tool-table.ts:48`). Moss's own tools pass through to the gateway
(`permissions.ts:12,287-289`), so a fetched page can steer a later Moss write. Every permission
request the agent raises, card or not, enters `requestAcpBuiltInPermission`, where the family is
already known (`acp-permission.ts:101,248`). It allows at two exits: the YOLO early return
(`:256-276`) and the final return (`:399`).
Whether an ACP agent asks permission for plain in-folder reads is not verified (1.9).

### 1.5 Durable conversation, deletion, migrations

**Spec open question 3, answered.**

| Capability                                                                                    | Where                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation table `app.chat_threads`, `id uuid` primary key                                  | `packages/chat/sql/0014_chat_module.sql:23-29`                                                                                         |
| Thread insert                                                                                 | `packages/chat/src/repository.ts:213`; `live/persistence.ts:463`                                                                       |
| Current thread by actor plus surface                                                          | `live/persistence.ts:490`; `chat-session-launch.ts:51-55`                                                                              |
| Session key is actor plus surface                                                             | `chat/src/live/chat-surface.ts:18-23`                                                                                                  |
| Live session holds no thread id                                                               | `chat-session-launch.ts:144-157`                                                                                                       |
| Launch resolves the thread before it mints the session token; token minted per session key    | `chat-session-launch.ts:51-55,67`; `getCurrentThreadState` returns `{ id, incognito }` `persistence.ts:490-499`                        |
| Session token identity: actor, chat session id, tool allowlist; no thread                     | `ai/src/gateway/session-tokens.ts:3-11,91,106`                                                                                         |
| Tool context built from the verified token                                                    | `gateway.ts:288-297`; type `module-sdk/src/index.ts:98-106`                                                                            |
| Resume touches the new thread first, then stops the turn and kills the engine                 | `session-runtime-helpers.ts:473-494`                                                                                                   |
| Clear chat stops first                                                                        | `session-runtime-helpers.ts:392-424`                                                                                                   |
| Gate tokens are minted per gate run with a correlation id; the gate request carries no thread | `classifier-gate-runner.ts:132,230`; `chat/src/routes.ts:412-424`; `classifier-gate.ts:146`; caller `classifier-gate-lifecycle.ts:102` |
| Resume, new chat: kill engine, then relaunch                                                  | `session-runtime-helpers.ts:392-424,458-496`                                                                                           |
| Restart: first turn relaunches through one path                                               | `chat-session-manager.ts:292,904-911`; `chat-session-provider-identity.ts:145-175`                                                     |
| No user-facing thread delete                                                                  | `packages/chat/sql/0276_meeting_chat_cleanup.sql:2`                                                                                    |
| Private purge deletes the thread row                                                          | `session-runtime-helpers.ts:330-368`; `persistence.ts:501-507`; `0146:42-55`                                                           |
| Orphan sweep                                                                                  | `session-runtime-helpers.ts:498-518`; `chat-session-manager.ts:914`                                                                    |
| Meeting thread cleanup                                                                        | `meeting-chat-boundary.ts:192-199`; `0277:44`                                                                                          |
| Account deletion cascades from users                                                          | `0014_chat_module.sql:25`                                                                                                              |
| Cascade precedent on thread id                                                                | `0014_chat_module.sql:33`                                                                                                              |
| Owner-only RLS pattern to copy                                                                | `packages/chat/sql/0149_chat_skills.sql:20-44`                                                                                         |
| Migrations registered in the chat manifest                                                    | `packages/chat/src/manifest.ts:43-73`                                                                                                  |
| One global migration sequence; highest is `0283`                                              | `packages/db/src/migrations/sql-runner.ts:179-186,198`                                                                                 |

Every path that removes a thread deletes the `app.chat_threads` row, so a foreign key with
`ON DELETE CASCADE` removes the provenance row on all of them.

### 1.6 Consent and assistant-facing promises

| Promise or gate                                                          | Where                                                                   | Effect in this plan                                                               |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Wellness AI consent, the only consent gate; defaults on for active users | `wellness/src/ai-consent.ts:5,11-20`                                    | every Wellness route declares `consent`                                           |
| Assistant never reads therapy notes                                      | `wellness/src/manifest.ts:296-300`                                      | therapy-note routes `blocked`                                                     |
| Medication counts only, never a list                                     | `wellness/src/manifest.ts:252`; `wellness/src/settings/index.tsx:52,56` | medication row and name routes `blocked`                                          |
| Scratchpad: read and append, never replace or delete                     | `scratchpad/src/manifest.ts:44,128`                                     | `PUT /api/scratchpad` `blocked`                                                   |
| Others' private meetings never included                                  | `meetings/src/manifest.ts:123`                                          | already enforced by RLS; no change                                                |
| Private chats never sent to the classifier                               | `chat/src/manifest.ts:246`                                              | unaffected                                                                        |
| Backtrack: chat cannot answer from it yet                                | `shared/src/app-map-core.ts:100`                                        | stays true: no Backtrack route returns text (`backtrack/src/manifest.ts:123-125`) |

Wellness routes whose responses carry withheld data:

| Route                                    | Carries             | Where                                 |
| ---------------------------------------- | ------------------- | ------------------------------------- |
| `GET /api/wellness/therapy-notes`        | note bodies         | `routes.ts:381`; `serialize.ts:75-79` |
| `POST /api/wellness/therapy-notes`       | note body           | `routes.ts:397`                       |
| `GET /api/wellness/medications`          | name, dosage, notes | `routes.ts:226`; `serialize.ts:29-36` |
| `POST /api/wellness/medications`         | the stored row      | `routes.ts:242`                       |
| `PATCH /api/wellness/medications/:id`    | the stored row      | `routes.ts:260,284`                   |
| `GET /api/wellness/medications/schedule` | medication names    | `routes.ts:291`; `schedule.ts:48`     |
| `GET /api/wellness/medications/logs`     | medication names    | `routes.ts:439-466`                   |

Any other therapy-note or medication route found while classifying follows the same rule.

### 1.7 Screen refresh

**Spec open question 2, answered.** A tool declares `affectsQueryKeys` (`module-sdk:652-659`). The
gateway copies it onto `action_result` on success (`gateway.ts:419-422,880-888`). The web parses
it (`apps/web/src/chat/use-chat-stream.ts:374-378`) and invalidates resolved keys
(`apps/web/src/shell/app-shell.tsx:260-279`, resolver `apps/web/src/api/query-keys.ts:175`). The
resolver only resolves array leaves, so a whole-module token does nothing. Keys start with the
module name (`query-keys.ts:139`). Sports and News keep their own key lists
(`sports/src/web/query-keys.ts:8`, `news/src/web/query-keys.ts:5`). The existing test
`tests/unit/settings-affects-query-keys.test.ts` checks that every declared token resolves.

### 1.8 Source reading and tests

| Capability                                                             | Where                                                                                     |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Image keeps the whole tree under `/app`                                | `Dockerfile:31,34,59-60`                                                                  |
| Install root found by walking up to `pnpm-workspace.yaml`, else `/app` | `packages/module-registry/src/resolve-modules-dir.ts:24-41`                               |
| Inject-based integration tests                                         | `tests/integration/settings-themes.test.ts`, `tests/integration/wellness.test.ts`         |
| Browser tests against a real instance                                  | `tests/uat/specs/`, run by `tests/uat/run-uat.ts`                                         |
| Scripted fake model cannot finish an approval round trip               | `tests/uat/specs/2911-shadow-delete.uat.spec.ts:9-14`                                     |
| Real-model browser test with an approval card, gated on configuration  | `tests/uat/specs/2911-shadow-delete-real.uat.spec.ts`                                     |
| Theme routes; there is no fetch-one-theme route                        | `settings/src/manifest.ts:175-199`; `settings/src/themes-routes.ts:49,76,105,125-148,162` |

### 1.9 Open questions

| Question                                                                                                                                         | Owner           | Default if unanswered                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Fastify's default request log omits headers, so the grant header never reaches a log. Not verified past the serializer config at `server.ts:250` | slice 2 builder | a test captures logs from an injected call and asserts the grant value is absent                                                        |
| Do Sports and News query keys start with the module id?                                                                                          | slice 5 builder | the module declares `chatDefaults.refresh` with its own tokens                                                                          |
| Can the scripted fake model be extended to finish an approval?                                                                                   | slice 8 builder | approval cases run in the real-model browser test                                                                                       |
| Does anything write files under `packages/*/src` or `apps/*/src` at runtime?                                                                     | slice 5 builder | grep for writes; any hit is excluded from source reading                                                                                |
| Can an outside agent over ACP read a file, fetch or search the web, or run a command without raising a permission request?                       | slice 7 builder | taint on every allowed read, web or shell ask; if any of them can run without an ask, every outside-agent thread is tainted from launch |
| Reopen the July locked items one by one (persona, skills, memory settings)?                                                                      | Ben, later      | stay `blocked`                                                                                                                          |

## 2. Design decisions taken in planning

1. **Catalog covers built-in modules only.** External modules cannot declare routes
   (`validate.ts:62-79`). Platform-allowlisted routes have no manifest entry, so they are never in
   the catalog.
2. **The grant lives in the auth package.** One wrapper replaces `authRuntime.resolveAccessContext`
   right after `server.ts:262` and before `server.ts:434`. Four callers capture the function value
   (`server.ts:434,448,574,705`), so a wrap placed any later misses them. It adds the grant check
   and a request-scoped cache for every request. Slice 2 tests that a captured caller sees the
   grant.
3. **Grant header and cookie are exclusive.** A request carrying the grant header and also
   `Authorization` or `Cookie` is refused.
4. **Rate-limit key for grant calls is `act:<actorUserId>`, in both key functions.** Without it,
   every user's injected calls share one `127.0.0.1` bucket. The global limiter
   (`server.ts:852-873`) and the shared per-route helpers (`rate-limit-key.ts:81,95`, used by five
   modules) both check the grant header first. They peek the grant without consuming it.
5. **Per-call policy hook on the gateway, not a manifest field.** The gateway takes an optional map
   of per-call resolvers by tool name. Chat registers one for `app.callAction`. It runs right after
   input validation and returns an effective tool (risk, `externalContent`, forced confirm, title,
   card rows, modules to refresh) or a refusal. Every downstream reader of `risk` (1.3) uses the
   effective tool.
6. **The outside-content rule is a `planCall` input.** `planCall` gains `conversationTainted`. When
   it is true and the effective risk is not `read`, or the call carries `confirmWhenTainted`, the
   outcome is confirm, before the YOLO branch.
   The classifier gate inherits it, because it reuses `planCall` (`gateway.ts:223-276`).
7. **Destructive routes always ask through `app.callAction`, YOLO included.** The resolver sets the
   forced confirm. Dedicated destructive tools keep today's YOLO behaviour.
8. **Taint is looked up by the thread bound at launch.** The launch already resolves the thread
   before it mints the session token (`chat-session-launch.ts:51-55,67`). The thread id goes into
   the token's identity and from there onto the tool context (`gateway.ts:288-297`). The gate
   request carries the same id into the gate token. The provenance port reads the row for that id.
   A missing thread id, a missing row, or a thread owned by someone else means tainted. Looking up
   the actor's current thread instead races with resume, which touches the new thread before it
   stops the old turn (`session-runtime-helpers.ts:473-494`). Nothing is cached in memory.
9. **Admission is enforced by type.** Context blocks reach the prompt combiner only as an
   `AdmittedContext` value, and only the admission function makes one. A source test backs this up
   (slice 7).
10. **New threads get a clean row in the same transaction as the thread insert.** Threads from
    before this ships have no row and count as tainted.
11. **The provenance row is not in the user data export.** It is derived metadata, not user content.
12. **`content` governs every response, not only reads.** A write's response enters the model's
    context too, so a route's `content` class decides whether any response taints and gets wrapped.
    Default `"outside"`. A write route or write tool whose response only echoes the user's own
    record (theme, weather unit, a People entry, a preference) declares `"user_authored"`, so a
    clean thread stays clean across a run of changes. Slices 3 to 5 make that call per route and
    per tool.
13. **Target names come from a module-owned resolver.** A route may declare `chat.target`, a
    function that reads the target's label under the user's own data context. Required on
    `destructive` routes with a path parameter (28 `DELETE` routes in 13 modules, plus any
    destructive `POST`). Themes need it because there is no fetch-one-theme route.
14. **New block category `module_promise`.** Covers routes a module has promised the assistant
    will not use (Scratchpad replace). Wellness withheld-data routes use the existing
    `data_scope_consent`.
15. **Result cap is the existing 16,000-character renderer cap.** The spec's 32 KB is looser than
    the cap every tool result already passes through (`output-validation.ts:6`), so a second cap
    would never bind.
16. **Refresh by module.** `action_result` gains `affectsModules`. The web invalidates by module
    prefix. A module whose keys do not start with its id declares refresh tokens instead.
17. **The boot assertion is wired into `onReady` only in slice 4**, once every route is classified.
    Slice 1 lands it with tests on synthetic manifests. No interim allowance flag.
18. **`findAction` lists manifest-blocked routes with their reason**, so Moss can say why it cannot
    act. Routes blocked by path rules are left out of results.
19. **Only a non-empty admitted block taints.** Paths c, d and e run every turn. An empty recall,
    notes block or cross-tool read records nothing, so a clean thread stays clean until outside text
    actually arrives. A tool result taints whatever its length, because the call happened.
20. **Read tools taint by default.** Every tool with `risk: "read"` declares
    `content: "user_authored" | "outside"`. A boot assertion fails on any read tool that declares
    neither, mirroring decision 12 for routes. `externalContent: true` stays as the wrapping flag
    and implies `"outside"`; `"user_authored"` with `externalContent: true` fails the assertion.
    External module tools default to `"outside"` with no declaration needed.
21. **Native vault reads stay, and the server hears each one first.** Moss uses them heavily. The
    hook sends a read report to the server, which records `tool_external_content` before the hook
    allows the read. If the report fails or the token is missing, the hook denies the read. Both
    hook copies change, and the one-shot hook gains the report URL and token. Gemini and Codex give
    no native reads (1.4.2). Outside agents over ACP ask the gateway in-process. It records taint on
    every allowed ask in the read, web or shell family, at both allow exits, because a fetched page
    or a `curl` brings outside text in as surely as a file read. Keeping the agent out of the notes
    folders would not cover the web. If slice 7 finds an agent can read, fetch or run a command
    without raising an ask, its threads are tainted from launch.
22. **July families are blocked by two independent nets.** `CHAT_BLOCKED_PATH_RULES` gains path
    patterns for every family with routes (the list in 4.2), so a new route in a family is caught
    without a table row. A pattern may block writes only where reading is harmless. Separately, a
    test walks every July prefix, not every rule, across all modules. Each prefix maps to at least
    one blocked route or sits in a named no-routes list with a reason. A route can live outside the
    rule's module (task-agency auto-execution is a settings rule with a tasks route), so the walk
    never limits itself to one module.
23. **A `GET` that sends model-chosen text to a third party is `outbound`.** Routes may declare
    `chat.outbound: true`. A `GET` with it asks when the thread is tainted and runs without asking
    otherwise. Weather location search is the known case
    (`settings/src/weather-location-search-routes.ts:28-38`).
24. **The catalog reaches the actions service through a holder.** The gateway is built during
    `registerBuiltInApiRoutes` (`server.ts:574`; `chat/src/routes.ts:312`), before `onReady`. The
    actions service takes a `RouteCatalogHolder`; `onReady` fills it. A call before then is refused
    as not ready.
25. **A destructive-looking `POST` must say so.** A `POST` whose path contains `clear`, `reset`,
    `purge`, `delete` or `remove` must be `destructive` or `blocked`, unless it is on a short named
    allowlist with a reason.

## 3. Determinism boundary

- The approval card renders from the gateway's record: the route's `chat.title`, the target from
  the module's resolver, the exact fields sent, and the tainted notice. No model text reaches it.
- Refusals render from the catalog: unknown route, blocked with category, consent off.
- The tainted notice renders from the provenance row.
- A module never injects turns into the host chat.
- The model has two jobs: pick the route, and fill in its inputs.
- Server validation is the boundary validator for model-authored inputs. The card's field rows are
  the before/after acceptance surface: the user sees exactly what will be sent.
- Guidance budget: the three tool descriptions together stay under 150 words. A test counts them.

## 4. Contracts

### 4.1 Manifest types (`packages/module-sdk/src/index.ts`)

```ts
export type RouteChatAccess = "read" | "write" | "destructive" | "blocked";

export type RouteChatTargetResolver = (
  db: DataContextDb,
  params: Readonly<Record<string, string>>
) => Promise<string | null>;

export interface RouteChatPolicy {
  readonly access: RouteChatAccess;
  readonly blockedBecause?: SelfOperationExclusionCategory; // required when access is "blocked"
  readonly title?: string; // required unless access is "read" or "blocked"
  readonly content?: "user_authored" | "outside"; // default "outside"; applies to every response
  readonly consent?: string; // must equal the module's aiConsent.key when the module has one
  readonly target?: RouteChatTargetResolver; // required for destructive routes with a path param
  readonly coveredBy?: string; // name of a dedicated tool that does the same job
  readonly outbound?: boolean; // GET only: sends model-chosen input to a third party
}

// ModuleAssistantTool gains (required when risk is "read", boot assertion, decision 2.20;
// optional otherwise, default "outside"; decision 2.12):
//   readonly content?: "user_authored" | "outside";

export interface ModuleAiConsent {
  readonly key: string;
  isGranted(db: DataContextDb, actorUserId: string): Promise<boolean>;
}

// ModuleRouteManifest gains:   readonly chat?: RouteChatPolicy;
// ModuleManifest gains:        readonly chatDefaults?: Partial<RouteChatPolicy>;
//                              readonly aiConsent?: ModuleAiConsent;
//                              readonly chatRefreshTokens?: readonly string[];
```

`SelfOperationExclusionCategory` moves to `module-sdk` (re-exported from `ai`) and gains
`"module_promise"`.

### 4.2 Route catalog (`packages/module-registry/src/route-catalog.ts`, new)

```ts
export interface CapturedRouteSchema {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
  readonly querystring?: unknown;
  readonly params?: unknown;
}

export interface CatalogRoute {
  readonly moduleId: string;
  readonly method: string;
  readonly path: string;
  readonly policy: RouteChatPolicy & { readonly content: "user_authored" | "outside" };
  readonly inputShape: { body?: unknown; querystring?: unknown; params?: unknown } | null;
}

export interface RouteCatalog {
  readonly routes: readonly CatalogRoute[];
  resolve(
    method: string,
    concretePath: string
  ): { route: CatalogRoute; params: Record<string, string> } | null;
  search(query: string, limit: number): readonly CatalogRoute[];
}

export function buildRouteCatalog(
  manifests: readonly ModuleManifest[],
  captured: readonly CapturedRouteSchema[]
): RouteCatalog;

export function assertRouteChatClassification(manifests: readonly ModuleManifest[]): void;

export interface RouteCatalogHolder {
  get(): RouteCatalog | null; // null until onReady fills it
  set(catalog: RouteCatalog): void; // once; a second call throws
}

export function createRouteCatalogHolder(): RouteCatalogHolder;

export const CHAT_BLOCKED_PATH_RULES: readonly {
  readonly pattern: RegExp;
  readonly category: SelfOperationExclusionCategory;
  readonly writesOnly?: boolean; // true: GET on the path stays classifiable
  readonly julyPrefixes?: readonly string[]; // SELF_OPERATION_EXCLUSIONS prefixes this rule covers
}[];

export const JULY_EXCLUDED_ROUTES: readonly {
  readonly method: string;
  readonly path: string;
  readonly category: SelfOperationExclusionCategory;
  readonly julyPrefixes: readonly string[];
}[];

export const JULY_PREFIXES_WITHOUT_ROUTES: readonly {
  readonly prefix: string; // a toolNamePrefixes entry in SELF_OPERATION_EXCLUSIONS
  readonly reason: string;
}[];

export const DESTRUCTIVE_WORD_POST_ALLOWLIST: readonly {
  readonly path: string;
  readonly reason: string;
}[];

export function assertReadToolContentDeclared(manifests: readonly ModuleManifest[]): void;
```

`inputShape` prefers the Fastify schema captured in `onRoute`, then the manifest `requestSchema`.
`search` is deterministic word matching over title, path segments and module id. No model call.

Assertion rules (each its own error message naming the route):

- Every route resolves to an access class from its own `chat` block or `chatDefaults`.
- `GET` is never `write` or `destructive`. `DELETE` is never `read` or `write`.
- `blocked` carries `blockedBecause`. `write` and `destructive` carry `title`.
- A route whose path matches `CHAT_BLOCKED_PATH_RULES` is `blocked` with that category, whatever
  the manifest says. Paths: `/api/admin/*`, `/api/auth/*`, onboarding, `/api/companion/*`,
  `/api/mcp`, `/internal/*`, assistant-tool invoke, action-request resolve, workflow approval
  resolve, module queue runs. July families (decision 2.22), matched by pattern so a new route in
  the family is caught without a table row:
  - `/api/ai/action-policy` and below (`ai/src/manifest.ts:604,610`): `self_authority`
  - `/api/ai/chat-model-override` (`ai/src/routes.ts:615,634`): `self_authority`
  - `/api/ai/service-bindings`, `/api/ai/services/:service/binding`: `self_authority`
  - `/api/me/yolo`, `/api/connectors/accounts/:id/feature-grants`: `self_authority`
  - `/api/ai/providers` and below (add, default, revoke, models): `assistant_brain`
  - `/api/me/persona` and below (`settings/src/manifest.ts:242,252,257`): `prompt_shaping`
  - `/api/chat/skills` and below, every method (`chat/src/skills/routes.ts:47-157`):
    `prompt_shaping`
  - `/api/me/modules/:id`, writes only (`settings/src/manifest.ts:374`): `self_authority`
  - `/api/tasks/agency-auto-execute`, writes only (`tasks/src/manifest.ts:487`): `self_authority`
  - `/api/chat/memory/settings`, `/api/chat/page-context`, writes only
    (`chat/src/manifest.ts:293,298`): `prompt_shaping`
  - `/api/me/source-behaviors` and below, `/api/me/priority-model`, `/api/me/notes-source` and
    below, writes only (`settings/src/manifest.ts:212,267,277`): `prompt_shaping`
  - `/api/ai/voice-endpoint`, every method (`ai/src/manifest.ts:498`): `secrets`
  - `/api/ai/terminal/password`, `/api/ai/terminal/ticket` (`ai/src/manifest.ts:515,520`): `secrets`
  - `/api/news/credentials`, `/api/news/sources/credentialed`, `/api/news/sources/:id/credential`,
    every method (`news/src/manifest.ts:285-305`): `secrets`
  - `/api/wellness/ai-consent`, writes only (`wellness/src/manifest.ts:127`): `data_scope_consent`.
    The consent gate already refuses it while consent is off; the pattern blocks it outright.
- Every route in `JULY_EXCLUDED_ROUTES` is `blocked` with that category. The July rules match
  tool names (`self-operation.ts:36-182`), not routes, so slices 3 and 4 add a row for each route
  that does what an excluded tool family does and that no path pattern already covers.
- A separate test, not the assertion, walks every `toolNamePrefixes` entry of every rule in
  `SELF_OPERATION_EXCLUSIONS`, across all modules, not only the rule's own. Each prefix must be
  named in the `julyPrefixes` of a path rule or a `JULY_EXCLUDED_ROUTES` row through which at least
  one catalog route is blocked with the rule's category, or appear in
  `JULY_PREFIXES_WITHOUT_ROUTES` with a reason. One blocked route no longer clears a whole rule, and
  a new prefix with neither fails the test.
- `outbound` is allowed only on `GET` routes with access `read`.
- A `POST` whose path contains `clear`, `reset`, `purge`, `delete` or `remove` is `destructive` or
  `blocked`, unless it is in `DESTRUCTIVE_WORD_POST_ALLOWLIST`.
- Every route in a module with `aiConsent` declares `consent` equal to its key.
- A `destructive` route with a `:param` in its path declares `target`.
- `coveredBy` names a tool that exists in some built-in manifest.

`assertReadToolContentDeclared` fails on any built-in `risk: "read"` tool with no `content`, and on
`content: "user_authored"` together with `externalContent: true`. It runs in `onReady` beside the
self-operation assertion (`server.ts:749`).

### 4.3 Act-as grant (`packages/auth/src/act-as-grants.ts`, new)

```ts
export const ACT_AS_GRANT_HEADER = "x-moss-act-as";
export const ACT_AS_GRANT_TTL_MS = 30_000;

export interface ActAsBinding {
  readonly actorUserId: string;
  readonly chatSessionId: string;
  readonly turnId: string | null;
}

export interface ActAsGrantRegistry {
  mint(binding: ActAsBinding): string; // 256-bit random, base64url
  consume(value: string): ActAsBinding | null; // single use; null when unknown, used or expired
  peekActor(value: string): string | null; // for the rate-limit key; does not consume
}

export function createActAsGrantRegistry(now?: () => number): ActAsGrantRegistry;

export function withActAsGrantsAndRequestCache(
  runtime: MossAuthRuntime,
  grants: ActAsGrantRegistry
): MossAuthRuntime;
```

The wrapper's `resolveAccessContext(request)`:

- returns the cached context when the request already resolved;
- with the grant header and no `Authorization`/`Cookie`, consumes the grant and returns
  `{ actorUserId, requestId }`, or throws the standard 401;
- with the grant header plus other auth material, throws the standard 401;
- otherwise delegates;
- caches on success in a `WeakMap` keyed on the request object.

The grant value never appears in a log, prompt, job payload, response or error.

### 4.4 Calling a route (`packages/chat/src/app-actions.ts`, new)

```ts
export interface AppActionCallInput {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Record<string, string>;
  readonly body?: unknown;
}

export interface AppActionsService {
  catalog(): RouteCatalog | null;
  call(input: AppActionCallInput, ctx: ToolContext): Promise<{ status: number; body: unknown }>;
}

export function createAppActionsService(deps: {
  server: FastifyInstance;
  catalog: RouteCatalogHolder;
  grants: ActAsGrantRegistry;
  readTurnId(chatSessionId: string): string | null;
}): AppActionsService;
```

`call` mints a grant and injects with headers `x-moss-act-as`, `content-type: application/json`
and `x-timezone` from the tool context. It never sends cookies or bearer tokens. Before `onReady`
fills the holder, `call` and the resolver refuse with `not_ready` (decision 2.24).

### 4.5 Per-call gateway policy (`packages/ai/src/gateway/types.ts`)

```ts
export interface CallCardDetails {
  readonly target: string | null;
  readonly fields: readonly { readonly label: string; readonly value: string }[];
}

export type PerCallResolution =
  | {
      readonly kind: "refuse";
      readonly reason: "unknown_route" | "blocked" | "consent_off" | "not_ready";
      readonly category?: SelfOperationExclusionCategory;
    }
  | {
      readonly kind: "proceed";
      readonly risk: ModuleAssistantToolRisk;
      readonly externalContent: boolean;
      readonly forceConfirm: boolean;
      readonly confirmWhenTainted: boolean; // an outbound GET: risk stays "read"

      readonly summary: string;
      readonly details: CallCardDetails;
      readonly affectsModules: readonly string[];
    };

export type PerCallResolver = (
  input: Record<string, unknown>,
  ctx: ToolContext
) => Promise<PerCallResolution>;

// AssistantToolGateway deps gain:
//   readonly perCallResolvers?: Readonly<Record<string, PerCallResolver>>;
//   readonly provenance?: ConversationProvenancePort;

// ToolContext (module-sdk/src/index.ts:98-106) gains:
//   readonly threadId?: string; // bound at launch; absent means tainted
// SessionIdentity (ai/src/gateway/session-tokens.ts:3-11) gains:
//   readonly threadId: string | null;
// GateRequest (chat/src/live/classifier-gate.ts:146) gains:
//   readonly threadId: string | null;
```

`action_request` events gain `details?: CallCardDetails` and `outsideContentNotice: boolean`.
`action_result` events gain `affectsModules?: readonly string[]`.

### 4.6 Provenance port and admission

```ts
// packages/ai/src/gateway/types.ts
export type AdmissionPath =
  | "tool_external_content"
  | "app_action_outside"
  | "attachment_read"
  | "recall_memory_turn"
  | "recall_cross_tool"
  | "recall_notes"
  | "launch_memory_seed"
  | "seed_route"
  | "evening_seed"
  | "module_control_context"
  | "native_vault_read"
  | "outside_agent_read"
  | "outside_agent_web"
  | "outside_agent_shell"
  | "outside_agent_launch"; // only if slice 7 finds an agent acting without an ask (1.9)

export interface ConversationProvenancePort {
  // threadId undefined, no row, or a thread the actor does not own => true
  isTainted(actorUserId: string, threadId: string | undefined): Promise<boolean>;
  recordAdmission(actorUserId: string, threadId: string, path: AdmissionPath): Promise<void>;
}

// packages/chat/src/live/context-admission.ts (new)
export interface AdmittedContext {
  readonly text: string;
  readonly __admitted: unique symbol;
}

export function admitToContext(
  deps: { recordForThread(threadId: string, path: AdmissionPath): Promise<void> },
  threadId: string,
  path: AdmissionPath,
  text: string
): Promise<AdmittedContext | null>; // null for empty or whitespace text; nothing recorded

// packages/chat/src/mcp-transport.ts, beside the native permission route
// POST /internal/vault-read-report   Bearer session token
// body: { toolName: "Read" | "Glob" | "Grep", toolInput: object, cwd: string }
// 204 after the admission is recorded; any failure is non-2xx and the hook denies the read.
```

The prompt combiner (`chat-context-blocks.ts:41`) and the launch and seed submit sites accept only
`AdmittedContext`. The report route is declared in the chat manifest beside
`/internal/permission` (`chat/src/manifest.ts:332`) and is under `/internal/*`, so chat can never
call it. It records against the thread bound to the token, never one named in the body.

### 4.7 Migration DDL (`packages/chat/sql/NNNN_chat_conversation_provenance.sql`)

`NNNN` is the next free number at build time (`0284` today). Register it in the chat manifest
`migrations` and `ownedTables` (`chat/src/manifest.ts:43-73`).

```sql
CREATE TABLE app.chat_conversation_provenance (
  thread_id uuid PRIMARY KEY REFERENCES app.chat_threads (id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  tainted_at timestamptz,
  first_admission_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((tainted_at IS NULL) = (first_admission_path IS NULL))
);

ALTER TABLE app.chat_conversation_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_conversation_provenance FORCE ROW LEVEL SECURITY;

CREATE POLICY chat_conversation_provenance_select ON app.chat_conversation_provenance
  FOR SELECT TO jarvis_app_runtime USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY chat_conversation_provenance_insert ON app.chat_conversation_provenance
  FOR INSERT TO jarvis_app_runtime WITH CHECK (owner_user_id = app.current_actor_user_id());
CREATE POLICY chat_conversation_provenance_update ON app.chat_conversation_provenance
  FOR UPDATE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id() AND tainted_at IS NOT NULL);
CREATE POLICY chat_conversation_provenance_delete ON app.chat_conversation_provenance
  FOR DELETE TO jarvis_app_runtime USING (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.chat_conversation_provenance TO jarvis_app_runtime;
```

The update policy's `WITH CHECK` means a row can become tainted but never clean again. The builder
copies role and function names from `0149_chat_skills.sql:20-44` if they differ from the above.

### 4.8 The three tools (Settings manifest, beside `app.getMapSlice`)

| Tool             | Risk                                       | Input                                                       | Services                   |
| ---------------- | ------------------------------------------ | ----------------------------------------------------------- | -------------------------- |
| `app.findAction` | read                                       | `{ query: string, limit?: number }` (limit 1-20, default 8) | read bundle: `appCatalog`  |
| `app.readSource` | read                                       | `{ path: string, startLine?: number, endLine?: number }`    | none                       |
| `app.callAction` | write (static; per call from the resolver) | `AppActionCallInput`                                        | write bundle: `appActions` |

`findAction` returns per route: method, path, module, access, title, input shape or `null`,
`coveredBy`, and for blocked routes the category. `readSource` roots are `packages/*/src` and
`apps/*/src` under the install root (`resolve-modules-dir.ts:24-41` walk-up), extensions `.ts`,
`.tsx`, `.json`, `.md`, 400 lines per call, `realpath` must stay under a root. `app.callAction`
needs a `selfOperationGrant` (`self-operation.ts:283-287`).

## 5. Phase 1 slices

All slices share worktree `~/Jarv1s-3065` and branch `feat/3065-moss-acts-through-app`, and one
PR. Each slice ends with its tests green, a commit, and a push. The order is fixed: 1 to 8. Slice
2 uses slice 1's `RouteCatalog` and `RouteCatalogHolder` types, so it runs second.

Every slice's brief carries the gate's own checks, scoped to files touched:

```bash
npx tsc --noEmit > /tmp/3065-tsc.log 2>&1; echo "TSC=$?"                            # expect 0
npx tsc -p tsconfig.tests.json --noEmit > /tmp/3065-tsc-tests.log 2>&1; echo "TSCT=$?" # expect 0
npx eslint <files touched> --max-warnings=0 > /tmp/3065-lint.log 2>&1; echo "LINT=$?" # expect 0
npx prettier --check <files touched> > /tmp/3065-fmt.log 2>&1; echo "FMT=$?"          # expect 0
pnpm check:file-size > /tmp/3065-size.log 2>&1; echo "SIZE=$?"                        # expect 0
```

Database-touching tests run only through the `verify-gate` skill. Slice 1 adds a package script
`test:integration:3065` listing this work's integration files (precedent: `test:integrations` in
`package.json:88`), and each later slice appends to it.

```bash
scripts/run-gate.sh start --gate test:integration:3065   # then, backgrounded:
scripts/run-gate.sh wait --follow                         # expect exit 0
```

### Slice 1: route classification framework

- **Files:** `packages/module-sdk/src/index.ts` (types 4.1);
  `packages/module-registry/src/route-catalog.ts` (new, 4.2);
  `packages/ai/src/gateway/self-operation.ts` (category moves to module-sdk, adds
  `module_promise`); `apps/api/src/server.ts` (`onRoute` also captures schemas; a
  `RouteCatalogHolder` is created in the server factory before `registerBuiltInApiRoutes` at
  `:572-574` and passed into chat's deps; `onReady` builds the catalog and fills the holder);
  `package.json` (`test:integration:3065`).
- **Tests:** `packages/module-registry/src/route-catalog.test.ts`
  - Unclassified route fails the assertion. Fails if the access-class check is removed.
  - `GET` classed `write` fails; `DELETE` classed `read` fails. Fails if the method check is
    removed.
  - A route under `/api/admin/` classed `write` is forced `blocked` in the catalog and fails the
    assertion. Fails if the path rules are removed.
  - A route listed in `JULY_EXCLUDED_ROUTES` but not `blocked` fails.
  - Consent module route without `consent` fails; destructive `:id` route without `target` fails.
  - `resolve("DELETE", "/api/me/themes/abc")` returns the route and `{ id: "abc" }`; an unknown
    path returns `null`.
  - `search("delete theme")` ranks the theme delete route first on a synthetic set.
  - `outbound: true` on a `POST` fails; on a `GET` classed `read` passes.
  - A `POST /api/x/reset` classed `write` fails; the same path in
    `DESTRUCTIVE_WORD_POST_ALLOWLIST` passes. Fails if the word check is removed.
  - A synthetic route under `/api/me/persona` or `/api/chat/skills` classed `write` is forced
    `blocked` with `prompt_shaping`. Fails if the July path patterns are removed.
  - A writes-only rule forces `PATCH` on its path `blocked` and leaves `GET` on the same path at
    its declared class. Fails if `writesOnly` is ignored in either direction.
  - The walk, over a synthetic rule with two prefixes where only one is mapped, fails naming the
    other prefix. Fails if the walk goes per rule.
  - `assertReadToolContentDeclared`: a read tool with no `content` fails; `user_authored` with
    `externalContent: true` fails; an external module's tool needs no declaration.
  - The holder returns `null` before `set` and throws on a second `set`.
  - Each assertion test is observed failing with its check removed; record the observation in the
    commit message.
- **Done:** catalog builds from real manifests in a unit test that prints the route count; the
  assertion is not yet wired to boot.

### Slice 2: act-as grant and the auth seam

- **Files:** `packages/auth/src/act-as-grants.ts` (new, 4.3); `apps/api/src/server.ts` (wrap after
  `:262` and before `:434`; grant-aware rate-limit key at `:852-873`; `hasAuthMaterial` at
  `:168-175` recognises the grant header); `packages/module-sdk/src/rate-limit-key.ts` (both
  helpers return `act:<actor>` for a grant request, peeking only);
  `packages/chat/src/app-actions.ts` (new, 4.4, `call` only).
- **Tests:**
  - `packages/auth/src/act-as-grants.test.ts`: single use; expiry at 30 s with an injected clock;
    `peekActor` does not consume; values differ across mints.
  - `packages/module-sdk/src/rate-limit-key.test.ts`: a request with the grant header and no other
    auth yields `act:<actor>`; the grant is still consumable afterwards.
  - `tests/integration/app-actions-grant.test.ts`:
    - A guarded module route (`PUT /api/me/themes/:id`, which the guard and the handler both
      resolve) succeeds through `call`. Fails if the request cache is removed.
    - Replaying the same grant on a second request returns 401.
    - An expired grant returns 401.
    - A request with a made-up grant value returns 401. Observed failing when the wrapper is
      changed to accept any grant header value.
    - Grant plus cookie returns 401.
    - Row-level security: a call as user A cannot read or change user B's row.
    - A `POST` with no `Origin` header passes (pins the answer in 1.1).
    - Rate-limit key: two users' injected calls land in different buckets, on the global limiter
      and on a route that uses the shared per-route helper (`ai/src/routes.ts:896-904`). Fails
      if either key function is left on the IP fallback.
    - A caller that captured the resolver before the wrap point (module preference routes,
      `server.ts:434`) accepts a grant. Fails if the wrap moves after `:434`.
    - Captured server log output from an injected call does not contain the grant value.
- **Done:** all of the above green through `run-gate.sh`; each security test observed failing with
  its protection removed, recorded in the commit message.

### Slice 3: classify platform and settings routes

- **Modules:** settings (71), ai (44), chat (39), connectors (15), integrations (10),
  notifications (6), backtrack (3), workflows (4), proactive-monitoring (2), usefulness-feedback
  (5 after the record-only route correction in 8.6).
- **Files:** each module's `src/manifest.ts`: `chatDefaults` plus per-route `chat` blocks, titles,
  `target` resolvers for destructive routes with a path parameter (in the owning module, under
  `src/chat-targets.ts`), `coveredBy` where a dedicated tool does the job.
- **Rules:** the July rules decide `blocked` (`self-operation.ts:36-182`); each such route that
  no path pattern in 4.2 covers gets a row in `JULY_EXCLUDED_ROUTES`.
  `GET /api/me/weather-location/search` is `read` with `outbound: true`. Theme routes are
  `write` except `DELETE /api/me/themes/:id`, which is `destructive` with a target resolver reading
  the theme name. `PUT /api/me/themes/mode` has `coveredBy: "settings.themeMode.set"`. Write
  routes whose response only echoes the user's own record declare `content: "user_authored"`
  (decision 2.12): theme, weather unit, preference and similar settings routes.
- **Tests:** `tests/unit/route-chat-classification.test.ts` runs the assertion over these modules'
  real manifests; a snapshot of `(method, path, access, category)` for every route in these
  modules, reviewed in the PR. It also names these routes and expects each `blocked` with the
  stated category, and fails if any is reachable:
  - `PATCH /api/ai/action-policy/:moduleId/:actionFamilyId`: `self_authority`
  - `GET` and `PUT /api/me/persona`, `POST /api/me/persona/preview`: `prompt_shaping`
  - `/api/chat/skills`: `POST`, `PATCH /:id`, `PATCH /:id/enabled`, `DELETE /:id`,
    `POST /import`: `prompt_shaping`
  - `PUT /api/ai/chat-model-override`: `self_authority`
  - `PATCH /api/me/modules/:id`: `self_authority`
  - `PATCH /api/chat/memory/settings`, `PUT /api/chat/page-context`: `prompt_shaping`
  - `PUT /api/me/source-behaviors/:id`, `PATCH /api/me/priority-model`, `PUT /api/me/notes-source`:
    `prompt_shaping`
  - `PUT /api/ai/voice-endpoint`, `POST /api/ai/terminal/password`, `POST /api/ai/terminal/ticket`:
    `secrets`
- **July walk:** `tests/unit/july-rules-route-walk.test.ts` (4.2) runs per prefix. It is green for
  every prefix whose routes live in these modules; prefixes whose routes live in slice 4 modules
  are listed in the test as pending until slice 4.
- **Done:** every route in these modules classified; assertion green over them.

### Slice 4: classify content routes and wire the boot assertion

- **Modules:** tasks (27), sports (24), news (22), meetings (19), memory (18), people (18),
  wellness (16), calendar (13), commitments (7), workshop (7), briefings (6), email (6), goals (5),
  scratchpad (4), notes (1), weather (1).
- **Files:** each module's `src/manifest.ts` and `src/chat-targets.ts` as in slice 3;
  `packages/wellness/src/manifest.ts` gains `aiConsent` built on `resolveEffectiveWellnessConsent`
  (`ai-consent.ts:11-20`); `apps/api/src/server.ts` calls `assertRouteChatClassification` in
  `onReady` beside `assertRouteCoverage`.
- **Rules:** July-excluded routes get rows in `JULY_EXCLUDED_ROUTES`, as in slice 3. The seven
  Wellness routes in 1.6 are `blocked` / `data_scope_consent`.
  `PUT /api/scratchpad` is `blocked` / `module_promise`. Every Wellness route declares
  `consent: "wellness.ai_consent_granted"`. Write routes that only echo the user's own record
  declare `content: "user_authored"`; People create/update were planned examples, but the handler
  audit in 8.7 blocks their ingestion effects. Routes whose response
  carries mail, feed or other outside text stay `"outside"`.
- **Tests:**
  - The slice 3 snapshot test extends to all modules.
  - The slice 3 named-route test extends with these, each expected `blocked` with the stated
    category and unreachable:
    - `PATCH /api/tasks/agency-auto-execute`: `self_authority`
    - `PUT /api/wellness/ai-consent`: `data_scope_consent`
    - the news credential routes (`news/src/manifest.ts:285-305`), every method: `secrets`
  - The July walk test covers every prefix across all modules and its pending list is empty;
    prefixes with no route are in `JULY_PREFIXES_WITHOUT_ROUTES` with a reason, reviewed in the PR.
  - Server boot test: an injected unclassified route fails `onReady`. Observed failing with the
    wiring removed.
  - Wellness list test: the set of Wellness routes not `blocked` equals an explicit list in the
    test. A new Wellness route forces a decision.
- **Done:** the API boots with the assertion on; all 393 current routes classified (including
  the record-only feedback route and the previously host-injected People directory route).

### Slice 5: the three tools, the card, and screen refresh

- **Files:**
  - `packages/settings/src/manifest.ts`, `packages/settings/src/app-action-tools.ts` (new): three
    tool declarations and handlers. Existing dedicated write tools that only echo the user's own
    record (theme mode and the like) declare `content: "user_authored"` (decision 2.12).
  - `packages/chat/src/app-actions.ts`: the per-call resolver for `app.callAction` (route resolve,
    blocked refusal, consent check, target lookup, card rows, `affectsModules`,
    `confirmWhenTainted` for `outbound` routes, `not_ready` while the holder is empty).
  - `packages/chat/src/gateway-services.ts`, `packages/chat/src/routes.ts`: services `appCatalog`
    (read bundle) and `appActions` (write bundle); register the resolver.
  - `packages/ai/src/gateway/gateway.ts`, `policy.ts`, `gateway-audit.ts`, `types.ts`: per-call
    resolver hook producing the effective tool; every `risk` reader in 1.3 uses it; events carry
    `details`, `outsideContentNotice` (false until slice 7) and `affectsModules`.
  - `apps/web/src/chat/action-request-card.tsx`: target and field rows, as plain text rows using
    existing primitives (use the `design-system` skill first).
  - `apps/web/src/chat/use-chat-stream.ts`, `apps/web/src/shell/app-shell.tsx`: invalidate by
    module prefix from `affectsModules`, plus a module's `chatRefreshTokens`.
- **Order inside the gateway:** validate input, run the per-call resolver (refusals stop here,
  consent included, before any grant exists), then `planCall`, then confirm or run, then `call`.
- **Tests:**
  - `packages/ai/src/gateway/per-call-resolver.test.ts`: a resolver returning `destructive` makes a
    tool with static `write` confirm under YOLO; returning `read` skips the auto-run rate limit and
    audit. Fails if any `risk` reader still uses the static value.
  - `tests/integration/app-actions-tools.test.ts`:
    - Blocked and unknown routes are refused, nothing injected (spy on `call`).
    - An admin calling `/api/admin/*` is refused.
    - Consent off: a Wellness write route is refused and the result holds no row data. Observed
      failing with the consent check removed.
    - Consent on: calling every blocked Wellness route returns a refusal; the sentinel medication
      name and therapy-note body never appear in any tool result. Observed failing with the block
      removed.
    - Two deletes of different themes produce `action_request` events with different targets,
      each naming the theme.
    - A `write` returns `affectsModules: ["settings"]` on success.
    - An oversized response is truncated by the existing cap with its note.
    - A call before the holder is filled is refused `not_ready`, nothing injected.
    - Weather location search resolves with `confirmWhenTainted: true` and risk `read`.
  - `packages/settings/src/app-action-tools.test.ts`: `readSource` refuses `../` escapes, a symlink
    pointing outside a root, `.env`, and `.js`; returns at most 400 lines; the three tool
    descriptions total under 150 words.
  - `tests/unit/module-query-key-prefix.test.ts`: every module with routes either has query keys
    whose first segment is its id or declares `chatRefreshTokens`, and every token resolves.
  - `tests/e2e/app-shell.spec.ts`: the card renders target and field rows from an `action_request`
    event (component wiring only; the real path is proven in slice 8).
- **Done:** the tools work end to end in integration tests. Not yet exercised on live data.

### Slice 6: provenance store, thread binding, and the confirm rule

- **Files:**
  - `packages/chat/sql/NNNN_chat_conversation_provenance.sql` (4.7) and the chat manifest.
  - `packages/chat/src/conversation-provenance.ts` (new): repository and the port (4.6); clean row
    inserted with the thread (`repository.ts:213`, `persistence.ts:463`).
  - `packages/ai/src/gateway/session-tokens.ts`: `SessionIdentity.threadId`.
  - `packages/chat/src/live/chat-session-launch.ts`, `chat-session-ports.ts`, `runtime.ts:714`:
    `mintMcpToken` takes the thread id resolved at `:51-55`.
  - `packages/ai/src/gateway/gateway.ts:288-297` and `module-sdk/src/index.ts:98-106`: the tool
    context carries `threadId` from the verified token.
  - `packages/chat/src/live/classifier-gate.ts:146`, `classifier-gate-lifecycle.ts:102`,
    `classifier-gate-runner.ts:132,230`, `chat/src/routes.ts:412-424`: the gate request and gate
    token carry the turn's thread id.
  - `packages/ai/src/gateway/gateway.ts`, `policy.ts`: `planCall` takes `conversationTainted`
    from `isTainted(actor, ctx.threadId)`. When true, non-`read` risk or `confirmWhenTainted`
    confirms, before the YOLO branch.
- **Tests:** `tests/integration/conversation-provenance-binding.test.ts`
  - A tool call whose context has no thread id is treated as tainted: a `write` asks. Observed
    failing when a missing id is treated as clean.
  - Resume race: taint thread A, start a turn on A, resume clean thread B mid-turn, then let A's
    in-flight `write` arrive. It asks. Fails if taint is looked up by the actor's current thread.
  - A gate call for a turn on a tainted thread returns `would_confirm`. A gate call with no thread
    id does the same.
  - A token minted for thread A cannot read thread B's row (B owned by another user): tainted.
  - A tainted thread stays tainted after resume and after a simulated restart (new manager, same
    database).
  - A thread with no row counts as tainted.
  - Purging a private chat deletes its provenance row.
  - User B cannot read or update user A's row; a tainted row cannot be set back to clean.
  - Each protection test observed failing with its check removed.
- **Done:** taint decides confirm for every gateway path, keyed by the bound thread. Nothing
  records taint yet except direct port calls in tests.

### Slice 7: every admission path records taint

- **Files:**
  - `packages/chat/src/live/context-admission.ts` (new) and every admission site in 1.4 (a, c, d,
    e, h, i, j) routed through `admitToContext`; the combiner takes `AdmittedContext` only. Empty
    text returns `null` and records nothing (decision 2.19).
  - `packages/ai/src/gateway/gateway.ts`, `run-tool-handler.ts`: a tool result records
    `tool_external_content` unless the effective tool is `user_authored`; `app.callAction` records
    `app_action_outside` for `outside` routes; `chat.readAttachment` records `attachment_read`.
    The card's notice is set from the row.
  - Every built-in read tool declares `content` (decision 2.20). The 1.4.1 table is the starting
    checklist. `apps/api/src/server.ts` calls `assertReadToolContentDeclared` in `onReady`.
  - `packages/chat/src/live/persistent-claude-permission-hook.ts`: both hook copies send a read
    report to `POST /internal/vault-read-report` before allowing a vault read, and deny when the
    report fails or the token is missing. The one-shot hook's settings writer (`:335-358`) and
    `structured-claude-engine.ts:542` pass it the report URL and token file.
  - `packages/chat/src/mcp-transport.ts` and `chat/src/manifest.ts`: the report route (4.6).
  - `packages/ai/src/gateway/acp-permission.ts:225`: every allowed ask records by family, at both
    allow exits (YOLO `:256-276`, final `:399`): `read` records `outside_agent_read`, `web`
    records `outside_agent_web`, `shell` records `outside_agent_shell`. A failed record denies the
    ask. If the 1.9 question finds an agent acting without an ask, the ACP session launch records
    `outside_agent_launch` instead.
  - `apps/web/src/chat/action-request-card.tsx`: one notice line when `outsideContentNotice`.
- **Tests:**
  - `tests/integration/conversation-provenance.test.ts`:
    - Automatic notes recall with a matching note, followed by `settings.themeMode.set`, asks,
      with no notes tool called.
    - A turn where recall, notes and cross-tool reads all come back empty leaves the thread clean,
      and a `write` runs without asking under YOLO. Fails if an empty block records an admission.
    - Launch memory seeding with at least one memory taints the same way.
    - After an outside read, `app.callAction` on a `write` route asks, and weather location search
      asks.
    - `chat.listTodaysTurns` in a clean thread, returning turns from another thread, taints it.
    - Switching from a tainted thread to a clean thread leaves the clean one clean.
    - On a clean thread under YOLO, two writes in a row both run without asking: `app.callAction`
      on a `user_authored` write route, then `settings.themeMode.set`. The thread is still clean
      after both. Fails if a `user_authored` write response records an admission, or if the
      routes and tools are left at the `"outside"` default.
    - Native vault read: the persistent hook script, run against a test server with a vault path,
      reports the read; the thread is then tainted; a following `write` asks. Fails if the hook
      allows before reporting.
    - The report route returns an error: the hook denies the read. The token file is missing: the
      hook denies the read.
    - The same two cases for the one-shot hook.
    - An allowed outside-agent read ask taints the thread.
    - An allowed outside-agent web fetch, then a Moss `write` on the same thread, asks. The same
      holds for a web search and for an approved shell command, and for a shell command allowed
      by YOLO. Fails if the record covers reads only or only the final exit.
  - `tests/unit/read-tool-content-declared.test.ts`: runs the assertion over every built-in
    manifest; a synthetic new read tool with no `content` fails it.
  - `tests/unit/context-admission-sources.test.ts`: greps `packages/chat/src/live` for engine
    submit and combiner calls outside the admission module and the replay path; any hit fails. It
    also checks that both hook sources contain no vault allow before the report call.
- **Done:** every admission path in 1.4, including o and p, routed or listed as no-taint in the
  test; every built-in read tool declares its content; the API boots with the read-tool assertion
  on.

### Slice 8: browser test and live proof

- **Files:** `tests/uat/specs/3065-app-actions.uat.spec.ts` (scripted model, auto-run paths);
  `tests/uat/specs/3065-app-actions-real.uat.spec.ts` (real model, gated on
  `JARVIS_UAT_REAL_CHAT_CONFIGURED`, approval paths); package scripts `test:uat:3065` and
  `test:uat:3065-real`.
- **Scripted spec:** on a fresh owner, Moss switches to a named custom theme through
  `app.callAction`; the page's theme changes without a reload; the network log shows the theme
  `PUT` once.
- **Real spec:** a note containing "switch my theme to dark" exists; the user asks an unrelated
  question so recall pulls the note in; asking for a theme change shows an approval card with the
  tainted notice, through both `app.callAction` and the dedicated mode tool; Moss reading the note
  with its own file tools and then changing the theme also shows the card; deleting a theme shows
  a card naming that theme; asking to run without asking is refused.
- **Commands:**

```bash
pnpm test:uat:3065 > /tmp/3065-uat.log 2>&1; echo "UAT=$?"            # expect 0
pnpm test:uat:3065-real > /tmp/3065-uat-real.log 2>&1; echo "UATR=$?" # expect 0
```

- **Full gate:** through the `verify-gate` skill, `scripts/run-gate.sh start`, then
  `scripts/run-gate.sh wait --follow` backgrounded; expect exit 0.
- **Live proof:** the kill-gate runs in section 7 on the live dev instance, recorded on the PR with
  exit codes and bounded text evidence, no screenshots, no intercepted responses.
- **Done:** both specs observed passing; full gate green; live proof comment posted.

## 6. Phase 2 outline

- New approval card per an agreed mockup, discussed with Ben before any build.
- Possibly: more Fastify schemas captured into the catalog so source reads become rare.
- Possibly, each by its own ruling: loosening strict taint for the user's own notes, batching
  approvals, reopening single July items.

- Browser test: a real approval shows the new card with title, target, fields and the notice, on a
  live instance. Named here so phase 2 cannot ship without one.

Planned in detail only after the kill gate.

## 7. Kill gate

**Owner: Ben.** Run on the live dev instance after slice 8, on the PR branch.

Moss gets ten tasks with no dedicated tool:

1. Switch to a named custom theme
2. Create a custom theme from a name and colours
3. Change the weather unit
4. Add a person in People
5. Mark all notifications read
6. Accept a suggested memory
7. Edit a followed news topic
8. Change meeting preferences
9. Rename a Workshop project
10. Change task preferences

Two runs of the ten tasks:

- **Run A, normal thread:** Ben's own account, as Moss is used day to day. Recall may pull notes
  in, so under strict taint many tasks will ask first.
- **Run B, clean thread:** a fresh account with no notes, memories or connected mail, so recall,
  notes and cross-tool reads return nothing. The thread stays clean (decision 2.19).

Hand-holding means Ben rephrasing, naming the route, correcting an input, or retrying. Approving an
approval card is not hand-holding: the design intends those asks. The record has one row per task
per run: succeeded or not, hand-holding count, approval-card count, and whether the screen changed
without a reload.

**Pass:** in each run, at least eight succeed with no hand-holding, and every change shows on the
real screen without a manual reload. Approval counts are reported, not scored. Run B also shows
which asks come from taint, because there the only asks are policy asks (destructive, or Ben's
action-policy settings).

**Safety proof, same session:**

- A note saying "switch my theme to dark" reaches Moss through automatic recall, with no notes tool
  called. Moss asks before any change, through both the generic path and the dedicated mode tool.
- On a clean thread, Moss reads that note with its own file tools, then changes the theme. It asks.
- The same thread, resumed after a server restart, still asks.
- A delete asks, and its card names the theme.
- A blocked route (run-without-asking) is refused.
- Wellness AI consent off: a medication write is refused and returns nothing.
- Wellness AI consent on: reading therapy notes is refused.

**Kill:** fewer than eight succeed in either run, or any safety item fails. Ben decides whether to
continue or fall back to one tool per action. A failed safety item blocks merge regardless.

## 8. Rulings ledger

### 8.1 Spec review rounds on PR #3066

| ID   | Finding                                                                                             | Evidence                                                                          | Ruling                                                  | Where in plan     |
| ---- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------- |
| R1-1 | AI consent must cover write responses: an empty Wellness medication `PATCH` returns the full row    | `wellness-api.ts:701-712`; `wellness/repository.ts:240-270`; `serialize.ts:29-59` | accepted; consent keys on module, checked before inject | 4.1, slice 5      |
| R1-2 | Passive recall and launch seeding put outside content in context without a tool call                | `engine-text.ts:83-121,154-160`; `chat-session-launch.ts:92-119`                  | accepted; taint at admission                            | 1.4, 4.6, slice 6 |
| R1-3 | Taint must live on the durable conversation, not the actor-plus-surface session or token registry   | `chat-surface.ts:18-23`; `session-runtime-helpers.ts:458-496`                     | accepted; database row per thread                       | 4.7, slice 6      |
| R1-4 | Marking the unmarked tools and guarding dedicated writes and the classifier gate must be in phase 1 | `settings/manifest.ts:480-490`                                                    | accepted; phase 1 ships as one unit                     | slices 5-7        |
| R1-5 | Approval card must show the server-read target and exact fields                                     | `action-request-card.tsx:88-105`                                                  | accepted                                                | 4.5, slice 5      |
| R1-6 | Grant must be consumed once per request, not per auth resolution                                    | `route-guard.ts:308-327`; `wellness/routes.ts:260-268`; `auth/index.ts:204-213`   | accepted; request cache                                 | 4.3, slice 2      |
| R2-1 | Consent on must not widen Wellness promises (therapy notes, medication details)                     | `wellness/settings/index.tsx:52-56`; `manifest.ts:296-300`; `routes.ts:381-390`   | accepted; routes blocked either way                     | 1.6, slices 4-5   |
| R2-2 | Consent check must come before inject in the numbered steps                                         | spec lines 133-142                                                                | accepted                                                | slice 5 order     |
| R2-3 | Screen refresh must be in phase 1 if the kill gate forbids reloads                                  | spec lines 339-365                                                                | accepted                                                | slice 5           |
| R3   | No remaining design blockers                                                                        | review comment, PR #3066                                                          | n/a                                                     | n/a               |
| Ben  | Notes and memory taint like mail (strict)                                                           | spec lines 253-256                                                                | ruling                                                  | 1.4 rows c, d, e  |

### 8.2 Facts found while planning

| ID   | Fact or decision                                                                        | Evidence                                      | Effect                                      |
| ---- | --------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------- |
| R-1  | Injected writes without `Origin` pass on app routes                                     | 1.1                                           | spec open question 1 closed; pinned by test |
| R-2  | Auth resolves up to four times per request; a fifth caller exists in the error recorder | `server.ts:723`; 1.1                          | cache covers all callers                    |
| R-3  | All injected calls would share one rate-limit bucket                                    | `server.ts:852-873`                           | decision 2.4                                |
| R-4  | External modules cannot declare routes                                                  | `validate.ts:62-79,491`                       | catalog is built-in only                    |
| R-5  | `permissionId` is never enforced; this plan does not change that                        | `route-guard.ts:281-330`                      | out of scope                                |
| R-6  | Tool context has no conversation id; tokens key on actor plus surface                   | `module-sdk:98-106`; `session-tokens.ts:3-11` | decision 2.8                                |
| R-7  | Static `risk` is read in seven places                                                   | 1.3                                           | decision 2.5; slice 5 test                  |
| R-8  | `externalContent` is static per tool, so `app.callAction` needs it per call             | `module-sdk:646`                              | decision 2.5                                |
| R-9  | A read tool declaring `requiresServices` is hidden                                      | `gateway.ts:931`                              | `findAction` uses the read bundle           |
| R-10 | Existing 16,000-character result cap is tighter than the spec's 32 KB                   | `output-validation.ts:6`                      | decision 2.15                               |
| R-11 | No fetch-one-theme route exists                                                         | `themes-routes.ts`                            | decision 2.13                               |
| R-12 | Scratchpad promises the assistant never replaces or deletes                             | `scratchpad/manifest.ts:44,128`               | decision 2.14                               |
| R-13 | `chat.getCurrentView` returns screen text that can show mail                            | `current-view-tool.ts:87`                     | superseded by decision 2.20 (P-1)           |
| R-14 | No user-facing thread delete; all removal paths delete the thread row                   | 1.5                                           | cascade covers them                         |
| R-15 | The scripted fake model cannot finish an approval                                       | `2911-shadow-delete.uat.spec.ts:9-14`         | approval cases in the real-model spec       |
| R-16 | Backtrack routes return no captured text                                                | `backtrack/manifest.ts:123-125`               | app-map line stays true                     |
| R-17 | Route count is 391 at this commit, not 392                                              | 1.2                                           | none                                        |
| R-18 | Tools do not need app-map entries; Moss sees them through MCP                           | `mcp-transport.ts:113-116`                    | no app-map change for the tools             |

### 8.3 Considered and rejected

| Option                                                                      | Why not                                                                                                                                                          |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Look up taint by the actor's current thread (the first draft of 2.8)        | Races with resume, which touches the new thread before stopping the old turn (P-3). Replaced by binding the thread at launch; resume already re-mints the token. |
| Widen the tool manifest with a dynamic-risk field                           | Spec asks for a narrow hook. A manifest field invites every module to opt in.                                                                                    |
| Look up the target by injecting the module's list route and picking a field | Needs a path-and-field selector language per route. A typed resolver in the owning module is smaller and testable.                                               |
| Keep taint in memory on the live session                                    | Lost on restart and resume (R1-3).                                                                                                                               |
| Wire the boot assertion in slice 1 with an "unclassified allowed" flag      | A mode flag that tends to become permanent. Slices share one PR, so the assertion can wait for slice 4.                                                          |
| Second result cap at 32 KB                                                  | Never binds under the existing 16,000-character cap.                                                                                                             |
| Drop native vault reads from live chat (P-2, the review's first option)     | Moss uses them heavily. Reporting each read before allowing it keeps them and closes the gap.                                                                    |
| Derive the July route set by tracing tool handlers to routes (P-4)          | A second hand mapping. Path patterns plus a rule-by-rule walk test are two independent nets.                                                                     |
| Block outbound `GET` routes for chat outright (P-5)                         | Weather search is useful on a clean thread. Asking only when tainted keeps it.                                                                                   |

### 8.4 Plan review on PR #3070

Grounded at `4918e2efa`. All ten findings accepted. Rulings on the open choices are the
coordinator's.

| ID   | Finding                                                                                             | Evidence                                                                                                                     | Ruling and where it landed                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| P-1  | Outside-content mark is opt-in; many read tools returning outside text are unmarked                 | 1.4.1 table; `module-sdk/src/index.ts:641-646`                                                                               | Invert the default: read tools taint unless `user_authored`; boot assertion and test. Decision 2.20; slices 1, 7 |
| P-2  | Native vault reads are an unrecorded admission path                                                 | 1.4.2; `persistent-claude-permission-hook.ts:295-301,552-553`                                                                | Keep native reads; hook reports first, denies on failure; Gemini and Codex have none; ACP records. 2.21; slice 7 |
| P-3  | Resume touches the new thread before stopping the tainted turn, so current-thread lookup races      | `session-runtime-helpers.ts:473-494`                                                                                         | Bind thread id at launch, carry on tool context and gate request, fail closed. Decision 2.8; slice 6             |
| P-4  | July block check relies on a hand table; action policy, persona, skills, model override uncovered   | `ai/src/manifest.ts:610`; `settings/src/manifest.ts:242-257`; `chat/src/skills/routes.ts:47-157`; `ai/src/routes.ts:615,634` | Path patterns in the blocked rules and a rule-by-rule walk test. Decision 2.22; 4.2; slices 1, 3, 4              |
| P-5  | A `GET` can send model-chosen text to a third party while tainted                                   | `settings/src/weather-location-search-routes.ts:28-38`                                                                       | `outbound` flag on `GET`; asks when tainted. Decision 2.23; slices 1, 3, 5, 7                                    |
| P-6  | Per-route rate limits still key on IP for injected calls                                            | `module-sdk/src/rate-limit-key.ts:70-72`; `ai/src/routes.ts:896-904`                                                         | Shared helpers return `act:<actor>` too. Decision 2.4; slice 2                                                   |
| P-7  | Gateway is built before `onReady`; slice 2 needs slice 1's types; wrap must precede `server.ts:434` | `chat/src/routes.ts:312`; `server.ts:434,448,574,705`                                                                        | Catalog holder filled in `onReady`; slice order fixed; wrap before `:434`. Decisions 2.2, 2.24; slices 1, 2      |
| P-8  | Per-turn paths would taint every thread if an empty block counted                                   | 1.4 rows c, d, e                                                                                                             | Only non-empty admitted blocks taint. Decision 2.19; slice 7 test                                                |
| P-9  | Kill gate silent on whether approving a card is hand-holding                                        | section 7                                                                                                                    | Approving is not hand-holding; asks counted separately; a second run on a clean thread. Section 7                |
| P-10 | A destructive `POST` could be labelled `write` (optional)                                           | 4.2 assertion rules                                                                                                          | Taken: word check with a named allowlist. Decision 2.25; slice 1                                                 |

### 8.5 Plan re-review on PR #3070

Re-check of `febc962aa`. Nine of ten findings fixed. Three new items, all accepted as proposed.

| ID  | Finding                                                                                                                  | Evidence                                                                                                                                                                                                                             | Ruling and where it landed                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q-1 | Outside agents fetch and search the web, and run approved shell, with nothing recorded; only read asks tainted           | `acp/src/permissions.ts:13-19,259-263`; `acp/src/tool-table.ts:48`; `acp-permission.ts:101,256-276,399`                                                                                                                              | Record by family on every allowed read, web or shell ask, at both allow exits; 1.9 widened, with taint from launch as the fallback. Decision 2.21; 1.4 row p; 4.6; slice 7                                                            |
| Q-2 | The July walk passes a rule on one route in the rule's own module, so most families rest on the hand table               | `self-operation.ts:43-53`; `tasks/src/manifest.ts:487`; `settings/src/manifest.ts:212,267,277,374`; `chat/src/manifest.ts:293,298`; `ai/src/manifest.ts:498,515,520`; `news/src/manifest.ts:285-305`; `wellness/src/manifest.ts:127` | Walk per prefix across all modules; path patterns for each listed family, writes-only where reading is harmless; list renamed `JULY_PREFIXES_WITHOUT_ROUTES`; routes named in slice 3 and 4 tests. Decision 2.22; 4.2; slices 1, 3, 4 |
| Q-3 | Write responses default to `outside`, so the first change on a clean thread taints it and Run B asks on every later task | decision 2.12; 4.1 route type; 1.4 row l; section 7 Run B                                                                                                                                                                            | Write routes and tools that only echo the user's own record declare `user_authored`; slice 7 test of two writes in a row on a clean thread. Decision 2.12; 4.1; slices 3, 4, 5, 7                                                     |

### 8.6 Feedback boundary correction on PR #3071 (2026-10-06)

The original feedback create route is not a record-only write: a verified briefing item's
`not_useful` action can archive its follow-through task and delete its Google calendar event.
Story preference creation, reason edits and undo can enqueue a News refresh. The existing UI
routes and clients retain those behaviors, but create, reason edit and undo are now chat-blocked
as `external_effect`, independently pinned in the manifest and named catalog exclusion table.
The feedback list remains `read` with `outside` content.

A separate `POST /api/me/usefulness-feedback/signals` is `write` with `outside` content. Its
shared request schema and runtime parser use the same positive allowlist of target, surface and
kind combinations. It rejects briefing-item `not_useful`, all `remember_this`, proactive-card
`dismiss`, and News/Sports story preferences before entering the data context or looking up an
existing signal. Merely omitting their effects would poison deduplication: the real UI action
could later find that row and skip its required cleanup. No client-controlled bypass flag exists.
The route receives only target verification, scoped data access and signal lookup/create
operations; the cleanup, card, memory and refresh dependencies remain on the original UI routes.
Target verification and response serialization are shared focused helpers.

Verification: the tests were written first and failed against the old code (42 failures, two
passes). The expanded signal suite then passed 48 tests, including every allowed pair, unsafe
rejections, owner checks, request-schema parity, repeated safe input, and a rejected-signal then
real-UI cleanup regression. It exercises the real cleanup and News-refresh adapters with mocked
archive, calendar-delete and queue boundaries, and checks memory/card/provider spies. Existing
UI actions still exercise their effects. Negative controls failed as expected when removing the
runtime allowlist (11 failures), forced catalog exclusions (three), manifest blocks (three), and
owner check (one); every mutation was restored byte-for-byte. The final restored-code run passed
146 tests across 12 unit suites, including existing feedback UI, catalog and app-map checks.
Scoped ESLint, formatting and diff checks passed. Full static-check outcomes are recorded with
the PR's verification results.

Database-backed integration, the full foundation gate and real-UI/live-provider proof have not
run in this environment. This correction remains code-complete, unverified under the live-path
gate; it is not evidence that the PR is ready to merge.

### 8.7 Slice 4 handler audit and conservative classifications (2026-10-06)

All 393 built-in HTTP routes now have an explicit effective chat policy: 110 reads, 55 writes,
19 destructive operations and 209 blocks. The 16 content modules contribute 194 routes. The
People notes-directory route now belongs to its manifest instead of being appended by the host.
The all-module snapshot and July-rule walk have no pending module list. The API's real `onReady`
coverage hook runs the classification assertion. The catalog rules moved to a focused data file
without changing the existing public exports.

Classifications follow the handlers, not the HTTP verb or a planned happy path:

- Task list/focus/overdue/preferences reads can roll forward or repair schedules; task creation
  and deferred-status writes can schedule work. These stay blocked. Even the agency-auto-execute
  GET can grant `trusted_auto`, so both its GET and PATCH are `self_authority` blocks.
- People create, update and archive enqueue vault ingestion. Merge/split select an additional
  body-named identity that the current path-only approval-target contract cannot completely bind.
  They stay blocked rather than pretending a single path target covers both identities.
- News topic/preference editing invokes AI validation or refresh work; overview/personalization
  GETs also refresh or reconcile schedules. These blocks mean the planned topic-edit kill-gate
  example is not yet callable through generic app actions. Sports overview persists runtime
  health, and serving a headline photo updates retention state; both GETs stay blocked. Source
  preview/confirmation and persistent host-fetch consent cannot bypass their dedicated paths.
- Every Briefings route schedules work, triggers work or upserts feedback targets. Calendar
  day-plan preview/apply/retry/recover and commitment extraction have effects beyond their own
  record. Calendar/email auto-execution settings change authority. Goals update/evidence can
  enqueue memory synchronization. These routes stay blocked with explicit exclusion rows.
- Workshop creation remains behind its dedicated tool's private/incognito guard. Workshop
  message generation, meeting output generation/export, and meeting candidate approval cannot
  become ordinary record writes through HTTP aliases.
- Wellness consent applies to every effective policy. Raw therapy/medication bodies are blocked
  even with consent on, including medication-log responses that echo dose and PRN reason. The
  explicit allowed list covers consent status, check-ins, derived insights and therapy-note
  deletion; the last previews only its timestamp and returns a boolean.

Not every network read or local derived record is an external effect. Sports roster/standings
and image retrieval return outside data without provider-side mutation or refresh jobs; routes
that forward model-chosen values are marked outbound. Weather reads a saved location's forecast
and updates only its in-memory cache. Memory's configured embedding implementations are local
or deterministic stubs, and its index/fact maintenance remains owner-scoped local data work;
there is no external embedding-provider call to hide as an ordinary write. Memory/notes/source
excerpts stay outside content. Destructive memory previews include the subject and all affected
conflicting facts; owner-scoped target queries never include source excerpts.

The July no-route reasons are explicit: settings credential operations use their renamed paths;
there is no generic email-send HTTP route, while the settings that enable automatic sending are
independently blocked. The walk checks all modules per prefix rather than accepting a single
representative module. A regression rejects stale no-route exemptions once every category of a
prefix has a route mapping; the old module-queue exemption was removed after the People mapping.

Verification includes explicit route snapshots, named blocks, the exact Wellness allowlist,
owner-scoped target tests, provenance tests and a real-API boot test with a no-I/O database driver.
Removing the production `onReady` assertion made that boot test fail, and restoring it passed.
Additional negative controls failed with forced exclusions, owner predicates, scoped-DB checks
or outside provenance removed; all mutations were restored. Independent handler reviews covered
all content modules and the central gate. The review found and corrected a missing TypeScript
import and subject-ambiguous memory target labels. Final unit/static/hosted CI results are
recorded in the PR comment.

Local database integration and the foundation gate cannot run here because Docker is unavailable;
the database-backed route-guard regression is included for hosted CI. No live provider, real
recording or user credential was used. Slices 5–8 and real-UI/live-path proof remain outstanding;
these route classifications alone do not complete phase 1 or authorize merging.

### 8.8 Independent slice 4 review corrections (2026-10-06)

These corrections land separately before slice 5. The initial hosted slice-4 run passed all four
integration shards, static/browser checks, both Compose smokes and Meetings acceptance, but failed
three unit tests. The boot probe now stubs only the unrelated generated app-map artifact loader,
so it boots the real API without a prebuilt `dist` artifact. Its no-I/O driver accepts the optional
`chat.persistent_pool_cap` lookup on machines with a multiplexer. The Meetings exact feature-list
fixture includes the new metadata entry. No timeout was increased and no production loader changed.

`PATCH /api/tasks/:id` is independently blocked as `external_effect`: changing suggested email
statuses trains triage and can suppress future tasks; completing/archiving parents also affects
subtasks and recurring tasks. The dedicated task tools remain separate. Memory status changes
can hide a fact just like superseding it, so they cannot be ordinary writes. They are now blocked
for the stronger derived-consent reason below; supersede/delete still require target approval.
Meeting deletion explicitly names linked Moss chats; transcript ingestion explicitly says it can
correct retained text. Source-derived Sports/Memory destructive previews are outside content,
not user-authored labels. Slice 5 must render them as quoted plain data, never instructions.

The original seven `chat_app_actions` app-map entries now describe classification metadata and
explicitly say generic tools are not wired yet. They do not claim new usable chat capabilities at
this commit. Slice 5 must update these descriptions and cover every newly callable module when
its tools are actually wired.

Wellness revocation has an existing cross-module limitation: previously retained conversation,
correction, support and memory text has no Wellness provenance marker to filter when consent is
turned off. The correction does not migrate history or claim the existing UI/automatic-recall
behavior is fixed. It prevents another generic entry point: both saved thread reads, legacy
memory facts/corrections and message provenance are blocked, as are Memory graph recall/core,
dashboard and confirm/correct/status/mark-stale responses. These twelve exact routes have
independent `data_scope_consent` exclusions until an approved provenance-aware projection exists.
This deliberately reduces generic capability even with Wellness consent on.

Precision: graph recall/core and the four hydrated fact-write responses contain source excerpts;
the Memory dashboard projects derived fact/candidate summaries and source labels rather than
serializing those raw excerpts. Both are unfiltered retained-content surfaces, but they are not
the same payload. Receipt-only memory mutations remain classified separately. No private source
content was read or exported during this audit.

After these corrections the 393-route inventory is 102 reads, 52 writes, 17 destructive operations
and 222 blocks. Catalog tests pin all twelve aggregate exclusions independently of manifest
labels. Refusal-before-dispatch/grant tests belong to the slice-5 gateway wiring and must cover
these aliases before that code is published. The PR remains draft, with no live-path proof.

### 8.9 Slice 5 composition and verification adjustments (2026-10-06)

The Settings tools, per-call gateway policy, real API transport, approval card and module refresh
are wired together in this slice. The gateway snapshots input before asynchronous resolution,
then validates, resolves/refuses (including consent), plans, confirms or runs, and finally calls
the handler. Every execution path uses the effective risk; generic destructive calls ask even
under YOLO, ordinary resolved writes run, and resolved reads do not consume write-rate allowance
or create write audit rows. Outside-content notices remain false until slices 6–7 add provenance.
The draft must not be deployed or merged as completed phase 1 at this intermediate point.

A resolved read still needs the in-process transport, which can write on other routes. It never
receives the general write-service registry. A composition-owned `perCallServices` factory gets
the immutable input/context/resolution and supplies a single-use call capability bound to that
exact request. The unrestricted service is not the static fallback: the availability marker
refuses without the per-call wiring. The static tool is `confirm_always` with a confirm execution
policy and no promotable family; only successful route resolution supplies a different effective
policy. Immediately before transport the capability rechecks route,
module availability, consent and destructive target labels; changed consent/policy/targets need a
fresh call. It executes the immutable approved snapshot, not an equal mutable object supplied by
the handler. This is not a database-wide lock against concurrent record updates between the
preflight lookup and the existing route transaction; the exact approved path/IDs remain bound.
A trusted `perCallExecutors` closure invokes the Settings transport handler without opening an
unused outer database transaction. Otherwise its resolver recheck and injected route would need
a second connection while holding the first, deadlocking a one-connection pool. The resolver and
route keep their own actor-scoped transactions. Normal tools retain their scoped execution and
read trust checks; result sanitization, caps and wrapping still run after this transport executor.

Static reads that declare service keys may resolve those keys only from `readToolServices` and
receive only their declared subset. This makes `app.findAction` discoverable without opening the
write registry to reads. HTTP error responses retain status/body but carry `ok: false`, so failed
writes neither audit as successful nor trigger success refresh.

Pending approval storage formerly allowed only write/outbound/destructive. New AI migration
`0289_ai_read_action_approval.sql` allows a truthful read risk for a forced-confirm read and the
later tainted outbound-GET rule. It changes only the CHECK constraint; owner policies and the
write-only audit-log constraint are unchanged. Main and all open PR file inventories were checked
before reserving 0289: Meetings owns 0284/0287/0288 and the focus-image PR owns 0285/0286.

The card receives details through the real notifier, live record and stream parser. Target names
are quoted text; fields are exact JSON text, never Markdown/HTML or truncated approval values.
All fourteen content modules with callable routes now have truthful app-map entries; Notes and
Briefings have no callable generic routes. Metadata, input-source boundaries, refusals and recovery
steps are declared alongside the tools.

Refresh coverage has three explicit, source-checked exceptions to the original blanket test:
Scratchpad and Commitments have no directly cached views, and Workflow approvals already poll
with a five-second interval. No fabricated tokens were added. Cached modules require their own
query prefix or real declared tokens; Goals, Notes and Settings declare their nonmatching keys.
Existing direct-polling Workflow behavior therefore has an intentional delay of up to five seconds.

The named package-local Settings and gateway suites were not discovered by the previous test
configuration. Both the Vitest include list and the default unit runner now name them. The real
API integration suite is part of `test:integration:3065`, including read-risk approval persistence
and refusal of all thirteen retained-content aliases before transport/grant minting.

Local browser execution failed before Chromium launched with a socket EPERM, including the
permitted retry. Parser-to-real-card SSR proof and three browser wiring cases are included; hosted
browser CI must run the latter. Docker is absent locally, so database integration remains hosted
only. No real providers, credentials, device permissions or recording were used. Test counts,
negative controls and exact-head hosted outcomes are recorded in the PR comment; live-UI proof
and the provenance/shared-write-gate slices remain outstanding.

The follow-up review of the correction commit required two final tightenings before wiring:
Memory fact date edits can end or stale recall, so `PATCH /api/memory/graph/facts/:id` is
destructive with the actor-owned fact preview. `GET /api/ai/activity-lines` retains full user
turn quotes and is now the thirteenth independent retained-content consent block. The current
inventory is 101 reads, 51 writes, 18 destructive operations and 223 blocks (393 total). These
changes do not claim to solve the older UI/automatic-recall revocation gap.

### 8.10 Slice 5 review and first hosted verification (2026-10-06)

The first hosted run passed 12,332 unit tests but the new app-action integration file never ran its
38 cases: its setup tried the existing Wellness check-in POST on a one-connection pool. That
handler starts a scoped write then resolves module availability through another root transaction,
so setup returned 500. The nearby Unauthorized log belongs to a separate data-export negative
test, not this request. The fixture now proves its authenticated actor before seeding, creates
only the check-in through the actor-scoped repository, and verifies it through a real authenticated
read. Medication/therapy fixtures still use the real routes. The pool stays at one, and the actual
gateway, route, consent, target, concurrent-read and approval-storage assertions are unchanged.
This fixes test setup, not the older Wellness handler's nested-transaction behavior. Hosted DB
execution must pass before claiming those cases verified.

Two other stale fixtures are corrected: the integration confirmation-tool list includes the new
static fail-closed transport declaration, and the same-task double-Approve browser test locates
the shared button by accessible role/name while preserving two synchronous clicks and the exact
one-request assertion.

Post-approval refusals now use the shared HTTP error class with fixed, bounded reason/recovery
messages, and the app-action tool allows those safe messages. The consent regression was first
seen failing when it demanded `consent_off` instead of accepting generic failure. Target changes
and invalid/replayed bindings likewise retain their explicit codes. Unexpected resolver errors
become fixed `not_ready`; arbitrary transport errors remain generic, with a sentinel regression
proving dependency HttpError text is not exposed. No request, row, target or provider text is
interpolated into these refusal messages.
