# Job Search — keyline restructure handoff (2026-07-28)

Pointer doc. Read the linked files rather than trusting any summary here.

## Where to start

- Branch `feat/job-search` in `~/Jarv1s/.claude/worktrees/job-search`. HEAD is `22e0b397`.
- Plan: `docs/superpowers/plans/2026-07-28-job-search-keyline-restructure.md` — contracts,
  invariants, the rulings ledger, and tasks K1–K6. **Task numbering is frozen; never renumber.**
- Epic is #1280. Ben's standing instruction for this run: _"You don't need to file anything, we are
  already working from this issue. Just keep looping until you have this working perfectly, as in a
  human could go e2e on it."_

## State

Two commits carry the whole restructure:

- `878f2c2d` — K1–K5: keyline primitives, Matches rows, Overview tab, Profile tab, four-tab shell.
- `22e0b397` — K6/K7/K8: `job-search.profile.get` + real criteria on Profile, Monitors rebuild,
  module masthead.

Verified by me, not taken on agent report: `pnpm typecheck` EXIT=0; all job-search suites EXIT=0
(33 files, 373 tests); `grep -c 'var(--' external-modules/job-search/src/web/styles.css` = **0**
(module CSS is layout-only by contract — this must stay 0); no `Intl.`/`toLocale*` outside
explanatory comments.

**Deployed to dev and confirmed live over HTTP.** Ben was given `http://192.168.50.36:5197` and
has not yet reported back. Until he does, the live-path gate is unmet for the UI itself — the
honest status is _deployed, not yet human-verified_.

## Deploy recipe — use the script, do not hand-roll it

```bash
export JARVIS_DEV_EMAIL=ben@ben.com JARVIS_DEV_PASSWORD='…'
scripts/redeploy-external-module.sh job-search
```

`scripts/redeploy-external-module.sh` does the whole sequence and fails loudly instead of leaving
the module half-deployed. **Doing these steps by hand is what makes the module vanish** — see the
next section. Run the script.

What it does, and why each step is not optional:

1. `pnpm build:external:job-search` — changes the package hash.
2. `pnpm db:reconcile` — expect `drifted=1`. That is correct: a changed package hash **disables**
   the module on purpose (`scripts/module-reconcile.ts` phase 7).
3. Restart the API (`touch apps/api/src/server.ts` under `tsx watch`) and **wait for the listening
   PID on 3097 to actually change**. Module discovery is cached at boot, so the enable must land on
   the new process or it captures the stale hash.
4. Re-enable: sign in, then `POST /api/admin/external-modules/job-search` with `{"enabled":true}`.
5. `touch apps/worker/src/worker.ts`.
6. Wait ~8s, then re-read `/api/admin/external-modules` and confirm the module is *still*
   `enabled / active / drifted:false`. The enable's own 200 is not proof.

### Why the module keeps disappearing from the rail

This has bitten more than once, so it gets its own heading.

The failure looks like a clean deploy: every command exits 0, the enable returns
`drifted:false`, and a few minutes later Job Search is simply gone from the left rail with nothing
obviously wrong in any log.

The cause is a race in step 3. `touch apps/api/src/server.ts` triggers a `tsx watch` restart, but
the **old process keeps listening and answering `/health` with a 200 while the new one boots**. So
a health-check poll says "API is up" when it is still the pre-restart process. The enable lands
there, reads the old boot-time discovery cache, stores the **stale** package hash, and cheerfully
reports `drifted:false`. Then the new process finishes booting, compares the stored hash against
what is actually on disk, sees a mismatch, and disables the module with
`disabled_reason = 'package changed since it was enabled'`.

Two rules follow, and the script enforces both:

- **Never gate the enable on `/health`.** Gate it on the listening PID changing
  (`ss -lptnH "sport = :3097"`). A 200 proves something is listening, not that it is the new build.
- **Never trust the enable's own response.** Re-read the admin list after a settle delay. The
  disable happens *after* the enable succeeds, so the only honest check is a later one.

If it has already vanished, `GET /api/admin/external-modules` will show
`status: disabled, drifted: true` with that reason. Re-running the script fixes it.

Ports: API 3097, web 5197, LAN `192.168.50.36`. Login using the development sign-in details (kept outside the repository) (dev only).
Postgres: `docker exec jarv1s-postgres psql -U postgres -d jarv1s` (`psql` is not on PATH).
**`jarv1s-prod-*` containers and the 10.252 subnet are PROD — never touch.**

## Manual tool invocation — the envelope that cost a detour

Route is `POST /api/ai/assistant-tools/:name/invoke` (**not** `/api/assistant/tools/...`), and the
body field is **`input`**, not `arguments`. A wrong field name is silently stripped by the
fast-json-stringify schema and surfaces as a confusing `Missing required field` 400.
`matches.list` also requires an explicit `limit`.

## Open work, ranked

1. **K9 is in flight** (agent `k9-rowmeta`): put `location`, `source`, `postedAt` on the
   `matches.list` wire. Verified live defect — the row keys are exactly
   `id,title,company,state,url,fit,want,outsideFrame`, but `src/web/screens/match-row.tsx` renders a
   meta line from three fields the handler never sends, so it renders empty. Tests passed only
   because fixtures were richer than the wire. Live payload measured at **7,131 chars against a
   ~12,800 budget**, so the headroom is real. See memory `job-search-board-row-payload-budget`.
2. **Fit is null on all 25 rows** because the profile has no résumé (`resume.get` → `{resume:null}`).
   Want scored fine on all 25. This is expected behaviour, not a bug, but it means Ben sees an empty
   Fit column. Decide whether that needs a UI explanation.
3. **Monitors can only show one fact per board.** `job_search_portals` has exactly one observability
   column, `last_ok_at`. The mockup's Schedule / Last checked / Found today have no storage anywhere.
   Filling them needs a migration plus crawl-side writes — a feature, not a UI pass.
4. **The masthead title is visually weak.** `.jds-section-title` is the only display-font heading in
   the shared component layer and nothing in the design system is uppercase display type, so a
   module cannot render the mockup's 40px uppercase title. Fix is one host class. Same seam as
   **#1343** (shared module header template). Ben was asked and has not ruled.
5. **The 16k render cap is misapplied to browser reads.** `MAX_RENDERED_TOOL_RESULT_CHARS` is an LLM
   prompt-budget guard, but module screens hit the same route and pay the tax on data no model ever
   sees. Platform issue, not yet filed.

Lower priority: `JobsMatches.jsx` / `JobsOverview.jsx` / `JobsProfile.jsx` in the Claude Design
project still have not been read — three files returned opaque `<<ccr:…>>` references on every
call across the whole session (`index.html` and `JobsMonitors.jsx` did return real content, so it
is not a size limit). **Subagents have no DesignSync tool** — only the main session does. A fresh
session should retry. Also: sort arrows are `" ▲"`/`" ▼"` string concatenation and want a real
chevron; `MANUAL-TEST.md` and its artifact are stale; `pnpm verify:foundation` has not been run on
this branch (needs an exported fresh gate DB — see memory `gate-db-isolation-mandatory`).

## Standing rules that bit during this run

- Never `git add -A` / `git add .` — a second session shares this tree and
  `.claude/context-meter.log` is not ours. Stage explicit paths; put paths on the `commit` itself.
- Never pipe a verification gate — a `check-gate-pipe.sh` hook blocks it and a pipe reports the
  filter's exit code. Use `cmd > log 2>&1; echo "EXIT=$?"`, then read the log.
- `.tsx` test files are **not** typechecked (#1335). A green `pnpm typecheck` proves nothing about
  them; they must actually run.
- Never claim the contents of a file that came back as a `ccr` reference.
