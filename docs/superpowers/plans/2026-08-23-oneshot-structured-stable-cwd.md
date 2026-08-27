# One-shot structured spawns: stable cwd for prompt-cache hits

Part of #1422.

## Problem (verified against branch)

`CliStructuredAdapter.generateOneShotStructured` (packages/chat/src/live/cli-structured-adapter.ts:96-182)
calls `mkdtemp(join(tmpdir(), "jarv1s-structured-"))` on every one-shot call (line 122) and
`rm(neutralDir, { recursive: true, force: true })` in the `finally` block (line 177). That
directory path is handed to the engine as `neutralDir` and lands near the top of the CLI's system
prompt (via `cd <neutralDir> &&` in the launch command, e.g.
packages/chat/src/live/claude-print-chat-engine.ts:79/258/297), so a unique path per call makes
the prompt-cache prefix unique per call. Confirmed still true on this branch — no existing
per-kind directory logic anywhere in this file.

All one-shot AND scoped structured runs already share one process-wide semaphore
(`activeCliStructuredRuns`, `acquireCliStructuredSlot`/`releaseCliStructuredSlot`, lines 21-72) —
only one CLI structured run is ever active at a time in a process. This means reusing a directory
across calls carries no concurrent-write risk; the existing lock already provides the "no
cross-call payload bleed under concurrency" property, we just need the directory PATH to be
stable while what's inside it still gets wiped between calls (privacy: prompts can carry private
module data — see the `#981` comment at line 175 — so we keep the delete-then-recreate cycle, just
pinned to the same path).

`GenerateStructuredProviderInput` (packages/ai/src/adapters/http-api-structured.ts:47-57) has no
field identifying which module/service is calling, so `CliStructuredAdapter` cannot key a stable
directory today. `GenerateStructuredInput.service: ModuleServiceKey` (packages/ai/src/structured/generate-structured.ts:52,
type `` `module.${string}` `` from packages/shared/src/ai-types.ts:99) already carries this at the
call site but is not threaded into the adapter call (packages/ai/src/structured/generate-structured.ts:143-153
omits it).

A validating path-segment sanitizer already exists and fits directly:
`sanitizeSessionKey` (packages/chat/src/live/cli-session-lifecycle.ts:60-73) — throws on `/`, `\`,
NUL, `.`/`..`. `ModuleServiceKey` values are developer-chosen module ids and never contain those,
so this is a correctness check, not a new sanitizer to design.

## Scope

One-shot path only (`generateOneShotStructured`). `generateScopedStructured` already reuses one
long-lived directory per scope for the life of that scope (a different, already-solved cache
problem) — out of scope per the issue's "one-shot structured spawns" framing and the 7,748-call
figure, which is one-shot volume.

## Plan

### Task 1 — thread `service` through to the provider adapter input

- `packages/ai/src/adapters/http-api-structured.ts`: add `import type { ModuleServiceKey } from "@moss/shared";`
  and add `readonly service: ModuleServiceKey;` to `GenerateStructuredProviderInput` (after `model`).
- `packages/ai/src/structured/generate-structured.ts`: pass `service: input.service` in the
  `adapter.generateStructured({...})` call (~line 144).
- No behavior change for `HttpApiAdapter` (packages/ai/src/adapters/http-api.ts) — it ignores the
  new field, same as it ignores `scope`/`closeScope` today.

Test: `packages/ai/src/structured/generate-structured.test.ts` (new file) — a fake
`StructuredProviderAdapter.generateStructured` capturing its input; assert `service` on the
captured input equals `input.service` passed to `generateStructured()`. Fails today because the
field does not exist / is not forwarded.

### Task 2 — stable per-service directory in `CliStructuredAdapter`

- `packages/chat/src/live/cli-structured-adapter.ts`:
  - Import `mkdir` from `node:fs/promises` (alongside existing `mkdtemp, rm, writeFile`) and
    `sanitizeSessionKey` from `./cli-session-lifecycle.js`.
  - Add `const STRUCTURED_ONE_SHOT_ROOT = join(tmpdir(), "jarv1s-structured");`
  - Add `function oneShotStructuredDir(service: string): string { return join(STRUCTURED_ONE_SHOT_ROOT, sanitizeSessionKey(service)); }`
  - In `generateOneShotStructured`, replace `neutralDir = await mkdtemp(join(tmpdir(), "jarv1s-structured-"))`
    with `neutralDir = oneShotStructuredDir(input.service); await mkdir(neutralDir, { recursive: true, mode: 0o700 });`
  - Leave the existing `finally` block's `rm(neutralDir, { recursive: true, force: true })` as-is —
    the directory is destroyed and recreated at the same path every call, so the cache-relevant
    path stays constant while contents never survive between calls (see privacy note above).
  - `generateOneShotStructured`'s signature is unchanged; `input.service` is required on
    `GenerateStructuredProviderInput` after Task 1, so no optional-handling branch is needed.

Test: `packages/chat/src/live/cli-structured-adapter.test.ts` (new file):

1. Two consecutive `generateOneShotStructured` calls with `service: "module.job-fit"`, mocked
   `engineFactory` capturing `neutralDir` from each `launch()` call — assert both calls saw the
   identical `neutralDir` string. Fails today (mkdtemp gives a different path every call).
2. A call with `service: "module.job-fit"` and a call with `service: "module.other"` — assert the
   two `neutralDir` values differ (per-kind isolation, not one global shared dir).
3. After a call completes, assert the directory itself does not exist on disk (finally still runs
   `rm`) — regression guard for the privacy property called out above.
4. A `service` value crafted to defeat the sanitizer (e.g. `"module.../etc"`) throws before any
   directory is touched — reuses `sanitizeSessionKey`'s existing behavior, asserts it's actually
   wired in.

## Verification

```bash
pnpm --filter @moss/ai test -- generate-structured > /tmp/verify-1422-ai.log 2>&1; echo "EXIT=$?"
pnpm --filter @moss/chat test -- cli-structured-adapter > /tmp/verify-1422-chat.log 2>&1; echo "EXIT=$?"
```

Expected exit code: 0 for both.

Full gate at wrap-up time only, via the `verify-gate` skill (never run directly) — this change
touches shared types (`@moss/ai`, `@moss/shared`) so a typecheck across dependents is warranted.

## Determinism / user-facing boundary

Not applicable — no model output changes, no new UI surface, no chat-visible behavior change. The
issue's own acceptance criteria says as much ("no visible change"). This is why the spec-before-build
gate in CLAUDE.md ("no new feature or module without an approved design spec") does not apply here:
this is neither a new feature nor a new module, it's an internal caching fix to existing plumbing.

## Kill gate

Phase 1 is the whole fix (both tasks above ship together — Task 2 doesn't compile without Task 1's
type change, they're not independently shippable). If, once this is implemented and tested, the
`neutralDir` reuse turns out to break `purgeTranscripts()`'s per-call transcript cleanup (i.e. a
transcript from call N is still discoverable by call N+1's engine because `transcriptGlobDir`
hashes something other than `neutralDir`), stop and re-check that assumption before pushing —
that would be a correctness bug, not a perf regression, and blocks this PR. Owner: build agent
(self) — verified in Task 2 test #3 above (directory removed after each call, so any transcript
subdirectory nested under it goes with it).

## Exit criteria

- Both new tests pass, observed.
- `pnpm --filter @moss/ai test` and `pnpm --filter @moss/chat test` green for the touched files.
- Pre-push trio (`format:check`, `lint`, `typecheck`) green.
- PR opened, no live-UI proof needed (no user-facing surface — "no visible change" per the issue).
