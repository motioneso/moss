# Relay 5 continuation — issue #1752, module discovery holder

## Where things stand

Branch/worktree: `1752-module-discovery-holder`, this same worktree. Tree is clean, nothing
uncommitted. `node_modules` already present — do not run `pnpm install`.

Task 1 and Task 2 (the live discovery holder itself, and wiring it into the worker process) are
done and committed from earlier relays.

Task 3 (the rescan action, end to end) is done and committed this relay:
- `9fc3e8d7b` — widened the pg-boss job payload type so a "rescan" action (no module id) is valid
  alongside the existing per-module "reconcile" action.
- `394a9118f` — the rest: the admin-only route that triggers a rescan
  (`POST /api/admin/modules/rescan` in `packages/settings/src/routes-modules.ts`), the worker
  handling the new action (`apps/worker/src/worker.ts`), and fixing three places that had been
  reading the discovery list as a plain array instead of calling the getter function (so they'd
  never have seen a fresh rescan): `routes-modules.ts`, `routes-module-registry.ts`,
  `routes-module-credentials.ts`. Also switched the composition root in `apps/api/src/server.ts`
  to pass the live getter instead of a called-once snapshot.
- The plan for Task 3, with the seams check and the decisions that were approved, is at
  `docs/superpowers/plans/2026-08-20-1752-task3-rescan-action.md`.
- Verified: full workspace type check clean, the touched packages' type check clean, lint on all
  touched files clean, the new unit test (6 of 6 cases) passing, and the one affected database
  test file run through an isolated gate database (27 of 27 passing).

The coordinator approved the Task 3 plan as written, including a third stale call site I found
beyond what the previous relay's doc had named, and confirmed Task 4 should be planned separately.
Relayed to the coordinator (label "Coordinator", confirmed as the only pane with that label) that
Task 3 was done and this relay was starting; no reply needed.

## Task 4 — what's left

The end-to-end proof: a module dropped into the modules folder on disk, while both the web server
and the background worker are already running, becomes visible after a rescan — with no process
restart. This is the last piece of #1752.

No plan document exists yet for Task 4. No code has been written for it. Use the `plan-build`
skill (seams check with exact file and line citations, then decisions only — no code bodies) same
as Task 3's plan, then message the coordinator and stop and wait for approval before writing any
code, per `coordinated-build`.

### Open question to resolve in the seams check

Whether the end-to-end test needs to start a real worker process in the test, or can prove the
worker side indirectly.

What I found so far, not yet a conclusion:
- `tests/integration/external-modules-routes.test.ts` is the established pattern for this kind of
  test: boots a real API server, points it at a temporary modules folder with a hand-written
  module description file, signs up an admin user and a normal user through the real login flow,
  drives everything by calling the server directly (not over the network), and checks what landed
  in the job queue table directly in the database. That file is a good model to copy from.
- `tests/integration/worker-lifecycle.test.ts` has an explicit comment saying the existing tests
  deliberately do not start the full worker program — they test the worker's internal logic
  directly instead.
- `apps/worker/src/worker.ts` exports a function called `buildWorker` that starts a full worker
  process and returns a handle to it — so starting a real worker in a test is possible if that
  turns out to be the right call.
- `tests/integration/module-distribution.e2e.test.ts` has old comments and a restart helper based
  on the outdated assumption that a rescan requires restarting the process. Per the earlier
  handoff doc, this file should be left alone unless Task 4's changes directly conflict with it —
  it is not owned by this task.

Recommendation to weigh in the plan: proving the worker side truly picks up a rescan without a
restart is the whole point of Task 4, so the safer choice is probably to start a real worker with
`buildWorker` in the new test, even though it's heavier than the existing convention. If the plan
goes the lighter route instead (asserting only that the right message was put on the queue, the
way `external-modules-routes.test.ts` does), that's a real design choice and should be flagged to
the coordinator explicitly rather than assumed, since it would mean the "no restart needed" claim
is proven by inference rather than directly.

## After Task 4 is green

Invoke `coordinated-wrap-up`: run the full local gate on an isolated gate database (see the
`verify-gate` skill — never run it unscoped, it can hit the live dev database), push, open a pull
request referencing #1752, and note in the pull request that issues #1753 and #1754 depend on this
holder's API (the functions `createExternalModuleDiscoveryHolder`, `getDiscoveries`, `rescan`)
landing first, so don't rename any of those without flagging the coordinator first.

The live end-to-end proof-on-a-running-instance gate (the one that requires exercising a feature
through the real screen on a live server) does not apply here — this is backend-only, there is no
new screen. Already confirmed with the coordinator two relays back.

## Ground rules (carry into every message and every doc from here on)

- Plain English in all status updates, escalations, and any spawned-agent prompts. Say what
  something does, not what the repo calls it. Exact names are fine only when they're something
  someone needs to act on directly: a command to run, a file to open, an error message to search
  for.
- Work only in this worktree and branch. `git add` by explicit file path only, never a bare add of
  everything. Never touch the coordination folder, the project board, or merge anything.
- No secrets anywhere.
- Relay again the instant the context meter's 70 percent warning appears, or the instant a
  compaction summary shows up in your own context — message the coordinator first, then use the
  relay skill immediately, no delay.
- Re-resolve the coordinator's pane fresh with `herdr pane list` before every message to it. Never
  trust a pane number written in a doc — those numbers shift constantly. Confirm exactly one pane
  carries the "Coordinator" label before sending anything.
- Do not rename `getDiscoveries` or `rescan` without flagging the coordinator first — #1753 and
  #1754 will build against this holder's API.
