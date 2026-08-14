# Build Plan — #1141 credential-env isolation in the provider auth probe

**Issue:** #1141 (`motioneso/moss`). No separate spec doc — per handoff
`docs/coordination/handoffs/2026-08-13-1141-credential-env-isolation.md`, the issue body fully
specifies the fix; build off the issue text.
**Risk:** security — credential-env leakage between isolated provider identities.

## Verified seams

- `packages/chat/src/live/provider-probe.ts:44-49` — `probeClaudeAuth` calls
  `io.run("claude", ["auth", "status"], credentialEnv ? { env: credentialEnv } : undefined)`.
  `credentialEnv` is treated as a truthy/falsy override signal, not merged with an explicit HOME.
- `packages/cli-runner/src/provider-token-store.ts:67-75` — `readProviderCredentialEnv` returns
  `{}` (truthy, empty) whenever no token is yet persisted for the provider — this is the exact
  input that reaches `probeClaudeAuth` on a fresh/isolated identity.
- `packages/ai/src/adapters/tmux-bridge.ts:40-48` (`createRealTmuxIo`) — merge is
  `opts?.env ? {...process.env, ...opts.env} : process.env`. With `opts.env = {}`, the merge
  degrades to plain `process.env` — no HOME override at all.
- `packages/cli-runner/src/runner-io.ts:27-34` (`createSanitizedTmuxIo`) — merge is
  `opts?.env ? {...baseEnv, ...opts.env} : baseEnv`, `baseEnv = buildSanitizedCliEnv(source)`.
  `HOME` and `PATH` are both on `sanitized-env.ts`'s `ALLOWED_KEYS` (lines 15-16), so `baseEnv.HOME`
  is whatever HOME the **cli-runner server process** itself has — in host-mode dev that's the
  operator's real shell HOME, not the isolated identity's `homeBase`. This is true even through
  the sanitized adapter, which is the actual path #1110's live-proof hit (confirmed against the
  issue's "Discovered during" section: worked around at harness level by forcing HOME/PATH at
  cli-runner process launch).
- `packages/cli-runner/src/terminal-session.ts:46-50` — the correct pattern already in the repo:
  explicit `HOME: opts.homeBase` layered over a sanitized base, never inferred from ambient env.
- `packages/cli-runner/src/main.ts:201-207` — `LoginService`'s `probe` callback calls
  `probeProvider(provider, { io, cliPresent, multiplexerUsable, credentialEnv: await
readProviderCredentialEnv(config.homeBase, provider) })`. `config.homeBase` (always a string,
  `main.ts:84-88`) is in scope here but not currently threaded through.
- `packages/cli-runner/src/engine-host.ts:634-645` — `CliChatEngineHost.probeProvider` calls
  `probeProvider(provider, { io: this.deps.io, cliPresent, multiplexerUsable, credentialEnv:
this.deps.homeBase ? await readProviderCredentialEnv(this.deps.homeBase, provider) : undefined
})`. `this.deps.homeBase` (`string | undefined`, `engine-host.ts:66`) is in scope but not
  threaded through.
- No existing test file for `provider-probe.ts` (`find packages/chat -iname '*provider-probe*'`
  returns only the source file) — this is new coverage, not a regression risk to existing tests.
- Only `probeProvider`, `ProbeProviderStatus`, `ProbeProviderResult` are exported from
  `provider-probe.ts` (`grep -n '^export'`) — `probeClaudeAuth` is private; the new test exercises
  the fix through the public `probeProvider` entry point only.

## Decisions

- Add `readonly homeBase?: string` to `probeProvider`'s `deps` parameter
  (`packages/chat/src/live/provider-probe.ts:17-24`).
- Thread it to a new third parameter on the private helper:
  `probeClaudeAuth(io: Pick<TmuxIo, "run">, credentialEnv?: NodeJS.ProcessEnv, homeBase?: string)`.
- Replace the truthiness-gated env build (line 49) with an explicit merge that always wins over
  ambient HOME when either input is present:
  ```ts
  const env: NodeJS.ProcessEnv | undefined =
    homeBase === undefined && credentialEnv === undefined
      ? undefined
      : { ...(homeBase === undefined ? {} : { HOME: homeBase }), ...credentialEnv };
  ```
  then call `io.run("claude", ["auth", "status"], env ? { env } : undefined)`. An empty
  `credentialEnv` (`{}`) no longer degrades to "no override" once `homeBase` is supplied — the
  explicit `HOME` key always survives the adapter-level merge regardless of which `TmuxIo` merge
  strategy (`createRealTmuxIo` or `createSanitizedTmuxIo`) sits underneath, because both spread
  `opts.env` last.
- Do not touch `PATH`, `probeCodexAuth`, or `probeGeminiAuth` — the issue and handoff scope this to
  the Claude credential-env path; PATH construction (toolsBinDir prefixing) is an adapter-level
  concern already correctly owned by `runner-io.ts`/`tmux-bridge.ts`, and widening this fix to
  reconstruct PATH here would duplicate that ownership without closing any additional leak (the
  leak is specifically about which identity's on-disk credentials `claude auth status` reads,
  which is a HOME question).
- Call-site changes (both purely additive — one new field each):
  - `packages/cli-runner/src/main.ts:207` — add `homeBase: config.homeBase,` to the deps object
    passed to `probeProvider`.
  - `packages/cli-runner/src/engine-host.ts:640-642` — add `homeBase: this.deps.homeBase,` to the
    deps object passed to `probeProvider`.

## Phase 1 — isolate the probe env, add regression coverage, wire both callers

Files: `packages/chat/src/live/provider-probe.ts`, `packages/chat/src/live/provider-probe.test.ts`
(new), `packages/cli-runner/src/main.ts`, `packages/cli-runner/src/engine-host.ts`.

- Implement the `provider-probe.ts` change per Decisions above.
- New test file `provider-probe.test.ts`, exercising only the public `probeProvider("anthropic",
deps)` entry point with a fake `io.run` that records `opts`:
  1. **Regression proof (primary exit criterion)** — a fake `io.run` that mimics
     `createRealTmuxIo`'s exact merge (`{...process.env, ...opts.env}`), with `process.env.HOME`
     stubbed to a sentinel ambient value (`vi.stubEnv("HOME", "/ambient/leak-sentinel")`,
     restored via `vi.unstubAllEnvs()` in `afterEach`). Call `probeProvider("anthropic", { io,
cliPresent: async () => true, credentialEnv: {}, homeBase: "/isolated/identity" })`. Assert
     the env actually delivered to the simulated child process has `HOME === "/isolated/identity"`
     — i.e. it would fail against the pre-fix code (`credentialEnv={}` is truthy, so pre-fix passes
     `{env: {}}`, whose merge falls through to the ambient sentinel).
  2. `credentialEnv` with a token key still reaches the subprocess alongside the HOME override —
     call with `credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" }, homeBase: "/isolated/identity"`,
     assert both keys present in the delivered env.
  3. Neither `homeBase` nor `credentialEnv` supplied (a caller that opts out of isolation, e.g. a
     future/test caller) — assert `io.run` is called with `opts === undefined` (no behavior change
     from pre-fix for a caller that never passes either).
  4. Existing status-parsing behavior is unaffected — `io.run` resolving `{code: 0, stdout:
'{"loggedIn":true}'}` still yields `{status: "ready"}` with the new env plumbing in place.
- Wire `main.ts` and `engine-host.ts` per Decisions; grep after editing
  (`rg -n "probeProvider\(" packages/cli-runner/src/main.ts packages/cli-runner/src/engine-host.ts`)
  to confirm both call sites now pass `homeBase`.
- Run the focused test and typecheck; the observed pass is this phase's live wiring proof (this is
  an internal security-boundary fix with no new UI surface — no UAT spec applies; state that
  explicitly in the PR per the live-path gate's "purely internal, no user-facing surface" carve-out).

**Kill gate (owner: build agent; escalate to Coordinator):** stop if `vi.stubEnv`/`vi.unstubAllEnvs`
are unavailable in this repo's vitest version, or if simulating the adapter merge inline in the
test cannot actually reproduce the pre-fix failure (i.e. the test passes even against the
unmodified source) — a test that can't fail against the bug is not a regression proof; escalate
rather than ship a weaker assertion.

## Verification

- `pnpm exec vitest run packages/chat/src/live/provider-probe.test.ts > /tmp/1141-test.log 2>&1; echo "EXIT=$?"` — expected `EXIT=0`.
- `pnpm typecheck > /tmp/1141-typecheck.log 2>&1; echo "EXIT=$?"` — expected `EXIT=0`.
- `pnpm format:check > /tmp/1141-format.log 2>&1; echo "EXIT=$?"` — expected `EXIT=0`.
- `pnpm lint > /tmp/1141-lint.log 2>&1; echo "EXIT=$?"` — expected `EXIT=0`.
- `rg -n "homeBase" packages/cli-runner/src/main.ts packages/cli-runner/src/engine-host.ts` —
  expected both files show the new `homeBase:` field at the `probeProvider` call site.
- Full gate (`verify-gate` skill, isolated gate DB) before wrap-up, per the handoff's exit criteria.

PR is tagged `[SECURITY]` per handoff; report ready-to-review, never merge from this lane — this
tier gets adversarial Opus QA plus Ben's explicit merge sign-off.
