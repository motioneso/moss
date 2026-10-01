# Chat adapter handshake check uses the real resolver (#2822)

Small fix under #2689. No spec; the issue describes it.

## Seams checked

- `scripts/cli-tools-manifest/contract-check.ts` `checkAdapter` installs the adapter into a
  throwaway folder and starts its `bin` directly.
- `packages/cli-runner/src/tools-volume-adapters.ts` `resolveToolsVolumeAdapterEntry` and
  `applyToolsVolumeCli` are what Moss uses at launch (merged in #2826).

## Decisions

- `checkAdapter` installs the adapter at `<prefix>/providers/<adapter slot>/<release>`, points
  `current` at it, then asks the resolver for the entry and the CLI override env.
- New exported `acpInitializeViaResolver(prefix, kind, timeoutMs)` resolves entry + env through
  the resolver, then calls `acpInitialize`. A null resolution is a failure, not a fallback.
- Toolset to kind: `anthropic` -> `anthropic`, `openai-compatible` -> `openai`; other toolsets
  have no chat adapter.

## Tests (tests/unit/cli-tools-manifest-contract.test.ts), written first

1. Fake tools prefix with a fake adapter at the resolver's path answers; handshake passes.
2. The fake adapter echoes `CLAUDE_CODE_EXECUTABLE`; it equals the prefix CLI path (env comes
   from `applyToolsVolumeCli`).
3. Prefix with no adapter at the resolver path: rejects "resolver found no adapter".

## Verification

`pnpm vitest run tests/unit/cli-tools-manifest-contract.test.ts` (no database), then
format:check, lint, typecheck.
