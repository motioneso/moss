# Awaiting Ben

Decisions that need Ben and only Ben. Each entry says what is blocked and what the options are.
Remove an entry once he rules and the ruling is recorded where the work lives.

**Protocol (mandatory since 2026-08-05):** no agent idles waiting on Ben without doing BOTH of:

1. Add an entry here — what is blocked, the options, your recommendation.
2. Ping his phone: `needs-ben <your-agent-name> "<one-line question>"` (on PATH box-wide;
   works from any harness — it queues to a Telegram daemon that dedups and rate-limits).

The 2026-08-05 transcript audit found 216 idle hours blocked on Ben, mostly on questions this file
never recorded — an overnight coordinator sat 15h on a question while this file said nothing was
pending. Silent waiting is the failure mode this protocol exists to kill.

The two 2026-07-27 entries that lived here before (the live-path gate, and the voice/STT spec
approval) are both resolved and were removed on main — the live-path gate was adopted and is now a
hard invariant in `CLAUDE.md`, and the voice/STT spec turned out to be already approved and built
(#874), only its status line was stale.

## Sign off #1553 + #1554 specs — Codex review applied (2026-08-10, fable spec session)

Both draft specs went through the Codex sol-high adversarial review you asked for. Verdict was
REVISE on both; I accepted every valid finding and revised both specs in place the same day.
Per-finding dispositions (including the INVALIDs, kept as ledger) are appended to
`docs/coordination/2026-08-10-1553-1554-codex-review.md`.

**Decision needed:** sign off both specs so I can file the task issues and write the plans
(plan-build Gate 0 blocks until then).

- `docs/superpowers/specs/2026-08-10-1553-context-continuity-and-notes-retrieval.md`
- `docs/superpowers/specs/2026-08-10-1554-persistent-provider-chat-runtime.md`

Biggest revisions, in plain terms: the replay window is now precisely defined (last 40 saved
messages / 8k tokens, with exact truncation rules and a decoupled read-only summary); notes
retrieval goes through a new declared public port on the notes module with a fail-closed
credential filter and server-side incognito gating; #1554 now pins down provider-session identity
(always a fresh provider session fed from our DB, never resuming the CLI's own transcript), a
child state model so busy/approval-waiting children can never be reaped, fail-closed MCP
readiness before any turn (kills the silent tool-loss window that caused the leak), and cancel
now guarantees a late Approve can't fire a tool after the child is gone. Nothing you decided in
the grill rounds changed — the review tightened contracts and testability, it didn't reopen
decisions.

**RESOLVED 2026-08-10 (fable spec session):** Ben approved both specs in-session ("specs approved,
thanks!"). Task issues filed: #1556 (#1553 build), #1557 (#1554 build), fast-follows #1558/#1559
(Codex/Gemini adapters), #1248 scoped via comment. Plans in progress per plan-build.

## Incident: jarv1s-postgres crashed, disk full (2026-08-13, #1248 relay9)

Shared dev Postgres container (`jarv1s-postgres`) crashed mid-checkpoint with `No space left on
device`, PANIC'd, and now fails every restart attempt with the same error writing
`base/*/PG_VERSION`. Root disk (`/`) was at 90% (42G free) even before the crash. `docker system
df` shows 45.49GB of build cache and 9.56GB of images marked reclaimable — plausibly the
accumulation of stale `jarvis_gate_*` / UAT images from concurrent fleet gate runs (a pattern
already noted in memory: `dev-box-disk-full-uat-images`).

**Impact:** blocks every DB-touching gate fleet-wide (I was the third gate queued that afternoon,
behind #1585 and #1590, both of which completed fine — I hit this on my own DROP/CREATE). Likely
also blocks live dev instances backed by the same Postgres.

**Decision needed:** what's safe to reclaim on a box this many concurrent sessions depend on.
I have not run `docker system prune` / cache cleanup myself — picking what to delete on shared
infra isn't a call I should make solo, and a wrong guess (e.g. pruning an image another session's
UAT run needs mid-run) compounds the outage. Options as I see them: (a) `docker builder prune`
(45.49GB, pure build cache, safest bet) and see if that alone gets Postgres restarting; (b) also
sweep stale `jarvis_gate_*` databases/images if (a) isn't enough; (c) you handle it directly.
Recommendation: (a) first, cheapest and lowest-risk, likely sufficient given the space needed is
small relative to 45GB reclaimable.

Escalated to the Coordinator (agent `coordluna`) in parallel — this note is the disk-space
decision specifically, which is Ben's per the box-wide protocol, not something the Coordinator can
resolve on its own either.

## Incident: accidentally killed another agent's dev processes (2026-08-11, 1557-p1 e2e-P1 agent)

While cleaning up a broken API restart attempt in my own dedicated e2e-P1 dev instance
(`/tmp/e2ep1-1557`, port 4557, worktree `1557-p1-persistent-adapter`), I ran an overly broad
`pkill -f "src/server.ts"` (and a matching `pkill -f "build-app-map.ts"`) intending to scope it to
my own launcher. `pkill -f` matches the full command line across the entire process table, not
just my own tree, and it killed 7 unrelated, long-running processes that were not mine:

- PIDs 453074, 735559, 919229, 931893, 1156932, 1183671, 2016963
- All running `sh -c "pnpm --dir ../.. build:app-map && tsx watch src/server.ts"`
- Serving ports 3097, 3098, 3099, 3000
- Backed by databases `jarv1s_w6a_base` and `jarv1s_w6a_base2`
- Ages at kill time ranged from ~11.8h to ~124h (~5 days) — these were long-lived dev servers, not
  disposable ones

Best guess on ownership: the worktree `w6a-secure-context` (name/DB naming matches), but I could
not confirm a live owning session — `ListAgents` returned 12 peer sessions with generic names, none
of which self-identified as tied to `w6a-secure-context`. I have not attempted to restart these
processes myself: I don't have the owning session's exact working directory, env vars, or in-flight
state, and guessing risks compounding the damage.

**Decision/help needed:** do you know who (which agent/session) was running the `w6a-secure-context`
dev environment, so they can be notified and restart it themselves? Nothing else for me to do here
beyond disclosure — flagging so it isn't silently absorbed. Lesson already applied going forward:
never use broad `pkill -f <pattern>` on this shared box again — kill by exact, confirmed-mine PID
only.

**RESOLVED 2026-08-16 (direct chat, post1632-queue-2026-08-16 coordinator):** Ben ruled on all
three — "prod confirmed, split is fine, ill follow your rec for 3." (a) PR #1609's prod fix
confirmed held, #1589 Phase 1a resolved. (b) split #1589 Phase 2 into its own new `task` issue —
approved. (c) no admin-bypass-actor exception for #895's ruleset — approved (coordinator's rec).
Full detail in `docs/coordination/post1632-queue-2026-08-16.md` continuation note.

## #1013 / PR #1624 — rebase is not mechanically reconcilable, need A vs B (2026-08-16, post1632-queue coordinator)

Dedicated Opus reconciliation lane (`opus-1013-reconcile-v4`, security tier) finished its analysis.
**Finding:** #1632 (already merged) independently re-implemented #1013's core deliverable on the
production path — merge-tree shows 8 conflicts, 4 of them add/add on duplicated files
(`cluster-ddl-lock.ts` + its tests, `prove-cluster-ddl-lock.ts`, the wiring test). The two locks
also take *different* keys (`moss:cluster-ddl` vs `jarv1s:cluster-ddl`) — shipping both ships two
disjoint locks and zero added serialization, so "merge both" is not a real option.

**#1013 is not dead, though:** #1632 only locked the *production* DDL path. The problem #1013 was
filed to fix is still bare on `main` on the *test* path — `test-database.ts:71` `runSqlFiles`
(bootstrap, spec acceptance site 3, ~100+ resets/gate run) and `:207` `DROP ROLE` (site 6), plus
8 integration suites doing raw role DDL. Main's own wiring test explicitly says membership
grant/revoke is "not a standalone call site" — true for prod, false for the test suite. So spec
acceptance #3 (two-worktree gate proof, zero tuple-update failures) still can't be met without
landing something. #1624's residual value (the test-surface lock) is real; it just can't be lifted
as a mechanical rebase — the callback contract changed (`fn()` → `fn(guardedClient)`),
`runClusterBootstrapSql` doesn't exist on `main`, and the diagnostics event shape changed enough
that the T3 attribution harness needs re-authoring, not patching.

Working tree is untouched (no rebase/stash/reset/commit) — the reconciliation agent stopped and
escalated per the standing kill-gate the moment it hit an unmechanical excursion, exactly as
designed. Fable-verified D1/D2/T1-T3 diff is preserved at
`.claude/patches/1624-d1-d2-t1-t3-fable-verified-at-8bc7cd112.patch` (491 lines). Full write-up
with evidence tables and the API delta: `.claude/findings-1013-reconcile-v4.md` (in worktree
`.claude/worktrees/coord-overnight-20260810/.claude/worktrees/build-1013-ddl-lock`).

**Decision needed — A vs B, both engineering-sound per the reconciliation agent, the choice
between them is process/prioritization:**
- **(A)** Re-scope #1624 to just the test-surface delta on top of #1632's now-merged lock: rebuild
  the ~10 affected files + harness against the new API (new callback signature, new diagnostics
  shape), re-run the P1′ proof. Keeps #1013/#1624 as-is, amends the existing spec.
- **(B)** Close #1624 as superseded-by-#1632; file a new, narrower `task` issue scoped specifically
  to "lock the test-suite DDL surface" (the two named `test-database.ts` sites + the 8 integration
  suites), spec'd fresh against current `main`.
- Option "land #1624's lock instead of #1632's" is **not viable** — #1632 is already merged and
  strictly better on the production path; nothing to gain by unwinding it.

No recommendation between A/B from me — flagging for your call as the process/prioritization
question it is. Coordinator holding the lane, no further action taken pending your ruling.
