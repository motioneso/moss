# Relay — #1659 defect 4 (UAT scripted-provider PATH collision)

**Handoff doc (authoritative scope/bans):** `docs/coordination/handoff-1659-uat-chatscript-verify.md`
— read it in full, it's short by design. This doc is a continuation note, not a replacement.

**Worktree/branch:** `~/Jarv1s/.claude/worktrees/fix-1659-uat-chatscript`, branch
`fix-1659-uat-chatscript`, already based on `origin/main` and already carries PR #1660 (rebase
again at build start regardless, per handoff).

**Coordinator:** herdr agent name `coordinator-take53` (session `c75d1c12-c071-49d3-be03-01dfa810a8b0`).
Resolve fresh by name/label each time — don't reuse a `…-N` pane number from this doc.

**Status: relaying at the context-meter 70% warning. Zero code written, zero commits. This is pure
investigation handoff** — the prior lane spent its budget tracing the bug end-to-end (not in the
handoff doc, which deliberately left the exact seam for the build agent to find) and did not reach
`plan-build`. The coordinator has already been notified of this relay.

## What's confirmed (read the cited files by section, not in full, to re-verify — don't re-derive)

The PATH-resolution chain for a UAT scripted chat turn, precisely:

1. `tests/uat/provisioner.ts:701-712` — when `opts.chatScript` is set, mutates the **host**
   `process.env.JARVIS_CLI_TOOLS_PREFIX` to `/app/tests/uat/fixtures/scripted-provider`, restored
   in `cleanupRunScopedState` (lines 714-727) on every exit path. This is the bug: that env var is
   also the production installer's `toolsPrefix`.
2. `infra/docker-compose.prod.yml:162` — `JARVIS_CLI_TOOLS_PREFIX: ${JARVIS_CLI_TOOLS_PREFIX:-/data/cli-tools}`
   interpolates the mutated host var into the container's env at compose-config time (this is the
   SAME compose file prod uses — no UAT-specific override file).
3. `packages/cli-runner/src/main.ts:102` — cli-runner sidecar reads its own container's
   `JARVIS_CLI_TOOLS_PREFIX` as `toolsPrefix` (`DEFAULT_TOOLS_PREFIX = "/data/cli-tools"` at line 69).
4. `packages/cli-runner/src/install-service.ts:677` `reconcileInstalledProviders()` — runs on every
   container boot (via `CliChatEngineHost.startupSweep()`), and for any provider marked installed,
   `ensureBinSymlink()` (~line 698) atomically (re)points `${toolsPrefix}/bin/claude` at the REAL
   Claude CLI if the existing binary fails a `--version` probe (`isExecutable` gate, line 685).
   Because `toolsPrefix` == the fixture dir when `chatScript` is set, this clobbers the fixture's
   own `bin/claude` with the real CLI on every boot. **Do not touch this file's reconcile logic —
   direction (a) is explicitly banned by the handoff.**
5. `packages/chat/src/live/claude-print-chat-engine.ts:78` — the engine UAT scripted chat turns
   actually use (UAT seeds `chat.persistent_runtime.enabled=false`). Spawns
   `bash -lc "<launch line with bare 'claude'>"`, detached, `stdio:"ignore"`, **no explicit `env:`**
   — inherits the full container `process.env`. `buildCommand` (line 249) invokes bare `"claude"`
   (lines 253, 295) — resolved via `PATH`.
6. `Dockerfile:72` — `bash -lc` is a login shell, so it sources `/etc/profile.d/jarvis-cli-path.sh`,
   which is baked in by this RUN line:
   ```
   RUN printf '%s\n' 'export PATH="${JARVIS_CLI_TOOLS_PREFIX:-/data/cli-tools}/bin:$PATH"' > /etc/profile.d/jarvis-cli-path.sh && chmod 0644 /etc/profile.d/jarvis-cli-path.sh
   ```
   This is the ONLY thing that puts a tools-bin dir on this shell's PATH for chat turns, and it
   reads `JARVIS_CLI_TOOLS_PREFIX` fresh at shell-start (not baked at image-build time).

**Confirmed irrelevant (don't scope-creep into it):** `packages/cli-runner/src/terminal-session.ts:50`
has a separate, unrelated PATH-prepend (`PATH: \`${opts.toolsBinDir}:${process.env.PATH ?? "/usr/bin"}\`
inside a node-pty spawn) for the **interactive terminal panel** only — a different code path from
chat turns. `tests/uat/fixtures/scripted-provider/claude-main.ts`'s header comment currently
(mis)cites this file as the relevant mechanism — needs correcting as part of the fix.

## Fix direction (mandated by handoff — direction (b), not up for renegotiation)

Stop pointing `JARVIS_CLI_TOOLS_PREFIX` at the fixture at all. Give the fixture's `bin/claude` a
PATH entry the installer doesn't own, via a NEW env var, following the codebase's existing
"absent means off, no-op when unset" convention (precedent: `JARVIS_UAT_SEED_CHAT_SCRIPT`,
`JARVIS_RUNTIME_MODE`/`JARVIS_E2E_MODULE_FETCH_BASE`).

**Working design (unverified — the next session must confirm/finalize in `plan-build`, not just
assume):**

- Remove the `process.env.JARVIS_CLI_TOOLS_PREFIX` mutation/restore entirely from
  `tests/uat/provisioner.ts` (lines 701-712 and the restore call site in `cleanupRunScopedState`,
  lines 714-727).
- Add a new env var (name TBD, e.g. `JARVIS_UAT_SCRIPTED_PROVIDER_BIN`) written via
  `writeUatEnvFile`'s existing `env_file:` conduit — copy the exact conditional-write pattern
  already used for `JARVIS_UAT_SEED_CHAT_SCRIPT` at `tests/uat/provisioner.ts:246-248`:
  ```ts
  ...(input.chatScript ? [`JARVIS_UAT_SEED_CHAT_SCRIPT=${input.chatScript}`] : []),
  ```
  This conduit already reaches the container without any compose-YAML interpolation change (unlike
  the buggy host-env-mutation path) — so `infra/docker-compose.prod.yml` likely needs NO change.
  Verify this assumption before finalizing the plan.
- Edit `Dockerfile:72`'s profile.d script to prepend the new var's bin dir ahead of the existing
  `JARVIS_CLI_TOOLS_PREFIX` bin dir, inert when unset. Working hypothesis, NOT verified/tested:
  ```
  export PATH="${JARVIS_UAT_SCRIPTED_PROVIDER_BIN:+$JARVIS_UAT_SCRIPTED_PROVIDER_BIN:}${JARVIS_CLI_TOOLS_PREFIX:-/data/cli-tools}/bin:$PATH"
  ```
  Confirm this shell syntax actually behaves inert-when-unset (test in isolation, e.g. `bash -c`
  locally) before relying on it in the plan.
- Value the new var should carry: the fixture's `bin/` dir specifically, i.e.
  `/app/tests/uat/fixtures/scripted-provider/bin` (matching the current fixture bin path already
  used by the buggy mutation) — confirm this path is still correct by reading the fixture dir
  layout fresh.

## Open questions the plan must resolve (not yet decided)

1. **Exact new env var name** — pick one, confirm no collision with existing vars (grep first).
2. **Dockerfile shell syntax** — verify the `:+`/`:-` parameter-expansion combo actually produces
   the right PATH in both the set and unset cases; write it as an explicit test case in the plan.
3. **Success marker** — does `tests/uat/fixtures/scripted-provider/claude-main.ts` already have a
   success-path log write (a sibling to `FAILURE_LOG_PATH` at line 38,
   `/data/cli-auth/uat-scripted-provider-failures.log`)? **Not yet checked past line 40 of that
   file** — read it fully before planning; if no success marker exists, the plan needs to add one,
   since "done" criterion 1 requires direct evidence the scripted binary ran (not just that the
   test passed).
4. **Regression/proof test** — does re-running an existing `1533-*` UAT spec suffice (since
   `reconcileInstalledProviders()` already runs on every container's first boot, so a normal spec
   run already exercises the post-reconcile path), or does "done" criterion 1's "even across a full
   container boot cycle" language require an explicit mid-test `restartUatStack`-style second boot
   to prove the fix survives a SECOND reconcile too? Decide and state the reasoning in the plan.
5. **`sanitized-env.ts` `ALLOWED_KEYS`** — only relevant if the interactive-terminal/tmux path also
   needs to see the new var. The chat-turn bug (this issue) doesn't go through that allowlist (the
   print-engine's `bash -lc` spawn uses raw inherited `process.env`, not `buildSanitizedCliEnv`).
   Current read: **not needed** for this fix, but confirm before ruling it out entirely.

## Test/doc files the fix will touch (confirmed via grep — likely complete, re-verify with a fresh grep)

- `tests/unit/uat-provisioner.test.ts` — 4 test cases (lines 40-145,
  `describe("provisionForUat setup cleanup")`) assert the save/restore behavior being deleted, e.g.:
  ```ts
  process.env.JARVIS_CLI_TOOLS_PREFIX = "sentinel-original";
  ...
  expect(process.env.JARVIS_CLI_TOOLS_PREFIX).toBe("sentinel-original");
  ```
  These need dropping/rewriting. Everything else in this 400-line file (`cleanupUatAttempt`,
  `generateUatRunId`, port/range helpers, `writeUatEnvFile`, job-search fixture addressing,
  `uatComposeInterpolationEnv`, seed-hook builders, `createUatProvisionPlan`,
  `expectedUatVolumeNames`, `buildSeedHookInput`) is unrelated, don't touch it.
- `tests/unit/prod-compose-cli-tools-prefix.test.ts` (42 lines, read in full) — real
  `docker compose config` resolution test. Test 2 (lines 33-40) and the header comment (lines 1-7)
  have stale language ("the provisioner's scripted-provider path") — update wording for accuracy.
  The underlying default-value compose-interpolation behavior (test 1) stays valid, likely no
  functional change needed here since the fix removes the host-env mutation this test exercises as
  an override case — decide whether test 2 should be deleted or repurposed.
- `tests/uat/fixtures/scripted-provider/claude-main.ts` (read lines 1-40 only so far) — header
  comment (lines 7-15) wrongly cites `terminal-session.ts:50`; needs correcting to describe the
  actual mechanism (profile.d PATH via the new env var). Check past line 40 for an existing success
  marker (open question 3 above).
- `tests/uat/seed/types.ts:64-70` — `SeedOptions.chatScript` doc comment claims the old
  "points JARVIS_CLI_TOOLS_PREFIX at the scripted-provider fixture binary" behavior; update.
- `tests/uat/provisioner.ts:617-619` — `UatProvisionOptions.chatScript` doc comment, same stale
  claim; update.

**NOT to be modified:** `docs/coordination/handoff-1659-uat-chatscript-verify.md` (coordinator-only),
`packages/cli-runner/src/install-service.ts` reconcile logic (direction (a), banned),
`packages/cli-runner/src/terminal-session.ts` (unrelated seam), PR #1654 or its branch.

## Next steps for the successor

1. Skip `pnpm install` (`node_modules` already present in this worktree).
2. Re-verify the spec/bug premises against the current branch tip (per `coordinated-build` step ½)
   — things may have shifted since this doc was written.
3. Resolve the 5 open questions above (grep/read as needed, by section).
4. Run `plan-build`: write `docs/superpowers/plans/2026-08-18-fix-1659-defect4.md` — decisions only
   (exact env var name, exact Dockerfile diff, exact test changes, verification commands with
   unpiped exit codes), no implementation bodies. Name a kill gate.
5. Message `coordinator-take53` (resolve fresh by name — don't trust this doc's session id if it's
   gone stale) with the plan path, **STOP and wait for approval** before writing code.
6. On approval: TDD build, commit per task, pre-push trio (`format:check && lint && typecheck` +
   rebase onto `origin/main`), `coordinated-wrap-up` (isolated-gate-DB gate, push, open PR closing
   #1659, report to coordinator). Risk tier `routine` — no live-path UI proof required (test-infra
   only, stated explicitly in the handoff).

Relay trigger for THIS successor is the same as everyone's: context-meter 70% warning, or seeing a
compaction summary. Don't invent a higher personal threshold — if it fires before any commit lands,
that means over-reading happened; commit whatever's green (even just the plan doc + coordinator
message) and relay again rather than pushing past the warning.
