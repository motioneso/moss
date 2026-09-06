# Handoff: tools-folder fix (issue 2340), relay 1

Plan (approved by the coordinator): `docs/superpowers/plans/2026-09-06-tools-folder-default.md`
Worktree/branch: `/home/ben/Jarv1s/.claude/worktrees/tools-folder`, `work/tools-folder`
Coordinator: agent name `coordinator` (confirm with `herdr agent list` before messaging).

## What is fixed and committed already

Commit `d88e43c52` on `work/tools-folder`:
- New file `packages/cli-runner/src/tools-prefix.ts` — exports `MANAGED_TOOLS_PREFIX`
  (`~/.jarvis/cli-tools`), `MACHINE_TOOLS_PREFIX` (`/data/cli-tools`), and
  `resolveDefaultToolsPrefix(managed?, machine?)`: checks managed folder's `bin` first, then
  machine folder's `bin`, else defaults to managed. Both params are overridable for tests only.
- `packages/cli-runner/src/main.ts` wired: `DEFAULT_TOOLS_PREFIX` constant removed, the
  `toolsPrefix` default in `readConfig` now calls `resolveDefaultToolsPrefix()`.

## What is left (plan sections: Task 3, Task 4, Tests, Verification)

Read `docs/superpowers/plans/2026-09-06-tools-folder-default.md` sections "Task 3", "Task 4",
"Tests", and "Verification" only — do not re-read Task 1/2 or the Problem section, already done.

1. **Task 3** — `packages/cli-runner/src/install-service.ts`: remove its own
   `DEFAULT_TOOLS_PREFIX = "/data/cli-tools"` constant (currently ~line 132) and its use at
   `this.toolsPrefix = deps.toolsPrefix ?? DEFAULT_TOOLS_PREFIX;` (~line 162), replacing with
   `resolveDefaultToolsPrefix()` (import from `./tools-prefix.js`).
2. **Task 4** — add `async ensureToolsPrefixWritable(): Promise<void>` to `InstallService` that
   does `mkdir(this.toolsPrefix, { recursive: true })` and on failure throws a plain `Error`
   naming the exact folder: `` `could not create the tools folder at ${this.toolsPrefix}: ${(cause as Error).message}` ``.
   Call it once from `createCliRunner` in `main.ts`, right after constructing `installService`,
   before `server.start()`; log success/failure through the existing `log()` callback; do not let
   a failure here crash the process (providers already installed elsewhere may still work).
3. **Tests** (new file `tests/unit/cli-runner-tools-prefix.test.ts`): three cases for
   `resolveDefaultToolsPrefix` using real `mkdtemp` temp dirs passed as the `managed`/`machine`
   overrides (no dir → managed path wins; machine `bin` exists only → machine wins; managed `bin`
   exists → managed wins regardless of machine). Add one regression case in
   `tests/unit/cli-runner-install.test.ts`: construct `InstallService` with no `toolsPrefix`
   override and assert it equals `resolveDefaultToolsPrefix()`.
4. **Verification** — run (both unpiped, check exit code):
   `pnpm --filter @moss/cli-runner typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"` (expect 0)
   `pnpm vitest run tests/unit/cli-runner-tools-prefix.test.ts tests/unit/cli-runner-install.test.ts tests/unit/cli-runner-main-persistent-pool.test.ts > /tmp/vt.log 2>&1; echo "EXIT=$?"` (expect 0)
5. Commit each task separately (task 3+4 can be one commit if done together; tests can be their
   own commit or combined — your call).
6. Then **coordinated-wrap-up**: pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`),
   fresh rebase on `origin/main`, full gate via the `verify-gate` skill (never run it unscoped or
   piped), push, open PR. Fill in the release note section (this is user-facing: a fresh account
   now gets working chat tools without a hand-edited settings file — Category: Fixed). Update the
   app-map only if it turns out something there references the tools setup — it should not, this
   is a backend default with no UI change, but check `packages/shared/src/app-map-core.ts` isn't
   accidentally stale on this topic before assuming so.
7. **Live-path note**: no UI surface. Live proof = restart `pnpm dev:api` with
   `JARVIS_CLI_TOOLS_PREFIX` unset and confirm in the server log the resolved prefix is
   `~/.jarvis/cli-tools`, not `/data/cli-tools`, and a provider install/presence check against it
   works. Paste that log line into the PR as the evidence.

## Standing conditions from the coordinator (already satisfied by this design — do not reopen)

- No new setting was introduced; the fix is a code-level default plus a fallback check. If Task 3
  or 4 tempts you to add an env var or settings-file requirement, stop and escalate instead —
  the coordinator was explicit that no new feature may need a hand-edited settings file, and any
  new setting would need to land in both dev and prod deployment config in this same PR.
- Never run `pnpm verify:foundation` or any DB-touching test without the `verify-gate` skill.
- Never pipe a gate/verification command.
- This is relay 1. If your own relay trigger (context-meter 70% warning, or a compaction summary
  in your context) fires before you have an open PR, do NOT relay again — push what is green,
  update this doc, and report to the coordinator that the slice needs re-scoping into smaller
  lanes instead.
