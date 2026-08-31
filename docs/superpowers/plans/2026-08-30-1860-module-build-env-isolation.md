# Plan — #1860 module-build worker environment isolation

**Task issue:** #1860 (task, security — Part of #1738)
**Spec:** `docs/superpowers/specs/2026-08-30-1860-module-build-env-isolation.md` (approved
2026-08-30, **parity scope**)
**Branch/worktree:** per fleet assignment; slices share one worktree and one PR.
**Size:** one build slice, one agent session.
**Security posture:** PR marked security-sensitive; adversarial security review plus Ben's
explicit sign-off required. Release note **Category: N/A** (internal hardening, no user-visible
change).

## Approved scope ruling (record verbatim in the PR security claim)

Ben approved the **parity scope** on 2026-08-30: `PATH` and `JARVIS_CLI_TOOLS_PREFIX` are trusted
operator deployment configuration. This change closes the worker's bypass of the existing
chat-path CLI child-environment boundary. It must **not** claim to make provider resolution
independent of a deployment operator who controls `PATH` or `JARVIS_CLI_TOOLS_PREFIX`; executable
integrity independent of those values is explicitly out of scope.

## Seams check (file:line citations, current `origin/main` @ e947239ea)

- `apps/worker/src/worker.ts:223` — the defect: `createRealTmuxIo({ ...process.env, HOME:
moduleBuildCliHome })` hands the worker's complete environment to every module-build subprocess.
  `createRealTmuxIo` is imported at `worker.ts:55` from `@moss/ai` and this is its only worker use.
- `apps/worker/src/worker.ts:224` — `TmuxMultiplexer(moduleBuildIo, { homeBase:
moduleBuildCliHome })` consumes the same I/O; `worker.ts:240-246` passes it into
  `createModuleBuildLiveAgent({ io: moduleBuildIo, mux: moduleBuildMux, ... })`. One substitution
  at the composition root therefore covers tmux creation, provider launch, and post-write build
  commands.
- `apps/worker/src/worker.ts:125-132` — `resolveModuleBuildCliHome(env, osHome)`, already exported.
- `packages/cli-runner/src/runner-io.ts:27-31` — `createSanitizedTmuxIo(source?, spawnOpts?)`
  returns a `TmuxIo` (typed against `@moss/ai`'s `TmuxIo`, `runner-io.ts:15`) whose every `run()`
  uses `buildSanitizedCliEnv(source)` as the base env, layering per-call `opts.env` over it. It is
  exported from the package (`packages/cli-runner/src/index.ts:17`), and drop-in compatible with
  `createRealTmuxIo` (`packages/ai/src/adapters/tmux-bridge.ts:40`) — both implement `TmuxIo`
  including `readFile`/`writeFile`.
- `packages/cli-runner/src/sanitized-env.ts:71-93` — `buildSanitizedCliEnv`: deny-by-default
  allowlist (`HOME`, `PATH`, `JARVIS_CLI_TOOLS_PREFIX`, CLI-home keys, locale, named non-secret
  controls; lines 14-53) plus the exact-value UAT pin: `JARVIS_UAT_SCRIPTED_PROVIDER_BIN` survives
  only when byte-equal to `"/app/tests/uat/fixtures/scripted-provider/bin"` (line 61), and
  `JARVIS_UAT_SEED_CHAT_SCRIPT` only travels alongside it (lines 84-89). `HOME` is on the
  allowlist, so the module-build `HOME` override survives sanitization.
- `apps/worker/package.json:15` — `@moss/cli-runner` is already a worker dependency; no new edge.
- Comments to correct: `packages/cli-runner/src/sanitized-env.ts:55-61` (the value-pin comment
  claims the pin means the var is "never a lever an attacker can turn to point production
  PATH-resolution at their own program" — true only for children built through this policy) and
  `scripts/start-jarv1s.ts:113-119` (same container-wide phrasing beside the pin inside
  `buildChildEnv`, which only the `cli-runner` role passes through — `start-jarv1s.ts:75-88` shows
  the worker role returns the env essentially untouched, by design).
- `scripts/start-jarv1s.ts:150` — the resident worker keeps `buildChildEnv("worker", env)`
  (full app env). Per the spec this is untouched: the worker needs database/queue/vault config for
  its host duties; isolation happens only at the module-build subprocess boundary.
- Test import pattern: `tests/integration/worker-lifecycle.test.ts:31` already imports directly
  from `../../apps/worker/src/worker.js`, so a unit test can import a worker-exported factory the
  same way.

## Task 1 — sanitize the module-build composition root

**File:** `apps/worker/src/worker.ts`

1. Add a small exported factory so the worker-owned seam is testable (this is the seam the spec's
   regression requirement names, not a decorative wrapper — without it the only alternatives are
   re-testing `buildSanitizedCliEnv` in isolation, which the spec forbids, or booting `buildWorker`
   against a database):

   ```ts
   export function createModuleBuildIo(env: NodeJS.ProcessEnv, moduleBuildCliHome: string): TmuxIo;
   ```

   Body decision (contract, not code): returns
   `createSanitizedTmuxIo({ ...env, HOME: moduleBuildCliHome })`.

2. `buildWorker` (line 223) constructs
   `const moduleBuildIo = createModuleBuildIo(process.env, moduleBuildCliHome);`.
   The `TmuxMultiplexer` line (224) and all downstream wiring are unchanged.

3. Remove `createRealTmuxIo` from the `@moss/ai` import at `worker.ts:55` (no remaining worker
   use); import `createSanitizedTmuxIo` from `@moss/cli-runner`.

`createModuleBuildLiveAgent` and `createRunModuleBuildStepForJob` remain unaware of environment
policy, exactly as the spec's architecture requires.

## Task 2 — correct the two overbroad comments

- `packages/cli-runner/src/sanitized-env.ts:55-61`: restate the pin's boundary — it protects
  every child env built through `buildSanitizedCliEnv` (chat/cli-runner children and, after this
  change, worker module-build children); any future subprocess root must adopt this policy
  explicitly or it is unprotected.
- `scripts/start-jarv1s.ts:113-119`: state that this pin applies to the `cli-runner` child role
  only, and that other roles (worker, api) receive the full app env by design, with the worker's
  module-build subprocess tree protected separately at its own composition root
  (`apps/worker/src/worker.ts`).

Neither comment may claim container-wide protection.

## Task 3 — regression test at the worker seam

**File:** `tests/unit/worker-module-build-env-isolation.test.ts` (new)

Imports `createModuleBuildIo` from `../../apps/worker/src/worker.js`. Delivery is via a **real
child process**: `io.run(process.execPath, ["-e", <print JSON.stringify(process.env) to stdout>])`
(use `process.execPath`, not `"node"`, so binary resolution does not depend on the sanitized
child `PATH`). Parse the child's stdout and assert on the actual delivered environment.

Test cases (behaviour + why each fails against a broken implementation):

1. **Attacker env is dropped.** Source env: real `process.env` spread plus
   `JARVIS_UAT_SCRIPTED_PROVIDER_BIN: "/tmp/evil-bin"`,
   `JARVIS_UAT_SEED_CHAT_SCRIPT: "/tmp/evil.script"`,
   `MOSS_DATABASE_URL: "postgres://x"`, `POSTGRES_PASSWORD: "pw"`,
   `BETTER_AUTH_SECRET: "s"`, `JARVIS_AI_SECRET_KEY: "k"`, `JARVIS_VAULT_DIR: "/v"`,
   `HOME: "/root"`. Call `createModuleBuildIo(source, "/tmp/mb-home")`. Assert the delivered env
   has `HOME === "/tmp/mb-home"`; has **no** `JARVIS_UAT_SCRIPTED_PROVIDER_BIN`,
   `JARVIS_UAT_SEED_CHAT_SCRIPT`, `MOSS_DATABASE_URL`, `POSTGRES_PASSWORD`,
   `BETTER_AUTH_SECRET`, `JARVIS_AI_SECRET_KEY`, or `JARVIS_VAULT_DIR` key. Against the pre-fix
   composition (`createRealTmuxIo` + spread), every one of these assertions fails — the full env
   passes through.
2. **The shipped fixture value still survives.** Same call with
   `JARVIS_UAT_SCRIPTED_PROVIDER_BIN: "/app/tests/uat/fixtures/scripted-provider/bin"` and a
   `JARVIS_UAT_SEED_CHAT_SCRIPT` value: both keys present in the delivered env, bin byte-equal to
   the fixture literal. Fails if someone "hardens" by dropping the pin entirely, which would break
   live UAT.
3. **Rejected bin drops the paired script.** Attacker bin + a seed-script value: assert the seed
   script is absent too. Fails against a naive allowlist that admits the script key
   unconditionally.

This exercises the worker's own factory through the sanitized adapter's real `execFile`, not
`buildSanitizedCliEnv` in isolation, satisfying the spec's "fails against the pre-fix worker
composition" requirement: reverting the factory body to `createRealTmuxIo({ ...env, HOME })`
turns case 1 red.

## Determinism boundary

N/A — no model output crosses any boundary in this change; no UI. The module-build agent's
prompts, permissions, and lifecycle are untouched (spec non-goal).

## Verification (unpiped, expected exit codes)

```bash
pnpm test:unit tests/unit/worker-module-build-env-isolation.test.ts > /tmp/1860-test.log 2>&1; echo "EXIT=$?"  # expect EXIT=0
npx tsc --noEmit > /tmp/1860-tsc.log 2>&1; echo "EXIT=$?"                                                       # expect EXIT=0
npx eslint apps/worker/src/worker.ts packages/cli-runner/src/sanitized-env.ts scripts/start-jarv1s.ts tests/unit/worker-module-build-env-isolation.test.ts --max-warnings=0 > /tmp/1860-lint.log 2>&1; echo "EXIT=$?"  # expect EXIT=0
pnpm format:check > /tmp/1860-fmt.log 2>&1; echo "EXIT=$?"                                                      # expect EXIT=0
```

Full isolated gate before PR-ready, via the `verify-gate` skill only; expected exit 0.

**Live functional check (internal, not a UI gate):** on the live dev instance, run one real module
build end to end (existing Workshop flow) and confirm the provider CLI still launches and the
build completes. This is the change's main regression risk — the sanitized allowlist could drop a
variable the module-build path needed that chat never did. Record the build id and outcome on the
PR. This is evidence of non-breakage, not a Live-Path Gate artifact (spec: no UI surface).

## Prod-safety check

No new required setting is introduced (the adapter and policy already exist and are already
exercised in production by the chat path), so no compose/env file changes are needed. State this
explicitly in the PR under the "a PR must never break prod" rule.

## Kill gate

Single slice, no phase 2. Stop-the-line observation: the dev live module build fails after
sanitization because a needed environment variable was dropped. Do **not** widen the
`buildSanitizedCliEnv` allowlist to fix it — that policy is shared with the chat path and is the
canonical boundary. Stop, name the missing variable and why module builds need it, and escalate to
Ben; owner of any allowlist change decision: Ben.

## Open questions

None. All capabilities cited; the one judgment call (introducing the exported
`createModuleBuildIo` factory as the testable seam) is justified in Task 1 against the
"no thin wrappers" standard.
