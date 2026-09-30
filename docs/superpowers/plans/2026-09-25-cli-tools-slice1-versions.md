# CLI tools auto-update, slice 1: see the versions

**Spec:** `docs/superpowers/specs/2026-09-25-cli-tools-auto-update.md` (sections 6.4, 8.1-8.3, 10)
**Issue:** #2689
**Scope:** slice 1 only. No updater, no manifest, no badges, no Retry route.

## Tasks

### 1. Runner reports installed tool versions

- `InstallService.toolVersions()` reads `providers/<p>/current/node_modules/<pkg>/package.json`
  for every supported npm recipe. Missing link or file means `null`.
- OpenCode version read from the image copy of `opencode-ai/package.json`.
- New non-session RPC verb `listCliToolVersions` (rpc-contract, connection dispatch, engine host,
  RPC client). Result carries provider keys and version strings only.
- Tests: install-service version read (installed, missing), protocol dispatch.

### 2. Provider DTO carries `cliTools`

- `AiCliToolsDto` in `packages/shared/src/ai-types.ts`:
  `{ version: string | null, state: "current" | "not_installed" }` (slice 4 widens the state list).
- Route schema in `packages/shared/src/ai-api.ts` so the serializer keeps the field.
- `CliToolVersionReader` port on `AiRoutesDependencies`, wired in module-registry over the shared
  runner connection only when the socket is configured. The provider list route reads it once per
  request with a short timeout; a failure omits the block, never fails the list.
- `GET /api/ai/providers` response also carries `openCodeCli` for the OpenCode card.
- Tests: serializer with and without versions, reader failure omits the block.

### 3. Card version line

- Auth line reads `Claude CLI 2.1.282` when a version is known, unchanged otherwise.
- OpenCode card gets the same line.
- Design-system audit; no new classes.

### 4. `cli_version_too_old`

- `packages/chat/src/live/cli-version-errors.ts`: fixed plain-words message and the matcher for
  "version X or newer is required".
- One-shot engine: pipe stdout, keep a bounded tail of stdout and stderr; on a non-zero exit whose
  tail matches, `readNew` throws the named error. The structured adapter reads once more after the
  child exits so the named error wins over the generic "exited without a reply".
- Structured stream engine: an error `result` record whose text matches throws the named error.
- ACP engine: a prompt error, or a reply that is only a provider "API Error" matching the pattern,
  becomes the named error.
- Chat routes return the fixed message (503). `generate-structured` logs reason
  `cli_version_too_old`.
- Tests for each engine path and the route mapping.

### 5. App map and release note

- `aiproviders` description gains the version line.
- `CORE_APP_ERRORS` gains `cli_version_too_old` with a remediation pointing admins at
  Settings > AI providers.

## Live proof

Isolated instance with the runner. Install Claude CLI 2.1.183 into the tools folder, bind a model
that needs a newer CLI, show the card reading `Claude CLI 2.1.183` and the plain-words error.
