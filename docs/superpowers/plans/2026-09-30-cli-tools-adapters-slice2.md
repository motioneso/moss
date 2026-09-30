# 2026-09-30 - CLI tools auto-update, slice 2: chat adapters on the tools volume (#2689)

Spec: `docs/superpowers/specs/2026-09-25-cli-tools-auto-update.md` (sections 2, 3.2, 3.3, 10).
Builds on slice 1 (PR 2818). Tier: sensitive. Runner-only change, no UI, no new setting, no migration.

## Seams check (verified on this branch)

| Claim                                                                      | Where                                                                                    |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Adapter entry resolved from the image with `createRequire().resolve`       | `packages/cli-runner/src/acp-host.ts:269-291` (`defaultResolveAdapterTarget`)            |
| Adapter env built from the sanitized env, then per-provider extras         | `acp-host.ts:396-409`                                                                    |
| Resolver is called once per spawn, injectable for tests                    | `acp-host.ts:99`, `acp-host.ts:488-489`                                                  |
| One recipe per provider, keyed by `RpcProviderKind` (3 kinds)              | `packages/cli-runner/src/catalog.ts:85-168`, `packages/chat/src/live/rpc-contract.ts:37` |
| Install core: stage, `npm ci --ignore-scripts`, verify, atomic promote, GC | `install-service.ts:196-520`                                                             |
| Boot reconcile reinstalls installed recipes                                | `install-service.ts:706-718`                                                             |
| `AcpHost` is built with no tools prefix today                              | `engine-host.ts:125-130`, `main.ts:317-321` (prefix is `config.toolsPrefix`)             |
| Adapter pins today                                                         | `packages/cli-runner/package.json:15-16` (claude-agent-acp 0.75.1, codex-acp 1.10.0)     |
| UAT scripted provider already sets `CLAUDE_CODE_EXECUTABLE`                | `packages/ai/src/adapters/sanitized-env.ts`                                              |

OpenCode has no separate adapter (chat runs `opencode acp` from the image package), so it stays as is.

## Decisions

1. **Separate adapter catalog, not new provider kinds.** `ADAPTER_CATALOG` in `catalog.ts`, keyed by
   the CLI provider it serves (`anthropic`, `openai-compatible`). Each entry: `pkg`, exact `version`,
   committed `lockfile`, `entry` (file inside the package). Reuses the exact-semver and full-sha512
   lockfile validators; a failing entry is demoted and never installed. Widening `RpcProviderKind` was
   rejected because every switch on it (RPC, login, model list, DTO) would need a no-op arm.
2. **Install slot is a string id.** The install core takes a slot name (`anthropic`, or
   `anthropic-adapter` for the adapter) for its staging, `providers/<slot>/releases`, `current` flip and
   GC. The adapter path skips arch-binary placement and the `bin/` symlink (no binary). Staged verify
   checks the entry file exists. Same lock, timeout and rollback behavior.
3. **One toolset install.** `installProvider(p)` installs the CLI and then its adapter. An adapter
   failure returns an error result but leaves the installed CLI in place, and chat falls back to the
   image adapter. Boot reconcile covers the adapter when the CLI is installed. Promote-together and
   hold-back stay slice 4.
4. **Resolution with fallback.** `AcpHost` gets `toolsPrefix`. For anthropic/openai it looks for
   `<prefix>/providers/<slot>/current/node_modules/<pkg>/<entry>`; present means run it, absent means the
   image copy. Checked at each spawn, so deleting the adapter falls back with no restart.
5. **One CLI copy.** When the tools volume CLI exists, the launch env gets `CLAUDE_CODE_EXECUTABLE` or
   `CODEX_PATH` set to the concrete release path (resolved from `current`, never the symlink) of
   `node_modules/.bin/<binary>`. An already-set value (UAT fixture) is kept. No CLI installed means
   neither is set and the bundled copy runs. Set in the runner launch env after sanitizing, so it is
   not a setting and not allowlist-dependent.
6. **Security claims to verify by reading, not assert.** The adapter and CLI paths point into the tools
   volume, which is written only by the runner. I will confirm the session user can read but not write
   the release tree (release root chmod 0755, contents keep npm modes) before writing any such claim
   in a comment or PR body.
7. **Lockfiles.** Generate `recipes/anthropic-adapter/npm-shrinkwrap.json` and
   `recipes/openai-compatible-adapter/npm-shrinkwrap.json` with
   `npm install <pkg>@<version> --package-lock-only --ignore-scripts` at the currently pinned versions.
   Image copy stays in `package.json` as the fallback floor.
8. **App map.** Chat behavior is unchanged for users and no screen, setting or error changes, so no
   app-map edit is expected. Will re-check against `docs/DEVELOPMENT_STANDARDS.md` App Map
   Truthfulness before the PR and say so in the PR body either way.

## Phases

### Phase 1 - resolve and run (kill gate)

Tests first in `tests/unit/cli-runner-acp-host.test.ts` (each watched failing before the code):

- tools-volume adapter present: spawn target is the tools-volume entry, not the image copy.
- adapter absent: image copy target.
- adapter removed after a first spawn: next spawn uses the image copy.
- CLI present: launch env has `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH` equal to the resolved release
  path, not `.../current/...`.
- CLI absent: neither variable set. Pre-set value is not overwritten.
- opencode target unchanged.

Code: `defaultResolveAdapterTarget(kind, toolsPrefix)`, `AcpHostDeps.toolsPrefix`, wiring in
`engine-host.ts`/`main.ts`, env override at `acp-host.ts:396`.

**Kill gate:** fake tools volume plus a real adapter package dir run the real adapter entry through
`AcpHost` far enough to answer `initialize`. If an adapter cannot run from the tools volume (for
example it needs its bundled native binary at load), stop and escalate before phase 2.

### Phase 2 - install adapters

Tests first in `tests/unit/cli-runner-install.test.ts`:

- catalog: adapter entries validate; bad version, missing lockfile or missing integrity demotes.
- installing a provider also installs its adapter into `providers/<slot>/releases`, flips `current`.
- adapter install failure: CLI result stays installed, error reported, old adapter release intact.
- rollback on a failed post-promote check; GC keeps the live release.
- reconcile reinstalls an installed provider's drifted adapter.

Code: `ADAPTER_CATALOG` + validation, lockfiles, install core slot parameter, reconcile.

### Phase 3 - live proof and PR

Isolated dev instance (own database, free port, no :1533). Install the Claude toolset through the
admin UI, run a chat turn, and show from the runner process and logs that the adapter path is on the
tools volume and `CLAUDE_CODE_EXECUTABLE` points at the release. Delete the adapter release, run
another chat turn, show it runs from the image copy. Post as a PR comment. Anything not provable live
(for example a Codex chat with no sign-in) is stated plainly.

## Verification

`pnpm format:check && pnpm lint && pnpm typecheck` before each push, unit tests for the touched files
by path, then the full gate through the `verify-gate` skill only, never piped.

## Out of scope

Manifest, signing, refresh job, candidate staging, hold-back, alerts, card states (slices 3 and 4).
Reporting adapter versions in the UI.
