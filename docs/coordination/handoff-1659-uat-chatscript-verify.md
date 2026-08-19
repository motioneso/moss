# Build Handoff — #1659 defect 4: give the UAT scripted provider its own PATH entry

**Spec:** none filed under `docs/superpowers/specs/` — bounded test-harness fix, not a new
feature. **Authoritative scope is GitHub issue #1659's "defect 4" discussion** (read it with
`gh issue view 1659`). The issue's original three asks (re-run/strengthen the `1533-*` UAT specs,
add a loud-failure marker) are **already DONE on `main`** via PR #1660 (merged commit
`58e21985e`) — do not redo them. This lane exists for the one remaining thing: **defect 4**.

**GitHub issue:** #1659 (still open, held on defect 4 only).
**Risk tier:** `routine` — test-harness/UAT-infra only, no shared-table migration, no auth/RLS
surface, no production code path. Standard QA (CI gate + `/code-review` + exit-criteria);
auto-merge after green. No live-path proof needed (this touches no user-facing feature or UI —
test infra only).
**Worktree:** `~/Jarv1s/.claude/worktrees/fix-1659-uat-chatscript`
**Branch:** `fix-1659-uat-chatscript` (currently based on current `origin/main`, already carries
PR #1660's fix — confirmed: `tests/uat/provisioner.ts`'s `writeUatEnvFile` already threads
`chatScript`, and `git merge-base --is-ancestor 58e21985e HEAD` succeeds here. Rebase onto fresh
`origin/main` at build start regardless, in case anything landed since.)
**Build skill path (absolute):** `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`.
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; verify `herdr pane list`
shows EXACTLY ONE pane with this label before messaging, resolved fresh each time.
**Coordinator session id:** `c75d1c12-c071-49d3-be03-01dfa810a8b0` (pane `w1:pFC` at handoff
time — pane numbers reflow, resolve fresh by label + session id).
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## The bug (defect 4), precisely

`tests/uat/provisioner.ts` (~line 700-703): when a spec sets `opts.chatScript`, the provisioner
points the **entire** `JARVIS_CLI_TOOLS_PREFIX` env var at the scripted-provider fixture
directory:

```ts
if (opts?.chatScript) {
  process.env.JARVIS_CLI_TOOLS_PREFIX = "/app/tests/uat/fixtures/scripted-provider";
}
```

That is the *same* env var `packages/cli-runner/src/install-service.ts` uses as its
`this.toolsPrefix` for real CLI-tool installs. On every UAT container boot,
`CliChatEngineHost.startupSweep()` calls `reconcileInstalledProviders()` (install-service.ts
~line 677), which — for any provider already marked installed — calls `installProvider()` →
`ensureBinSymlink()` (~line 698), which atomically (re)points
`${JARVIS_CLI_TOOLS_PREFIX}/bin/claude` at the **real** Claude CLI release. Because
`JARVIS_CLI_TOOLS_PREFIX` has been redirected to the fixture dir, this is the *exact same path* as
the scripted fixture's own binary (`tests/uat/fixtures/scripted-provider/bin/claude`) — so the
installer's routine boot-time drift-reconcile silently clobbers the scripted stub with the real
CLI. Net effect: **every scripted-chat UAT run has actually been driving the real `claude` CLI,
not the fixture** — regardless of the #1660 env-conduit fix, which only fixed how `chatScript` is
threaded through, not this collision. No scripted UAT chat turn has ever exercised the tool-call
path for real.

Two directions were discussed on the issue; **take direction (b)**, per the prior coordinator
take's assessment (smaller blast radius, no production reconcile-logic touched, consistent with
#1660's precedent):

- ~~(a) gate the boot reconcile behind an explicit UAT-only flag~~ — touches production
  `install-service.ts` reconcile logic, even if inert outside UAT. **Not this lane.**
- **(b) give the scripted provider its own PATH entry the installer doesn't own.** Stop making
  `JARVIS_CLI_TOOLS_PREFIX` point at the fixture directory at all — leave it as whatever the
  normal UAT container default is, so the installer's boot reconcile keeps managing its own real
  `bin/` directory undisturbed. Instead, get the fixture's `bin/claude` onto `PATH` some other way
  the installer never touches — e.g. prepend the fixture's `tests/uat/fixtures/scripted-provider/
  bin` directory to `PATH` directly (a separate env var / compose setting the installer has no
  reason to read), rather than routing it through `JARVIS_CLI_TOOLS_PREFIX`.

You will need to trace how `PATH` is actually assembled for the UAT container (compose service
env, or wherever `provisioner.ts` builds the env block around line 246/338/361) to find the right
seam — read that code before designing the fix; this handoff describes the bug, not the exact
patch shape. Use `plan-build` to work out the concrete approach and get coordinator sign-off
before implementing.

## What "done" looks like

1. A scripted UAT chat turn (one of the `1533-*` specs, or a new minimal one if needed) proves,
   via direct evidence, that the **scripted binary actually ran** even across a full container
   boot cycle (i.e., after `reconcileInstalledProviders()` has run) — not just that the test
   passed. Look for the scripted provider's own log/marker (see `tests/uat/fixtures/
   scripted-provider/claude-main.ts` and its `FAILURE_LOG_PATH` sibling success-path signal, or
   add an equivalent success marker if one doesn't exist) plus `app.moss_action_audit_log` rows /
   transcript JSONL tool-call records — the same real-tool-call bar #1660 already established for
   its three asks.
2. The real installer path (non-chatScript UAT runs, and prod) is unaffected — confirm
   `reconcileInstalledProviders()` still reconciles the real toolsPrefix normally when
   `chatScript` is not set.
3. Full gate green on an isolated gate DB (`coordinated-wrap-up` step 2).
4. PR open, rebased on `origin/main`, closes #1659.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read issue #1659's defect-4 discussion in full (`gh issue view 1659 --comments`).
3. Read `tests/uat/provisioner.ts` around the `chatScript`/`JARVIS_CLI_TOOLS_PREFIX` handling
   (search for both terms) and `packages/cli-runner/src/install-service.ts`'s
   `reconcileInstalledProviders`/`ensureBinSymlink` (search for both terms) — both files in full
   context, not just the excerpts above.
4. Invoke **`coordinated-build`**: plan with **`plan-build`** (a short plan is fine given the
   bounded scope, but it still needs the coordinator's plan approval before code) → TDD build →
   **`coordinated-wrap-up`** (PR + report).
5. Once done and CI is green, open the PR against `#1659`, report to the coordinator, and stop —
   do not go looking for more #1659-adjacent work.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- Do not touch PR #1654 or its branch — separate lane, already reported done from its side, held
  pending this one.
- Do not touch production `install-service.ts` reconcile logic (direction (a)) — that is
  explicitly out of scope for this lane.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- No known file overlap with any other active lane (Group A / PR #1654 is parked, not touching
  this worktree or these files).
- This is the sole remaining blocker on #1659, which is itself the blocker for PR #1654's
  live-path finding 3, which is itself the blocker for issue #1586 starting.
