# #1310 settings-write UI refresh — relay continuation (relay 21)

**Issue:** #1310 · **PR (existing, push here):** #1276
**Branch/worktree:** `1264-settings-self-operation`, this worktree (shared — confirm no other
live session in it via `herdr pane list` before any git op)
**Coordinator label:** `Coordinator` — confirm exactly one pane holds it via `herdr pane list`
before messaging (re-resolve pane id fresh every time, it reflows).
**Plan doc:** `docs/superpowers/plans/2026-07-27-settings-write-ui-refresh.md` (writing-plans
format). Read Task 3 section only for gate/wrap-up.
**Prior handoff:** `docs/superpowers/handoffs/2026-07-27-1264-settings-self-operation-relay-20.md`

## Exit criteria (all must hold before wrap-up)
1. Settings write via chat reflected on screen with no manual refresh. ✅ (frontend + e2e proven)
2. Invalidation mechanism is GENERIC — declaration-driven via `affectsQueryKeys`. ✅ — Coordinator
   personally verified commit `7098f8c0` walks `getBuiltInModuleManifests()`, no theme-special-case.
3. e2e UAT proves it on a real dev instance: chat turn → tool → DOM assertion on user-visible
   words. **NOT satisfied by the mocked-SSE e2e test** (that only proves the frontend wiring).
   **NEW hard invariant landed on main this session (rebase pulled it in):** CLAUDE.md now has a
   "Live-path gate" hard invariant — no UI feature ships on CI-green alone; needs a live proof on
   the PR (see `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate). This is item 9 below — the real
   remaining work.
4. `pnpm verify:foundation` green, real captured exit code — **IN PROGRESS, check first** (below).

## UPDATE — gate was RED, now fixed, rerun in progress (read this first)
The first gate run (`/tmp/cb-vf-relay20b.log`) came back **rc=1**, failing at `check:file-size`
(short-circuits before typecheck/tests — so nothing after it had run since the rebase, no test
evidence existed on this branch). Root cause: `packages/module-sdk/src/index.ts` was 1006 lines
(over the 1000 cap) — the `affectsQueryKeys` type additions pushed it over.

**Fixed, commit `1146a76e`:**
- Split `packages/module-sdk/src/index.ts` — moved the external/downloadable-module ABI (auth/
  storage/web/worker declarations, dataset-connector-SDK types) into a new sibling
  `packages/module-sdk/src/external-module.ts`, re-exported verbatim from `index.ts` (`export {
  type X, ... } from "./external-module.js"` + one internal `import type` for
  `ModuleExternalSourceManifest` which `index.ts` still uses locally). **No consumer import path
  changed** — this is a pure barrel-file split, exported surface identical. `index.ts` is now 758
  lines, `external-module.ts` is 285.
- That split let typecheck run for the first time since the rebase and surfaced a **pre-existing,
  main-branch (commit `73e50847`, already on `origin/main` — NOT introduced by #1310)** bug:
  `packages/sports/src/manifest.ts` and `packages/news/src/manifest.ts` declare
  `sportsModuleManifest`/`newsModuleManifest` as unannotated `const` object literals, so their
  `credential: "none"` field widened to `string` instead of the `ModuleExternalSourceCredential`
  literal union, breaking `createDatasetClient` call sites in `module-registry/src/index.ts`.
  Fixed with `credential: "none" as const` in both files — no behavior change. Do not revert this;
  it was required to get a real green gate, not scope creep to undo.
- `pnpm typecheck` confirmed clean (real captured exit code) after both fixes, before the full
  gate was relaunched.

**Fresh full gate relaunched, DB `jarvis_gate_relay21`, log `/tmp/cb-vf-relay21.log`.** A
background Monitor was watching for `### FINAL` but had not fired by the time I had to relay —
**check this log first, it may already be done**:
```bash
grep '### FINAL' /tmp/cb-vf-relay21.log
```
- If it shows `rc=0`: gate is green, drop the DB (`docker exec jarv1s-postgres psql -U postgres -c
  "DROP DATABASE IF EXISTS jarvis_gate_relay21;"`) and go straight to item 9 (live UAT proof) below.
- If it shows nonzero, or the file has no `### FINAL` line yet and no process is still running
  (check `ps aux | grep verify:foundation`): something else is red — read the log, fix, and rerun
  clean in a **new** DB (don't reuse `jarvis_gate_relay21`, drop and recreate) before trusting any
  result. Do NOT skip straight to item 9 without a real, freshly-captured `rc=0` — that's exactly
  the mistake this correction was about.

## Dev instance (already running, DO NOT spin up a new one)
This lane already has a live dev instance from an earlier relay: **api on :3000 (orphaned to
init), web on :5173 (orphaned to init)**, both serving out of this same worktree. Use these for
item 9's live UAT proof — do not hunt for a new port pair.
- **They are serving pre-fix code** (started before the `1146a76e` split/fix commit) — restart
  both before running the live UAT proof, or the proof will assert against a stale bundle.
- Leave `:3099`/`:5175` alone — those belong to the separate #1311 lane.
- `:1533` is PROD — never target it, for anything.

## Done this session (relay 21, commits `77f21fa6`, `b2a02496`, `203484db`, `1146a76e`)
- Closed a Coordinator-flagged gap: `tests/unit/settings-affects-query-keys.test.ts` used to walk
  only `settingsModuleManifest`. Generalized to `getBuiltInModuleManifests()` from
  `@jarv1s/module-registry` so every built-in module's `affectsQueryKeys` tokens get build-time
  resolvability coverage (epic #1262's future modules included). Commit `77f21fa6`. Coordinator
  independently verified this too.
  - **Residual, deliberately NOT fixed (Coordinator's call, out of scope):** external/downloaded
    modules are NOT build-time checkable — only built-ins. A typo'd token in an external module's
    `affectsQueryKeys` silently invalidates nothing at runtime (the #1310 bug, invisibly). **Must
    state this limitation plainly in the PR #1276 description** at wrap-up (item 10) — do not
    silently omit it.
- Item 5 (e2e test): added `tests/e2e/app-shell.spec.ts` test
  `"chat-driven settings write auto-refreshes theme UI with no reload (#1310)"` — mocks SSE
  `action_result` with `affectsQueryKeys: ["settings.themes"]`, mocks `**/api/me/themes` to flip
  `mode` light→dark on 2nd fetch, asserts `<html data-color-mode>` flips with **no
  `page.reload()`**. All 14 tests in the file pass. Commit `b2a02496`. In-file comment states
  plainly this does NOT satisfy the live-dev-instance exit criterion.
- Item 6 (commit): done as part of the above commit.
- Item 7 (pre-push trio + rebase): `format:check` initially failed on a **pre-existing** (not
  mine, from an earlier commit `4b5cad05`) unformatted plan doc — fixed, commit `203484db`.
  `lint` and `typecheck` both clean. Rebased onto `origin/main` clean (65 commits, no conflicts,
  no package.json/lockfile changes so `node_modules` still valid). Stashed the auto-generated
  `.claude/context-meter.log` before rebase (`git stash push -m "context-meter autogen, not
  mine" -- .claude/context-meter.log`) — **that stash is still sitting there, harmless, ignore
  it or drop it, do not pop it into a commit.**

## In progress when I relayed — CHECK THIS FIRST
Item 8 gate run was launched in the background right before the 70% context warning fired:
```
GATEDB=jarvis_gate_relay20b   (already created)
JARVIS_PGDATABASE=jarvis_gate_relay20b
log: /tmp/cb-vf-relay20b.log
```
Check `grep '### FINAL' /tmp/cb-vf-relay20b.log` first — it may have finished or died while I was
relaying. If it finished green, skip re-running and go straight to item 9. If it's dead/stale or
you can't find the process, **DROP the gate DB and rerun clean** (don't trust a half-scrollback):
```bash
docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS jarvis_gate_relay20b;"
docker exec jarv1s-postgres psql -U postgres -c "CREATE DATABASE jarvis_gate_relay20b;"
export JARVIS_PGDATABASE=jarvis_gate_relay20b
( pnpm verify:foundation > /tmp/cb-vf.log 2>&1; echo "### FINAL verify:foundation rc=$?" >> /tmp/cb-vf.log ) &
wait
grep '### FINAL' /tmp/cb-vf.log
docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS jarvis_gate_relay20b;"
```

## Not started — item 9 is the real remaining work

### 9. Live-path UAT proof — HARD MERGE GATE
Already resolved which UAT specs the current PR diff triggers (ran
`.claude/skills/coordinate/resolve-uat-triggers.sh` against `git diff --name-only
origin/main...HEAD` — re-run fresh, branch moves):
```
blocking  tests/uat/specs/1089-1090-chat-drawer-private.uat.spec.ts
blocking  tests/uat/specs/1133-chat-attachments.uat.spec.ts
blocking  tests/uat/specs/module-install.uat.spec.ts
blocking  tests/uat/specs/real-chat-onboarding.uat.spec.ts
blocking  tests/uat/specs/runtime-context.uat.spec.ts
```
**None of these name #1310's specific feature** (settings write → auto-refresh) — the trigger map
is deliberately incomplete (see its header comment). Per that same comment: **"A diff that
resolves to nothing still owes the live-path gate a live-UI proof comment"** — meaning even after
running the above blocking specs, you STILL separately owe a dedicated live proof of the actual
#1310 feature: a real chat turn against a live dev instance that changes a setting (theme mode)
and the screen updates with no reload, asserted on user-visible words (not query keys/ids per
Coordinator's explicit instruction this session).
- `pnpm test:uat` runner exists (`tests/uat/run-uat.ts`) — check whether it can target a live dev
  instance or needs `tests/uat/provisioner.ts` (`pnpm uat:provision:smoke`) first. Check
  `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate section for the exact expected proof shape
  before improvising.
- Need a **live dev instance** — check `docs/dev-preview-recipe` pattern (memory:
  `dev-preview-recipe.md`) — preview ports :5173/:3000, prod :1533 is off-limits. Ben's dev login:
  `ben@ben.com` / `jarvistest123!` (memory: `dev-instance-lan-spinup-trusted-origins.md`).
- Drive a real browser (not mocked routes) against that instance, do a real chat turn that invokes
  `settings.themeMode.set`, assert before/after DOM state, confirm DOM text/visible state changed with
  no reload.
- Post `gh pr comment` on PR #1276 with the UAT spec run output (if you ran the blocking specs
  above) AND the dedicated #1310 live proof (assertions + description). Without this the PR
  cannot merge per the CLAUDE.md Live-Path Gate invariant, at any risk tier.

### 10. `coordinated-wrap-up`
Push to PR #1276, update PR description with:
- Exit criteria status
- The mocked-SSE-e2e gap statement (item 5's comment, restated)
- **The external-module `affectsQueryKeys` validation limitation** (see "Done this session" above
  — do not forget this, Coordinator explicitly required it be stated)
- Confirmation that item 9's live proof is attached (link the `gh pr comment`)
Report to Coordinator with the live-path proof link. PR/board/merge remain the Coordinator's job —
do not merge.

## Traps carried forward
- `Read` on files edited earlier in the same turn can return a stale-content warning — use
  `grep -n` to re-locate exact current content before further edits.
- Never `git add -A` — this worktree/repo is shared; stage explicit paths only.
- Confirm the Coordinator pane fresh via `herdr pane list` (label `Coordinator`) before every
  message — don't reuse a pane id from this doc; pane numbers reflow.
- There's a harmless stashed `.claude/context-meter.log` entry (`git stash list`) — ignore it,
  don't pop it into any commit.
