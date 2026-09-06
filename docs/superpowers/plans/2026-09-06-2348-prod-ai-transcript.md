# Plan: production AI transcript path mismatch (issue #2348)

Part of #2348.

## Scope, as settled by the coordinator

Exactly three items. Nothing else in this pull request.

1. Fix the kill-then-read race in the background-job structured call path, so the app
   waits until the model program has actually stopped before it reads the answer file
   and decides what happened.
2. When the app and the model program genuinely disagree about where the answer file
   lives, fail loud and fast instead of hanging silently for the full two minutes.
3. The four places that start the model program without saying which home folder to
   use, so each one says so explicitly.

Not in this pull request (found during investigation, reported to the coordinator,
will get their own issue and lane):

- About ninety leftover answer-file folders under the wrong home folder. Caller not
  yet identified.
- Why the model program is slow to answer in the first place. Confirmed: background
  jobs always start a brand new copy of the program for every single call, never a
  warmed-up reused one (packages/chat/src/live/cli-structured-adapter.ts lines 140 and
  220, `this.engineFactory(this.provider, \`structured-${randomUUID()}\`, ...)`). The
  deeper "why so slow" question is out of scope here.

Not raising the two-minute budget. Making the wait longer makes the slow path slower
and hides the failure for longer, which is the opposite of what Ben needs.

## Gate 0 - spec and issue

This is a production bug fix against existing behavior, not a new feature or module,
so the "approved spec before build" gate does not apply (CLAUDE.md: "no new feature
or module without an approved design spec"). The task issue is #2348, already open.
No front-end mockup gate applies either — no user-facing screen changes here.

## Seams check (file:line citations)

- The race: `packages/chat/src/live/cli-structured-adapter.ts` lines 145-151. The
  timeout timer calls `void activeEngine.kill().catch(() => undefined)` without
  awaiting it, then immediately calls `reject(...)` in the same tick. `kill()` (see
  below) nulls out the engine's process handles synchronously before its first
  `await`. When the `catch` block at lines 165-167 then calls
  `await activeEngine.kill()` a second time, `kill()` sees both process handles
  already null (line 320: `const child = this.structuredProcess ?? this.currentProcess`)
  and returns immediately without waiting for anything — so the second, awaited call
  is a no-op, and `activeEngine.readNew(0)` on line 167 runs while the real
  SIGTERM/SIGKILL from the first, unawaited call may still be in flight.
- `kill()` itself already does the right thing when actually awaited:
  `packages/chat/src/live/claude-print-chat-engine.ts` lines 319-348. It sends
  SIGTERM, races a 1-second grace period against the process's own `exit`/`error`
  event, sends SIGKILL if needed, and always resolves only after the process has
  actually stopped (`await exited` on lines 341 and 346). This is the "wait until
  actually stopped" primitive the coordinator asked for — it already exists and
  already works; the bug is that the current code bypasses it by calling `kill()`
  twice, where only the first (unawaited) call does real work.
- The scoped-session call path (`generateScopedStructured`,
  `packages/chat/src/live/cli-structured-adapter.ts` lines 203-297) does not have
  this same race: on timeout it calls `controller.abort()` (line 267) and the read
  loop (`readScopedTurn`, lines 299-328) checks `signal.aborted` at the top of every
  loop and throws immediately — no kill-then-read step, and no late-read recovery
  attempt at all. This plan does not touch that path; it is not the race the
  coordinator found, and adding a late-read there would be new behavior, not a fix.
- The silent hang: `packages/chat/src/live/claude-print-chat-engine.ts`
  `readNew()`, lines 254-298. On every unreadable-transcript miss it warns once
  (lines 275-281) and then returns `{ records: [], offset, complete: false }` — the
  same shape whether the miss is normal (turn just started) or permanent (the app
  and the program will never agree on a folder). The caller's poll loop,
  `packages/chat/src/live/cli-structured-adapter.ts` `run()` lines 358-377, only
  escalates fast when `isAlive()` goes false (line 373-374: "CLI structured
  generation exited without a reply"). A genuine path disagreement, while the
  program itself stays alive and runs normally (this is exactly what #1353 was),
  produces no fast signal at all — it silently polls for the full 120 seconds
  (`CLI_STRUCTURED_TIMEOUT_MS`, line 33) and only then times out.
- The four unsafe spawns and what each one already has available to fix this:
  1. `packages/chat/src/live/claude-print-chat-engine.ts` line 141 (`submit()`) and
     line 200 (`launchStructured()`) — both `spawn("bash", ["-lc", ...], { cwd, ... })`
     with no `env` key at all. `this.homeBase` is already stored on the class
     (constructor, line 112, from `opts.homeBase`) and is already used correctly for
     transcript-path computation (line 120), just never passed into the child's
     environment.
  2. `packages/chat/src/live/claude-persistent-runtime.ts` lines 76-83, the default
     `spawnChild` factory, no `env` key. `opts.homeBase` is available at `launch()`
     time (line 86: `opts: PersistentLaunchOpts`, which is
     `EngineLaunchOpts & { readonly mcpReadiness: McpReadinessProbe }`, and
     `EngineLaunchOpts` carries `homeBase?: string` — same interface as item 1 above)
     but is not currently threaded into the spawn.
  3. `packages/chat/src/live/codex-persistent-runtime.ts` lines 105-112, same default
     `spawnChild` factory pattern, no `env` key. Same `PersistentLaunchOpts.homeBase`
     available at `launch()` (line 115).
  4. `packages/chat/src/live/gemini-print-chat-engine.ts` lines 113-117, no `env` key.
     `this.homeBase` already stored (constructor line 66, from `opts.homeBase`),
     already used correctly for conversation purge (line 161), never passed into the
     spawn.
  - The allowlist filter to build a safe base environment already exists and is
    already correct: `packages/cli-runner/src/sanitized-env.ts`,
    `buildSanitizedCliEnv(source = process.env)` — keeps only `HOME`, `PATH`,
    `NPM_CONFIG_PREFIX`, the `JARVIS_CLI_*`/`MOSS_CLI_*` vars, `TERM`, `LANG`,
    `TMPDIR`, `DISABLE_AUTOUPDATER`, `NO_BROWSER`, and `LC_*`-prefixed keys, and drops
    everything else (RPC secrets, DB URLs, vault keys). It does not set `HOME` itself
    — callers must already have the right `HOME` in the source object, or must
    override it after calling. None of the four spawns above call it today. The one
    correct precedent for this exact pattern already exists in the codebase:
    `packages/cli-runner/src/terminal-session.ts` lines 46-51, which spawns with
    `env: { ...buildSanitizedCliEnv(process.env), HOME: opts.homeBase, TERM: ...,
PATH: ... }`.
  - This is a code fix (pass the already-configured `homeBase` value explicitly into
    each spawn's `env`), not a new environment variable, so it does not trigger the
    "a PR that adds a required setting must update every deployment config" rule —
    nothing new needs to be added to any compose file.

## Determinism boundary

Not applicable — no user-facing chat surface changes here. This is purely about how
reliably and how fast an existing background job's model-program call succeeds or
fails; no model output is newly surfaced to a user, and no new UI feedback is added.

## Decisions

### Task 1 — stop the kill-then-read race (one-shot structured path)

File: `packages/chat/src/live/cli-structured-adapter.ts`,
`generateOneShotStructured()`, lines 145-151 and 165-167.

- Remove the `void activeEngine.kill().catch(() => undefined)` call from inside the
  timeout timer callback (line 149). The timer's only job becomes: mark `timedOut`,
  emit the `timeout` telemetry event, and reject `stopped` — it must not touch the
  engine's process at all.
- Keep the existing `catch` block's `await activeEngine.kill()` (line 166) as the
  single place the engine is actually killed. Because the timer no longer races it,
  this call now runs against the engine's still-populated process handles, so
  `kill()`'s existing wait-for-exit logic (SIGTERM, 1s grace, SIGKILL if needed,
  always resolving only after the process's own `exit`/`error` event —
  `claude-print-chat-engine.ts` lines 319-348) genuinely runs and is genuinely
  awaited before `activeEngine.readNew(0)` executes on line 167.
- No new grace period or timer is added. The existing 1-second SIGTERM grace inside
  `kill()` already is the bounded wait the coordinator asked for; the bug was that
  the code bypassed it by calling `kill()` from two places, only one of which was
  awaited by the caller. Removing the redundant unawaited call is the entire fix.
- Net effect on latency: none in the normal (non-timeout) path. In the timeout path,
  the total time to answer a caller is unchanged or shorter — today it does an
  unawaited kill in the timer and a second, silently-no-op "kill" in the catch block
  before reading; after this fix it does one real kill, awaited once, before reading.

### Task 2 — fail loud and fast on a genuine location disagreement

Files: `packages/chat/src/live/claude-print-chat-engine.ts` (`readNew()`, lines
254-298, plus a new small constant and one new tracked field), and
`packages/chat/src/live/errors.ts` (new error class).

- New error class in `errors.ts`, alongside `CliChatUnavailableError`:

  ```
  export class CliTranscriptLocationMismatchError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CliTranscriptLocationMismatchError";
    }
  }
  ```

  Operator-safe message only (the expected folder path — no prompt or reply content,
  matching the existing rule already followed by the console.warn at line 278).

- New constant in `claude-print-chat-engine.ts`, next to the existing per-file
  constants: `const TRANSCRIPT_DIR_GRACE_MS = 15_000;`
  Reasoning to record in the PR description and in a code comment: this has to be
  small compared to the 120-second budget so the failure is genuinely fast (about
  8x headroom), and long enough that it does not fire during a normal, healthy
  startup, where Claude Code creates its session's project folder very early —
  before any model output — not at the end of a slow turn. 15 seconds is a
  conservative multiple of ordinary process-startup overhead observed in this
  investigation. The value is a single named constant so it can be tuned later from
  one place without a design change, and the existing `timeout` / `late-read`
  telemetry events on this class already make its behavior observable in production
  if 15 seconds turns out to be wrong in either direction.

- New private field: `submitStartedAt: number | null = null`, set to `Date.now()` at
  the point `submit()` (line ~141) and `launchStructured()` (line ~200) start their
  child process, cleared on `kill()`.

- In `readNew()`'s catch branch (currently lines 265-282): after the existing
  "warn once" logic, add a second, independent check that does not depend on
  whether the warn already fired: if `this.hasSubmitted`, and
  `this.submitStartedAt !== null`, and
  `Date.now() - this.submitStartedAt > TRANSCRIPT_DIR_GRACE_MS`, and the transcript's
  parent folder (the project directory returned by `transcriptGlobDir`, i.e.
  `dirname(this.transcriptPathValue)`, not the specific session file) does not exist
  on disk — throw `CliTranscriptLocationMismatchError` naming the expected folder,
  instead of returning the normal empty-miss result. A plain miss where only the
  specific session file is not yet readable, but the parent project folder already
  exists, is NOT a mismatch (that folder can be shared/reused across calls for the
  same service — see the "known limitation" note below) and keeps returning the
  existing empty result as it does today.

- Update the `CliChatEngine.readNew()` doc comment in
  `packages/chat/src/live/types.ts` (lines 117-120) to note it may now reject with
  `CliTranscriptLocationMismatchError` when the app and the model program disagree
  about the transcript's folder.

- No change needed in `cli-structured-adapter.ts`'s `run()` loop (lines 358-377) or
  `generateOneShotStructured`'s `Promise.race` (line 162): today `readNew()` never
  throws, so this is a new rejection type flowing through existing `try`/`catch`
  paths that already handle it generically as an error. The one addition: in the
  `catch` block of `generateOneShotStructured` (line 165 onward) and in
  `run()`'s caller context, when the caught error is a
  `CliTranscriptLocationMismatchError`, do not attempt the late-read fallback (there
  is nothing useful to read) — check `instanceof CliTranscriptLocationMismatchError`
  before the existing `activeEngine.readNew(0)` late-read call and rethrow directly
  if so, so the operator-facing error message stays specific instead of being
  swallowed into a generic "no reply" message.

- Known limitation, recorded here rather than silently assumed: the one-shot
  structured path reuses one fixed working directory per calling service
  (`STRUCTURED_ONE_SHOT_ROOT` / `oneShotStructuredDir()`,
  `cli-structured-adapter.ts` lines 27-31), so the transcript's parent project
  folder is the same path across every call for that service. Once it exists
  correctly (proved by any past successful call), this check cannot re-detect a
  fresh mismatch on a later call under the same service and config — it is a
  first-bad-call detector, not a per-call guarantee. Combined with Task 3 (removing
  the source of environment drift between calls), this is judged sufficient: the
  scenario Task 2 targets is "this deployment's app and model program have never
  agreed," which is exactly what production is hitting today.

### Task 3 — pass the home folder explicitly into all four spawns

- `packages/chat/src/live/claude-print-chat-engine.ts`:
  - `submit()`, spawn at line 141: add
    `env: { ...buildSanitizedCliEnv(process.env), HOME: this.homeBase }` — only if
    `this.homeBase` is defined; when it is `undefined`, keep today's inherited-env
    behavior unchanged (do not regress the case where no explicit home folder was
    ever configured for this engine).
  - `launchStructured()`, spawn at line 200: same pattern, using `opts.homeBase`.
- `packages/chat/src/live/claude-persistent-runtime.ts`, default `spawnChild`
  factory (lines 76-83): thread `homeBase` through. Since the factory is created in
  the constructor before `launch()` provides `opts.homeBase`, change the default
  factory from a fixed closure to one that reads `this.launchOpts?.homeBase` at call
  time (the factory already receives `cwd` per-call as an argument; add `env` built
  the same way, reading the home folder from whichever `PersistentLaunchOpts` is
  active for that call).
- `packages/chat/src/live/codex-persistent-runtime.ts`, default `spawnChild` factory
  (lines 105-112): same pattern as above, reading `homeBase` from the active
  `PersistentLaunchOpts` at call time.
- `packages/chat/src/live/gemini-print-chat-engine.ts`, spawn at line 113: add
  `env: { ...buildSanitizedCliEnv(process.env), HOME: this.homeBase }`, same
  "only if defined" guard.
- Import `buildSanitizedCliEnv` from `@moss/cli-runner`'s existing public export
  (confirm the package's barrel already exports it — `terminal-session.ts` imports
  it via a relative path within the same package, so a new cross-package export may
  be needed; check `packages/cli-runner/src/index.ts` during implementation and add
  the export there if missing, in the same task, not a follow-up).
- No compose file changes: `JARVIS_CLI_HOME`/`JARVIS_CLI_HOME_BASE` are already set
  correctly in both dev and prod today; this task only makes the four spawns use the
  value the app already computed instead of letting the child inherit whatever `HOME`
  the parent server process happens to have.

## Kill gate

This whole issue is one phase — there is no phase 2 planned here, so the kill gate is
the live-path proof itself: if, after all three tasks land and are proven on the
development instance, a background job (sports or news) still cannot get a real
answer, or the "loud and fast" failure from Task 2 does not actually fire faster than
120 seconds when deliberately triggered, the coordinator is the one who decides
whether to reopen investigation into the "why is the model program slow" question
that this plan deliberately left out of scope. I do not decide that unilaterally.

## Test plan (per task, run and observed passing, not just written)

- Task 1: unit test on `CliStructuredAdapter.generateOneShotStructured` using a fake
  `CliChatEngine` whose `kill()` takes an observable, artificial delay (e.g. resolves
  after 50ms) and whose `readNew()` returns a reply only once `kill()` has resolved.
  Assert that when the engine never completes before `timeoutMs`, the returned
  `late-read` reply is still recovered (proves the read genuinely waits for kill to
  finish, not just that a kill was called). A second case: `readNew()` returns no
  reply even after `kill()` resolves — assert the adapter throws
  `CliChatUnavailableError`, not a hang. Run: `pnpm --filter @moss/chat test -- cli-structured-adapter` (or the project's actual per-package test command, confirmed at implementation time), expect exit 0.
- Task 2: unit test on `ClaudePrintChatEngine.readNew()` with a fake `io` whose
  `readFile` always rejects (ENOENT) and a fake filesystem stat/exists check that
  reports the parent folder missing. Assert: within the grace period, `readNew()`
  still returns the normal empty-miss shape (no throw); past the grace period, it
  throws `CliTranscriptLocationMismatchError` naming the expected path. A second
  test: parent folder exists, only the specific file is missing — assert no throw,
  ever (this is the ordinary "still writing" case). Run:
  `pnpm --filter @moss/chat test -- claude-print-chat-engine`, expect exit 0.
- Task 3: unit test asserting each of the four spawn call sites is invoked (via a
  fake/mocked `child_process.spawn` or the existing `spawnChild` injection points
  already used by the persistent runtimes) with an `env` object whose `HOME` equals
  the `homeBase` passed into that engine, when `homeBase` is defined. Run the same
  per-package test commands as above, expect exit 0.
- Live-path e2e (all three tasks together, development instance only, never port
  1533): trigger a real background job (sports classification, or news) on
  http://192.168.50.36:5173 and confirm it returns a real, non-empty answer within a
  reasonable time — not silently sitting at 120+ seconds, and sports's ranking step
  no longer reports "degraded." This is the proof posted on the pull request per the
  live-path gate; recorded as command output plus a screenshot, not narrated only.

## Verification commands (unpiped, expected exit codes)

```bash
pnpm format:check > /tmp/2348-format.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
pnpm lint > /tmp/2348-lint.log 2>&1; echo "EXIT=$?"              # expect EXIT=0
pnpm typecheck > /tmp/2348-typecheck.log 2>&1; echo "EXIT=$?"    # expect EXIT=0
```

Full gate (`pnpm verify:foundation`) only via the `verify-gate` skill, never piped,
never run directly.

## Open questions

- Whether `packages/cli-runner/src/index.ts` already exports `buildSanitizedCliEnv`
  for cross-package use, or whether Task 3 needs to add that export. Owner: me,
  during implementation of Task 3 — this is a five-minute check, not a design
  decision, so it is not blocking plan approval.
