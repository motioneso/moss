# Plan: CLI tools manifest publisher (issue #2689, slice 3)

Spec: `docs/superpowers/specs/2026-09-25-cli-tools-auto-update.md`, sections 4.1, 4.3, 5.1, 10.

## Scope

- Toolsets published: `anthropic` (Claude CLI + Claude chat adapter), `openai-compatible`
  (Codex CLI + Codex chat adapter), `google` (Gemini CLI).
- OpenCode is left out. It has no install recipe in the image catalog yet, so the real install
  path cannot install it. It joins once it becomes a catalog entry.
- No instance-side code. Fetching and staging are slice 4.

## Pieces

| Piece                                                 | File                                                 |
| ----------------------------------------------------- | ---------------------------------------------------- |
| Toolset list, expected provenance repos               | `packages/cli-runner/src/cli-tools/toolsets.ts`      |
| Manifest types, strict parser                         | `packages/cli-runner/src/cli-tools/manifest.ts`      |
| Flags Moss passes, per CLI and subcommand             | `packages/cli-runner/src/cli-tools/flag-contract.ts` |
| Version pick, lockfile shape, provenance rules (pure) | `packages/cli-runner/src/cli-tools/trust-checks.ts`  |
| Publisher entry point                                 | `scripts/cli-tools/publish-cli-tools-manifest.ts`    |
| Offline contract check                                | `scripts/cli-tools/contract-check.ts`                |
| Workflow                                              | `.github/workflows/cli-tools-manifest.yml`           |

## Decisions

- The flag contract is a declared list, not a call into the engines' private command builders.
  Those builders are private methods that write shell strings. A unit test scans every engine
  source file for `--flag` literals and fails when one is missing from the contract, so the list
  cannot drift silently.
- Flags missing from `--help` (Claude hides some) are proven with a probe run that must not answer
  "unknown option".
- Tarball checksums cover lockfile entries an instance can install (no `os` field, or `os`
  includes linux).
- Provenance: a package with a recorded source repo must match it. Any package that carried
  provenance before and arrives without it blocks the toolset. History lives in the release asset
  `provenance-history.json` and is never cleared.
- A dispatch input `break_check_for=<toolset>` adds one flag that does not exist to that toolset's
  contract. It exists for the live proof of the blocking path.
- Signing reuses the module catalog key through `packages/module-registry/src/node.ts`.

## Tasks

1. Pure modules plus unit tests (manifest round trip, provenance rules, version pick, contract
   truthfulness).
2. Contract check script, run locally against current and newest versions.
3. Publisher script and workflow.
4. Live proof on the branch: real publish, then a broken-flag run that blocks a toolset and opens
   an issue.
5. Gate, cross-model review, PR.

## Findings during the build

- Codex blocks today, correctly. `codex exec resume` does not accept `--sandbox`, which the
  persistent Codex runtime passes on every turn after the first (#2698). The Codex toolset stays
  unpublished until that is fixed and the contract drops the flag.
- OpenCode has no toolset yet because the image catalog has no install recipe for it.
