# Plan: fix the chat helper's tools folder default (#2340)

No spec — brief says this is a fix, not a feature; task issue is #2340 (bug).

## Problem, verified against this branch

- `packages/cli-runner/src/main.ts:71` and `packages/cli-runner/src/install-service.ts:132` each
  hardcode `DEFAULT_TOOLS_PREFIX = "/data/cli-tools"`, used only when neither
  `JARVIS_CLI_TOOLS_PREFIX` nor `NPM_CONFIG_PREFIX` is set (`main.ts:104`,
  `install-service.ts:162`).
- In the Docker image both env vars are always set (`infra/docker-compose.prod.yml:168,174`,
  `Dockerfile:100-103` chowns `/data/cli-tools` to the app user at build time), so the machine-root
  default is never actually hit there. It IS hit when cli-runner runs directly from source on a
  bare host (the documented dev path, `pnpm dev:api`), where nothing has ever created `/data` and
  an ordinary account cannot create it at the filesystem root. That is the fresh-account failure
  the issue describes.
- The repo already has a precedent for exactly this kind of per-user default:
  `packages/chat/src/live/chat-home.ts:9` —
  `resolveMossEnv(process.env, "JARVIS_CHAT_HOME") ?? join(homedir(), ".jarvis", "chat")`. The new
  tools default follows the same shape: `join(homedir(), ".jarvis", "cli-tools")`.
- Nothing else in the tree reads `DEFAULT_TOOLS_PREFIX` or the raw string `/data/cli-tools` from
  TypeScript outside these two files and their tests (`tests/unit/cli-runner-install.test.ts`
  always passes an explicit `toolsPrefix`, `tests/unit/cli-runner-main-persistent-pool.test.ts`
  does not touch `toolsPrefix`) — safe to change the default without touching test fixtures.

## Fix

### Task 1 — shared default-resolution helper, used by both files

New file `packages/cli-runner/src/tools-prefix.ts`:

```ts
export function resolveDefaultToolsPrefix(): string;
```

Behavior (decision, not code): compute `managed = join(homedir(), ".jarvis", "cli-tools")` and
`machine = "/data/cli-tools"`. If `managed/bin` already exists, return `managed`. Else if
`machine/bin` already exists, return `machine` (an already-provisioned box, Docker or a dev box
that once ran as root, keeps working — this is the "look in the managed folder before it falls
back to the machine path" requirement from the brief). Else return `managed` (a genuinely fresh
account installs into the writable per-user folder). Existence check uses `existsSync` — this
function is synchronous and called once at boot/construction, not per request.

Export the two path constants too (`MANAGED_TOOLS_PREFIX`, `MACHINE_TOOLS_PREFIX`) so both call
sites and tests can name them without re-deriving the strings.

### Task 2 — wire it into main.ts

- Delete the local `DEFAULT_TOOLS_PREFIX` constant (`main.ts:71`).
- `main.ts:104` becomes:
  `toolsPrefix: env.JARVIS_CLI_TOOLS_PREFIX ?? env.NPM_CONFIG_PREFIX ?? resolveDefaultToolsPrefix()`
- Add the import.

### Task 3 — wire it into install-service.ts

- Delete the local `DEFAULT_TOOLS_PREFIX` constant (`install-service.ts:132`).
- `install-service.ts:162` becomes: `this.toolsPrefix = deps.toolsPrefix ?? resolveDefaultToolsPrefix();`
- Add the import. (In production this branch is dead — `main.ts` always passes `toolsPrefix` — but
  the issue names both constants explicitly, and it is install-service's own default for any other
  caller/test that constructs it directly.)

### Task 4 — fail loud instead of a silent toolless chat turn

- `install-service.ts` already turns any unexpected `runInstall` fault into
  `{ state: "error", message: redactInstallMessage(err) }` (`install-service.ts:190-197`), and
  Node's own `mkdir` errors (`EACCES`/`ENOENT`) already include the path in `err.message`, so a
  real install attempt already surfaces a folder-naming message today — verified by reading
  `redactInstallMessage` (`install-service.ts:842-845`, strips only npm-registry secrets, not
  paths).
- The actual gap: nothing proactively checks that the resolved `toolsPrefix` is creatable BEFORE
  the chat turn decides the tool is simply absent. Add one check at `InstallService` construction:
  a new method `async ensureToolsPrefixWritable(): Promise<void>` that does
  `mkdir(this.toolsPrefix, { recursive: true })` and rethrows a plain `Error` whose message names
  the exact folder on failure (`` `could not create the tools folder at ${this.toolsPrefix}: ${cause.message}` ``).
  Call it once from `createCliRunner` in `main.ts` right after constructing `installService`, before
  `server.start()`; log the result at the existing `log()` callback. A failure here logs clearly and
  the server still starts (chat still needs to run for providers already installed) — it does not
  crash the whole process, since providers may already be present under a different path.

## Determinism boundary

No model output involved; this is boot-time config resolution and filesystem checks. N/A.

## Tests

- `tests/unit/cli-runner-tools-prefix.test.ts` (new): `resolveDefaultToolsPrefix` — (a) no `bin`
  dir under either candidate → returns the managed path; (b) `machine/bin` exists, managed does not
  → returns machine path; (c) `managed/bin` exists → returns managed path regardless of machine.
  Use real temp dirs (`mkdtemp`), stub `homedir()` via dependency injection (`resolveDefaultToolsPrefix(homedirOverride?: string)`) rather than mocking `node:os`.
- `tests/unit/cli-runner-install.test.ts`: add one case constructing `InstallService` with no
  `toolsPrefix` override and asserting it resolves to the same value `resolveDefaultToolsPrefix()`
  returns (regression guard against re-hardcoding a literal).
- `tests/unit/cli-runner-main-persistent-pool.test.ts` unaffected (doesn't touch `toolsPrefix`);
  confirm with a run, don't assume.

## Verification (single phase, no kill gate needed — this is a bug fix, not a milestone)

```bash
pnpm --filter @moss/cli-runner typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"   # expect 0
pnpm vitest run tests/unit/cli-runner-tools-prefix.test.ts tests/unit/cli-runner-install.test.ts tests/unit/cli-runner-main-persistent-pool.test.ts > /tmp/vt.log 2>&1; echo "EXIT=$?"   # expect 0
```

Full gate (`verify:foundation`) and any live-instance proof run only via the `verify-gate` skill at
wrap-up, per standing rules — not part of these task-level checks.

## Live-path note

This is a backend default/config fix with no new UI surface. Live proof: after the fix, restart the
dev api (`pnpm dev:api`) with `JARVIS_CLI_TOOLS_PREFIX` unset and confirm in the server log that the
resolved tools prefix is the per-user `.jarvis/cli-tools` path, not `/data/cli-tools`, and that a
provider install (or presence check) against it succeeds without an EACCES/ENOENT. Record the log
line in the PR as the live evidence for this fix (no Playwright UI path exists for a boot-time
config value).

## App map

No screen, setting, or navigation path changes. No app-map edit needed.
