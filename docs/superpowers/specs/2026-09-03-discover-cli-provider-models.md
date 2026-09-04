# Discover models for command-line providers (no typed-in model lists)

**Status:** approved by Ben 2026-09-03 in a live co-working session ("lets do all please. And lets
not hardcode models, we need it to be discovered").
**Issue:** #2208. **Branch/PR:** shares `fix/2205-login-reactivate-provider` / PR #2206 (session ruling).

## Problem

`packages/ai/src/model-discovery.ts` carries typed-in model lists (`CLI_STATIC_MODELS`,
`ANTHROPIC_STATIC_MODELS`) for every command-line (CLI) provider. They age silently: on
2026-09-03 the Claude list still ended at Opus 4.8 while Anthropic's own list has Claude 5 /
Fable 5.1. Every login copies the stale list into the provider and **wipes hand-edited model
rows**, Settings has no "Add model" or "Refresh models", and fresh installs start stale.
`CLAUDE.md` already rules "never hardcode a provider or model name"; the static lists were a
documented exception that this spec removes.

## Findings that shape the design (verified on dev 2026-09-03)

- No CLI (`claude`, `codex`, `gemini`) has a list-models command.
- The credential the cli-runner already stores for a logged-in provider is enough to ask the
  vendor for its live list:
  - anthropic: the captured `setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`) as `Authorization: Bearer`
    on `GET https://api.anthropic.com/v1/models?limit=100` with headers
    `anthropic-version: 2023-06-01` and `anthropic-beta: oauth-2025-04-20` returns 11 ids
    including `claude-fable-5-1`. The persisted token file may contain a leading
    `CLAUDE_CODE_OAUTH_TOKEN=` prefix (seen on dev); the CLI tolerates it, the reader must strip it.
  - openai-compatible (codex): `<homeBase>/.codex/auth.json` → `tokens.access_token` +
    `tokens.account_id` as `Authorization: Bearer` and `ChatGPT-Account-Id` on
    `GET https://chatgpt.com/backend-api/codex/models?client_version=<codex --version>` returns
    `{ models: [{ slug, visibility, ... }] }`; keep `visibility === "list"`. `api.openai.com/v1/models`
    refuses this token (403, missing scope). The `client_version` must be the installed CLI's real
    version or the list comes back empty.
  - google (gemini): not verifiable on dev (no login). Ship it as `unsupported`: no models beyond
    the `"default"` sentinel; unpinned chat still rides the CLI's own default. Follow-up issue.
- Unpinned chat already launches the CLI with no `--model` (the `"default"` sentinel), so the
  vendor's current default is what users get today; only explicit picks were limited to the list.

## Design

### 1. cli-runner: new non-session RPC `listProviderModels`

- Params `{ provider: RpcProviderKind }`; result
  `{ status: "ok", models: readonly { id: string }[] } | { status: "unsupported" | "not_logged_in" | "error", message?: string }`.
- One adapter per provider kind in a new `packages/cli-runner/src/model-list-adapters.ts`,
  registered next to the login adapters. Adapters read credentials from the cli-auth home base
  only, never return or log them, and bound the vendor call at 5 s. Ids only cross the socket.
- Wire the verb through `packages/chat/src/live/rpc-contract.ts` (`RpcMethod`, params/result
  types), `packages/cli-runner/src/connection.ts` dispatch, and the client `RpcConnection`.

### 2. API: discovery for `auth_method = "cli"` asks the runner

- `ModelDiscoveryService` gains an optional `cliModelLister` dependency
  (`(provider) => Promise<ListProviderModelsResult>`), injected from the onboarding-login seam in
  `packages/module-registry` (same socket, same lazy connection, same 503 mapping).
- For CLI providers: call it; on `ok` map ids through `inferModel` (`fromFallback: false`, cached
  1 h like API-key providers); on anything else return `[]` with `fromFallback: false` and a
  `reason` the routes can surface.
- **Delete** `CLI_STATIC_MODELS`, `ANTHROPIC_STATIC_MODELS`, `hasCliStaticModels` and every
  fallback branch that returns them. API-key discovery that fails returns `[]`. Update the tests
  that import `CLI_STATIC_MODELS` to stub the lister instead.
- `inferTierFromModelId` (anthropic): treat `fable` like `opus` (reasoning). Heuristics on the id
  are fine; lists of ids are not.

### 3. Persistence: discovered vs manual rows, no more wiping

- New migration in `packages/ai/sql/` (next number after the current latest): add
  `origin text not null default 'discovered' check (origin in ('discovered','manual'))` to
  `app.ai_configured_models`. Rows created through `POST /api/ai/models` are `manual`; discovery
  upserts are `discovered`. Register the file in `packages/ai/src/manifest.ts`.
- `discoverAndPersistModels` for CLI providers: remove only `discovered` rows absent from the new
  list (never `manual`, never the sentinel); upsert the rest. If the lister returned anything other
  than `ok`, change nothing (do not delete on a failed call).
- Existing rows are `discovered` by default, which matches how they were created.

### 4. Settings UI (admin, Providers card)

- **Refresh models** button on each provider's model list: `POST /api/ai/providers/:id/models/refresh`
  (new route; admin-only; invalidates the discovery cache then runs `discoverAndPersistModels`;
  returns the provider's models plus the discovery `reason`). Show a one-line result under the
  list: "Refreshed: N models" or the plain-English reason ("Not logged in", "This provider cannot
  list its models yet").
- **Add model** control opening a small form (Model id, Display name, tier, capabilities) that
  calls the existing `POST /api/ai/models` with the provider id; the row is `manual` and survives
  refresh and re-login.
- Use `jds-*` primitives and the `design-system` skill audit. Update the app map
  (`packages/shared/src/app-map-core.ts`) for the two new controls and the refresh outcome text.

### Out of scope

- Gemini model listing (follow-up issue).
- Short-name aliases (`fable`, `opus`): unnecessary once real ids are discovered, and would be
  another typed-in list.

## Verification

- Unit: adapters (token parsing incl. the `KEY=` prefix, header shapes, visibility filter, timeout),
  discovery service with a stubbed lister, persist logic (manual survives, discovered pruned,
  failed call changes nothing).
- Integration: refresh route; auto-register with a stubbed lister registers the discovered ids.
- Live on dev: Settings > AI > Refresh models on the Anthropic row shows Claude 5 / Fable 5.1 ids;
  Add model persists a row that survives Refresh and a re-login. Screenshot on PR #2206.
