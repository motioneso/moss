# Build Plan — #1612 chat multiplexer environment isolation

**Issue:** #1612. The coordinator brief says the issue text is the approved scope for this small
security repair. **Risk:** security. **Surface:** internal process boundary; no new user interface.

## Verified seams

- `packages/module-registry/src/chat-multiplexer.ts:179-193` defines the host fallback provider
  check and already has a command-I/O test seam, but no environment input.
- `packages/module-registry/src/chat-multiplexer.ts:211-229` creates a temporary neutral folder,
  then constructs `createRealTmuxIo()` without a base environment for all three provider checks.
- `packages/module-registry/src/chat-multiplexer.ts:573-589` accepts an environment for engine
  resolution but constructs its terminal I/O from ambient `process.env` instead.
- `packages/module-registry/src/index.ts:2640-2654` already captures the composition root's
  environment, so it can be passed into the provider-check factory without a new configuration.
- `packages/cli-runner/src/sanitized-env.ts:65-95` already owns the CLI subprocess allowlist and
  removes database, authentication, encryption, and vault secrets.
- `packages/cli-runner/src/runner-io.ts:27-40` already applies that allowlist to every spawned
  command. `@moss/module-registry` already depends on and may import `@moss/cli-runner`.
- Pull request #1601 established the matching rule: the subprocess environment must carry an
  explicit isolated `HOME`; it must not fall back to the caller's ambient home.

## Decision

- Reuse `createSanitizedTmuxIo`; do not add another allowlist or subprocess adapter.
- Add `readonly env?: NodeJS.ProcessEnv` to `makeProviderConnectionCheckProbe` and pass the
  composition root's existing `env` value into it.
- For the three host fallback provider checks, create one sanitized I/O object from the supplied
  environment with `HOME` replaced by that check's temporary neutral folder. Keep injected
  `commandIo` behavior unchanged for existing callers and tests.
- In `resolveChatEngineFactory`, replace its ambient I/O construction with the same existing
  sanitized adapter. Use `JARVIS_CLI_HOME_BASE` when configured and the operating system temporary
  folder otherwise, so its terminal check never receives the real host home by default.
- Do not change the optional per-user UID path in `engine-host.ts`; issue #1612 calls it latent and
  non-blocking, while this repair covers the reachable host fallback named in the issue.

Rejected alternative: passing only an `opts.env.HOME` override to `createRealTmuxIo` would mirror
the narrowest part of #1601, but that adapter merges the override into the full ambient environment.
It would leave every unrelated secret present, contrary to this issue's requirement that the child
receive only what it needs. Reusing the shipped allowlist is smaller and closes both leaks once.

## Phase 1 — repair and regression proof

Files:

- `packages/module-registry/src/chat-multiplexer.ts`
- `packages/module-registry/src/index.ts`
- `tests/unit/chat-multiplexer-provider-check.test.ts`
- `tests/unit/chat-multiplexer-persistent-pool-settings.test.ts` only if its existing engine-factory
  seam is needed to prove the second named call site

Tests:

1. Run the real host fallback provider-check path with a temporary fake provider executable. Have
   the child record its delivered environment, then assert its `HOME` is the temporary provider-check
   folder and a poisoned ambient secret is absent. This fails if the call site returns to
   `createRealTmuxIo()`.
2. Exercise engine resolution with its existing fake multiplexer executable and assert that child
   likewise receives the configured isolated home and not the poisoned ambient secret. Add this only
   if the existing test seam can observe the spawned check without widening production interfaces.
3. Preserve the existing provider status assertions for Anthropic, Codex, and Google.

Observed phase check: run the focused unit tests and record exit 0. This is an internal subprocess
boundary with no new user-facing surface, so no live browser test applies.

## Verification

- `pnpm exec vitest run tests/unit/chat-multiplexer-provider-check.test.ts tests/unit/chat-multiplexer-persistent-pool-settings.test.ts` — expected exit 0.
- `pnpm format:check` — expected exit 0.
- `pnpm lint` — expected exit 0.
- `pnpm typecheck` — expected exit 0.
- `scripts/run-gate.sh start`, then `scripts/run-gate.sh wait --follow` — expected final exit 0 on
  the isolated gate database.

## Kill gate

Owner: build agent, with any fork sent to the coordinator. Stop after the first failing regression
test if the fake executable cannot observe the actual default I/O path, or if sanitizing this path
removes a documented variable that a provider check demonstrably needs. Do not weaken the test or
widen the allowlist without coordinator approval.
