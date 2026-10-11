# API-key providers can drive chat

Date: 2026-10-10

Status: Draft for Ben's review. Direction approved by Ben 2026-10-10. Build-ready after spec approval and the phase 0 proofs below.

Owner: Ben

Decision record: overrides ADR 0003 for the interactive path and reverses the "not planned"
closure of issue #307. Ben's ruling, 2026-10-10: "yes, it will override intentionally".

## Summary

- Chat works when the active chat provider is an API-key row.
- Chat keeps the existing ACP engine, agent programs, Moss tools (MCP server), approvals
  (gateway), history replay and streaming. None of these change.
- Moss starts the agent program that speaks the provider's format and hands it the provider's
  address, key and model.
- Two motivations:
  - Users can pick an API-key provider for chat.
  - Testing agents on dev instances get a chat provider that is always ready, by pointing at a
    local model proxy. This removes the recurring OAuth login chores for test accounts.
- A local model proxy is an ordinary API-key provider. There is no proxy mode.

## Decision

- ADR 0003 (`docs/architecture/decisions/0003-interactive-chat-is-cli-transport.md`) said
  interactive chat does not support the `api_key` transport. This spec overrides that for the
  interactive path, on purpose.
- ADR 0003's reason still holds. The live experience comes from the agent programs, and a stateless
  HTTP call cannot provide it. This design keeps the agent programs. Only the credential source
  changes, from a CLI login to a stored API key.
- ADR 0008 (pluggable chat engine behind the capability router) stays in force. The router still
  picks the user's chat model; nothing hardcodes a provider or model.
- ADR 0010 (cli-runner sidecar as isolation boundary) stays in force. One provider key crosses into
  the sidecar per agent session. See Security.
- The 2026-09-25 routing-repair plan
  (`docs/superpowers/plans/2026-09-25-openai-compatible-provider-routing-repair.md`) refused
  API-key chat "until tool and confirmation parity is implemented". Its follow-up boundary lists
  streaming, MCP tool calls, permission and confirmation handling, cancellation and retry, and
  route/auth tests. Reusing the ACP pipeline unchanged meets that list, because API-key sessions
  run the same engine code as CLI sessions.
- Issue #307 ("API-key interactive chat adapter", closed not planned 2026-06-18) proposed a
  separate HTTP chat adapter. This design builds no such adapter.

## Scope

- Open the three chat gates that refuse API-key rows.
- Map API-key rows to an agent program, per provider kind.
- Carry the provider key from the app to one agent session in the sidecar.
- Custom base URL for Anthropic API-key rows (chat, background jobs, model discovery).
- "Anthropic (API key)" entry in the admin add-provider menu.
- Readiness and model list for API-key rows.
- Dev-instance seeding of an API-key provider as the default.
- UAT reachability of a host-side model proxy (last phase).
- Amend ADR 0003's status to "superseded in part by this spec".
- App map, release note, live-path proof.

## Out of scope

- API-key chat for `google`, `ollama`, `custom` and `system-one` rows. Chat keeps refusing them
  with a clear message.
- Workshop profile on API-key rows. Chat profile only.
- A separate HTTP chat engine or tool loop.
- Any "proxy mode" flag, setting or code path.
- The host-side relay for UAT. It lives in Ben's model-router repo, outside Moss.
- Meeting questions. They already require an API-key model and keep their own path
  (`packages/chat/src/live/meeting-chat-runtime.ts:67`).

## Current state (verified on origin/main, 2026-10-10)

| Concern | Location | Today |
| --- | --- | --- |
| Launch refusal | `packages/chat/src/live/chat-session-provider-identity.ts:55-60` | `assertLiveCliProvider` throws `ApiKeyLiveChatUnavailableError` for any `api_key` row |
| Refusal message | `packages/chat/src/live/errors.ts:138-146` | "Live chat does not support API-key providers yet..." |
| Route mapping | `packages/chat/src/live-routes.ts:766-768` | Maps the refusal to HTTP 400 with that message |
| Replay retry guard | `packages/chat/src/live/chat-session-manager.ts:313-319` | Rethrows the refusal instead of retrying |
| Agent routing | `packages/chat/src/live/acp-chat-engine.ts:47-59` | `toAcpProviderKind`: `openai-compatible` with no agent id maps to Codex |
| Unsupported kinds | `packages/chat/src/live/persistence.ts:652-663` | `toLiveProvider` throws a plain `Error` for `ollama`/`custom` |
| Spawn request | `packages/chat/src/live/rpc-contract.ts:633-652` | `acpSpawn` carries project, kind, user, profile. No credential |
| Agent env | `packages/cli-runner/src/acp-host.ts:370-379` | Sanitized env, `HOME`, and `CLAUDE_CODE_OAUTH_TOKEN` from the sidecar's own token store |
| OpenCode settings | `packages/cli-runner/src/acp-host.ts:386-392`, `agent-home-prepare.mjs:211-233` | Writes `opencode.json` in the agent home with shell and edit denied |
| Codex login copy | `packages/cli-runner/src/acp-host.ts:400-430` | Copies a login file into the person's agent home, 0600, as their account |
| Anthropic HTTP URL | `packages/ai/src/adapters/http-api.ts:220-223` | Fixed to `https://api.anthropic.com/v1/messages`. `base_url` ignored |
| Anthropic model discovery | `packages/ai/src/model-discovery.ts:198-202` | Fixed to `https://api.anthropic.com/v1/models` |
| Background jobs | `packages/ai/src/generate-text.ts:166-182` | Already decrypts the key and passes `base_url` to the HTTP adapter |
| Admin add menu | `apps/web/src/settings/settings-ai-provider-catalog.ts:27-43` | Anthropic is offered as CLI only |
| Admin edit form | `apps/web/src/settings/settings-ai-admin-pane.tsx:333-341` | Shows "Base URL" for every API-key row, including Anthropic, where it is ignored |
| Readiness probe | `packages/chat/src/live/provider-probe.ts:32-41`, `:273-298` | Runs `claude --print`; cache keyed on the OAuth token |
| Model list (CLI) | `packages/cli-runner/src/model-list-adapters.ts:213-216` | Reads the sidecar's stored OAuth token |
| Dev seeding | `scripts/dev-instance/config.ts:40-55`, `provision.ts:88-128` | CLI provider row plus a GPG-encrypted Claude OAuth token |
| UAT compose | `tests/uat/compose.override.yml`, `tests/uat/env-file.ts:30-40` | No host-gateway entry. Test-only settings come from the generated env file |

## Design

### 1. Open the gates

- `assertLiveCliProvider` allows `api_key` rows whose kind is `anthropic` or
  `openai-compatible`.
- Other `api_key` kinds throw a new, specific error: "Chat supports API-key providers of type
  Anthropic or OpenAI-compatible. Choose one of those, or a CLI provider, in Admin > AI providers."
- `toLiveProvider` raises the same specific error for `ollama` and `custom`, instead of the plain
  `Error`.
- `live-routes.ts` maps the new error to HTTP 400 with that message.
- `ApiKeyLiveChatUnavailableError` and its message are removed. The replay retry guard in
  `chat-session-manager.ts` switches to the new error.
- Rename `assertLiveCliProvider` to match what it now checks (e.g. `assertLiveChatProvider`).

### 2. Agent routing per kind

| Row | Agent program | Address and key reach it as | Model reaches it as |
| --- | --- | --- | --- |
| `anthropic` + `api_key` | claude agent (`claude-acp`) | `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` in the agent env | Existing `setModelForChat` with the row's model id |
| `openai-compatible` + `api_key` | OpenCode (`opencode`) | Provider entry in `opencode.json`. Key as an env reference, value in the agent env | `acpModel` = `<moss provider id>/<row model id>` |
| `openai-compatible` + `cli` | unchanged | unchanged | unchanged |

- `toAcpProviderKind` takes the auth method. For `api_key` it maps `anthropic` to the claude agent
  and `openai-compatible` to OpenCode. It never falls through to Codex.
- `resolveActiveProvider` (`persistence.ts:176-213`) builds `acpModel` for API-key OpenCode rows
  from the row's own model. The user's saved OpenCode model setting applies to CLI OpenCode rows
  only.
- For an API-key launch, the claude agent gets no `CLAUDE_CODE_OAUTH_TOKEN`. Never set both.
- The sidecar's static readiness gate (`acp-host.ts:306-311`, `providers.ts`) stays. Both agents
  are `chatReady`.

Why OpenCode over Codex for OpenAI-compatible:

- OpenCode is configured through a settings file Moss already writes per spawn
  (`agent-home-prepare.mjs`). The provider entry is one more key in that file.
- OpenCode's OpenAI-compatible provider speaks plain Chat Completions, the format every
  OpenAI-compatible service exposes.
- Moss's Codex path is built around a copied ChatGPT account login (`acp-host.ts:400-430`,
  `model-list-adapters.ts:233`). An API-key route would need a separate config path through
  `CODEX_CONFIG`, plus a check that the pinned Codex accepts Chat Completions endpoints.
- No code reason was found to prefer Codex. See open questions.

Address format:

- Moss stores base URLs without the `/v1` suffix and appends paths itself (`http-api.ts:241`).
- Claude reads `ANTHROPIC_BASE_URL` without `/v1`. Pass it as stored.
- OpenCode's OpenAI-compatible provider expects the `/v1` base. Append `/v1` when writing the entry.

### 3. Anthropic base URL

- `HttpApiAdapter` uses the row's `base_url` for `anthropic`, defaulting to
  `https://api.anthropic.com`. Background jobs pick this up with no other change.
- `model-discovery.ts` uses the same base for Anthropic `/v1/models`.
- Admin add menu gains "Anthropic (API key)" (`kind: "anthropic"`, `authMethod: "api_key"`), with
  an optional Address field and the API key field.
- The edit form already shows Base URL for Anthropic API-key rows. It becomes truthful once the
  adapter honours it.
- The server route already accepts `anthropic` with `api_key` (`packages/ai/src/routes.ts:183-190`).

### 4. Key delivery

- The app decrypts the key at chat launch with the same code background jobs use
  (`cipher.decryptJson` plus `parseAiApiKeyCredential`, `generate-text.ts:166-172`).
- The engine factory adds an optional credential to the `acpSpawn` params: kind, base URL, key.
  CLI rows send none.
- `acp-host.ts` `spawn` adds the values to the child env object it already builds, after
  `buildSanitizedCliEnv` filters the runner's own env:
  - claude agent: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`.
  - OpenCode: a Moss-named key variable, referenced from `opencode.json` as `{env:<name>}`.
- `agent-home-prepare.mjs` takes an optional provider entry (id, address, model, env reference)
  next to the deny settings. It writes the entry on API-key spawns and removes it on every other
  OpenCode spawn, so no stale entry survives a provider switch.
- No key is written to disk by Moss. Full trace in Security.
- The design brief suggested following the Codex login copy. That pattern writes a per-person file
  that outlives the session (see Security), so this spec uses the agent env instead. A per-session
  file is the fallback if phase 0 shows OpenCode cannot read an env reference.

### 5. Readiness and model list

- An API-key row is ready when both hold:
  - The sidecar reports the agent program installed (existing `probeProvider`, any status other
    than `not_installed`).
  - The app's own call to the provider's `/v1/models` succeeds with the stored address and key
    (existing `testProviderCredential` / model discovery in `packages/ai`).
- The `claude --print` probe and its token-keyed cache (`provider-probe.ts`) stay CLI-only. API-key
  readiness results are cached by provider config id plus credential update time, never by key
  value.
- Model names come from the provider's `/v1/models` through the existing app-side discovery
  (`model-discovery.ts`, `discover-and-persist-models.ts`). Never hardcoded.
- The sidecar's model-list adapters (`model-list-adapters.ts`) stay CLI-only.
- A 401 from the provider shows the existing "The provider rejected the API key" state, not a
  CLI sign-in prompt.

### 6. Dev-instance seeding

- `scripts/dev-instance` can register an API-key provider as the default, from env:

| Variable | Meaning |
| --- | --- |
| `MOSS_DEV_INSTANCE_PROVIDER_KIND` | Existing. `anthropic` or `openai-compatible` |
| `MOSS_DEV_INSTANCE_PROVIDER_AUTH` | New. `cli` (default) or `api_key` |
| `MOSS_DEV_INSTANCE_PROVIDER_BASE_URL` | New. Optional address, e.g. `http://127.0.0.1:<port>` |
| `MOSS_DEV_INSTANCE_PROVIDER_KEY_FILE` | New. Path to a file holding the key. Required for `api_key` |

- The provider-rows step creates the API-key row through the same repository path the admin route
  uses (encrypted credential), runs model discovery, and sets the chat model from the discovered
  list.
- The cli-token step is skipped for `api_key`. No GPG token is read.
- Dev instances run cli-runner on the host (`scripts/dev-instance/cli-runner.ts:130-150`), so
  agents reach a proxy on `127.0.0.1` with no relay.
- Nothing local is committed. Defaults stay as today.

### 7. UAT (last phase)

- UAT containers run on a bridge network and cannot reach the host's `127.0.0.1`.
- `tests/uat/compose.override.yml` gains a test-only `extra_hosts` entry
  (`host.docker.internal:host-gateway`) on the `jarv1s` service.
- The generated env file (`tests/uat/env-file.ts`) carries the provider base URL and key file for
  the UAT seed. Production compose and dev scripts never see these values.
- A host-side relay listens on the bridge gateway and forwards to the proxy on `127.0.0.1`. It
  lives in Ben's model-router repo.
- Related: issue #2906 (UAT chat provider refused by live chat).

### 8. App map, ADR, release note

- `packages/shared/src/app-map-core.ts` updates:
  - Error `core.ai.api_key_live_chat_unavailable` (`:474-479`) is replaced by the new
    unsupported-kind error.
  - Remediation `core.ai.connect_cli_provider` (`:557-562`) is reworded to cover API-key rows.
  - Chat feature text (`:297-298`) and the add-provider menu text (`:257-263`) describe API-key
    chat, the Anthropic API-key entry and its address field.
- ADR 0003 status becomes "Superseded in part (interactive transport) by
  `docs/superpowers/specs/2026-10-10-api-key-chat-design.md`".
- Release note, Category Added: "Chat can now use an API-key provider".
- Live-path gate: chat through the real UI on a live dev instance, once per agent, with a tool call
  approved through the confirmation card.

## Security

### Key path (traced)

| Step | Where | Holds the key |
| --- | --- | --- |
| At rest | `app.ai_provider_configs.encrypted_credential` | AES-256-GCM, key `JARVIS_AI_SECRET_KEY` (api only) |
| Decrypt | api process, chat launch | In memory for the launch call |
| Transit | `acpSpawn` over the private Unix socket | Socket mode 0600, mounted in api and cli-runner only, auth hello with `JARVIS_CLI_RUNNER_RPC_SECRET` (ADR 0010 section 3) |
| Sidecar | `acp-host.ts` spawn | In the child env object only. Never in cli-runner's own `process.env` |
| Agent | adapter process, then its children | Process env of the person's slot account (`setpriv`, `acp-host.ts:466-500`) |
| claude CLI | grandchild of the claude adapter | Adapter passes `...process.env` to the CLI (vendor `claude-agent-acp` 0.75.1, `dist/acp-agent.js` around line 5944) |
| OpenCode | `opencode acp` process | Env value. `opencode.json` holds only the reference |
| Disk | none written by Moss | `opencode.json` (0600, owned by the slot account) holds address, model id, env reference |
| Removal | process exit | Kill, idle reap, provider switch, or session replacement end the process |

### Env allowlists

- `packages/ai/src/adapters/sanitized-env.ts` filters the runner's inherited env. The key is added
  after the filter, so the allowlist needs no change.
- `scripts/start-jarv1s.ts` (`CLI_ENV_KEYS`) builds cli-runner's own env. The key never passes
  through it, so no change.
- `packages/chat/src/live/constrained-claude-profile.ts` serves the one-shot structured engine,
  not ACP chat. Not on this path, no change.
- Do not add `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL` to any allowlist. That would let a
  server-level value reach every agent.

### Must hold (each needs a test observed failing with the protection removed)

- The key never appears in argv of any process (`/proc/<pid>/cmdline`).
- The key never appears in api or cli-runner logs, RPC error messages, or pg-boss payloads.
- The key never reaches the frontend. The app map and errors name the row, never the key.
- CLI-row spawns carry no API-key variables.
- The OpenCode settings file never contains the key value.

### Risks and review points

- The agent holds a working key. Chat leaves read tools and WebFetch on (`packages/acp/src/tool-table.ts:46-48`).
  A prompt-injected agent could, in principle, read its own env (e.g. `/proc/self/environ`)
  and send it out. Not traced as blocked. The same exposure exists today for the OAuth token in the
  claude agent's env.
- The env is readable by any process of the same account and by root, for the session's life.
- In dev shared-account mode (`MOSS_CLI_ALLOW_SHARED_UID=1`), agents run as the runner's own
  account.
- The claude CLI may record part of an approved API key in its config file under the agent home.
  Unverified. Phase 0 checks the agent home after a session.
- The adapter's `providers/set` logs the base URL (`dist/acp-agent.js:1286`). Moss does not call
  it, but base URLs should be treated as non-secret in any case.
- Every OpenCode CLI session also reads `opencode.json`. The provider entry is removed on non-API-key
  spawns, so a CLI session never sees a stale entry.
- The Codex login copy is per person and survives the session. Purge (`acp-host.ts:781-805`)
  removes the working folder and transcripts, not `.codex/auth.json`. That is why this spec does
  not reuse that pattern for keys.

## Rollout phases

| Phase | Content | Gates open? |
| --- | --- | --- |
| 0 | Proofs on a dev instance against the local proxy (see below) | No |
| 1 | Anthropic base URL in HTTP adapter and model discovery; "Anthropic (API key)" add entry; app map for these | No |
| 2 | Key on `acpSpawn`; per-kind env and OpenCode entry; routing by auth method; tests | No |
| 3 | Gates open; readiness and model list for API-key rows; app map; ADR 0003 amendment; release note; live-path proof | Yes |
| 4 | Dev-instance API-key seeding | Yes |
| 5 | UAT host-gateway entry and env-file values | Yes |

Phase 0 proves:

- Verified already (2026-10-10, host): the proxy accepts the client key via `x-api-key` (200;
  401 without it).
- Verified already: `claude --print` with a fresh `HOME` and only `ANTHROPIC_BASE_URL` plus
  `ANTHROPIC_API_KEY` answered through the proxy, with no login and no trust prompt.
- To prove: the same through the claude ACP adapter that Moss pins, including `initialize` passing
  without a login.
- To prove: `setModelForChat` accepts the proxy's model ids on the claude agent.
- To prove: OpenCode answers through the proxy with a provider entry and an `{env:...}` key
  reference.
- To prove: a Moss tool call and its confirmation card work on both agents.
- To prove: no key fragment lands in the agent home after a session.

## Testing

Vitest, one file at a time with `pnpm test:unit <file>`. No full gate, no database tests.

- Gate: `api_key` with `anthropic` and `openai-compatible` passes; other kinds raise the new error;
  route returns 400 with its message.
- Routing: `toAcpProviderKind` maps API-key rows to claude agent and OpenCode, never to Codex.
- Launch env: API-key claude spawn sets both variables and no OAuth token; CLI spawns set neither.
- OpenCode entry: written with `/v1` address, model and env reference; removed on CLI spawns; never
  contains the key value.
- Key absence: argv and log capture contain no key (observed failing with the protection removed).
- Readiness: API-key row reads ready on a 200 `/v1/models` and rejected on 401; cache key holds no
  key value.
- Anthropic base URL: HTTP adapter and model discovery use the row's address and fall back to the
  default.
- Seeding: `api_key` config reads the key file, skips the cli-token step, and sets the default chat
  model from discovery; missing key file fails with a clear message.

## Open questions

- OpenCode or Codex for OpenAI-compatible rows. This spec picks OpenCode. Codex stays an option
  if its pinned version accepts a Chat Completions endpoint through `CODEX_CONFIG`.
- Key in env versus a per-session 0600 file. This spec picks env, matching today's OAuth token.
  The file is the fallback if OpenCode cannot read an env reference.
- Should the claude agent get its model through `ANTHROPIC_MODEL` at spawn if the adapter does not
  list proxy model ids?
- Name and placement of the new dev-instance variables, against the "no scattered mode flags" rule
  in `docs/DEVELOPMENT_STANDARDS.md`.
