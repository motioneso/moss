# Run 1834 - the next ten issues

Written 2026-08-22 by the coordinator (pane w1:pKV, agent name `coordinator`,
session `f0d75fbb-74dd-45ab-89fe-b9acbd4fc293`). That session id is the lock: only the
session holding it may merge. Anyone else picking this up must re-check that first.

Ben asked for the next ten issues to be worked through, and said to swap out anything that
gets stuck rather than grind on it. He is asleep; he delegated the sign-off on pull request
1654 to the coordinator, and nothing beyond that.

## What is already running

Pull request 1654 (audit logging truthfulness plus outbound-network safety) is being proved
in a live copy of the app by the agent in pane w1:pKT. It is not part of this run's ten, but
it blocks one of them - see #1511 below.

## The ten, best first

Every one of these has a real, detailed design document that lists the exact files it should
touch. That was checked, not assumed.

| # | Issue | What it actually delivers | Design doc | Risk | Live proof needed? | Waits for |
|---|-------|---------------------------|-----------|------|--------------------|-----------|
| 1 | #1498 | Moves the command palette's leftover styling into the shared kit so it stops drifting | `specs/2026-08-10-css-guard-residue.md` | routine | yes | - |
| 2 | #1529 | Proves a chat instruction really travels the whole way to the tasks module and heals itself when a permission is missing | `specs/2026-08-10-1339-security-review-followups.md` | security | yes | - |
| 3 | #1336 | Stops the job-search board trusting whatever the server sends it without checking the shape first | `specs/2026-08-16-post1632-groupC-nullable-object-output-schema.md` | routine | yes | - |
| 4 | #1499 | Same styling cleanup for the assistant surface | `specs/2026-08-10-css-guard-residue.md` | routine | yes | #1498 |
| 5 | #1500 | Same for shared web forms | `specs/2026-08-10-css-guard-residue.md` | routine | yes | #1499 |
| 6 | #1501 | Same for keylines and background texture | `specs/2026-08-10-css-guard-residue.md` | routine | yes | #1500 |
| 7 | #1502 | Same for the app's global styling | `specs/2026-08-10-css-guard-residue.md` | routine | yes | #1501 |
| 8 | #1503 | Turns on the automatic check that keeps all of the above from regressing | `specs/2026-08-10-css-guard-residue.md` | routine | yes | #1502 |
| 9 | #1530 | Makes a failed permission repair fail safely (closed) rather than letting the action through | `specs/2026-08-10-1339-security-review-followups.md` | security | yes | #1529 merged |
| 10 | #1511 | Checks who you are sharing with actually exists before writing the permission | `specs/2026-08-10-1137-robustness-followups.md` | security | yes | **blocked** - see below |

## What can run at the same time, and what cannot

- **Three can start immediately and in parallel: #1498, #1529, #1336.** They touch different
  parts of the codebase.
- **The styling cleanup is one long chain**: #1498, then #1499, #1500, #1501, #1502, #1503, in
  that order. They all register themselves with the same automatic style checker, so two of them
  at once would collide on the same file. The design doc numbers them in this order for that
  reason.
- **#1529 then #1530**, in that order. The design doc says #1530 needs #1529 merged first.
- **#1511 is blocked and should not be started yet.** Its design doc says it must wait for
  #1246 and for any live tasks-sharing work to clear. #1246 is still open, and pull request 1654
  is touching tasks sharing right now. Starting it would collide.

Because #1511 cannot start, the tenth active slot goes to whichever of #1335, #899 or #1105
is ready when a lane frees up. Prefer #1335 (nothing currently type-checks 54 test files) but
note it changes a shared setting that affects everyone's checks, so it should not run beside
another lane touching the same config.

## Rules every lane in this run is held to

- Plain English in every status message and handoff. Ben reads status to know whether things
  are going well, not to review code. This gets passed on to every agent and every successor.
- Green automated checks do not mean done. Anything a person can see or click needs proof it
  was actually exercised in a live copy of the app, posted on the pull request.
- The two security-tier items (#1529, #1530, and later #1511) get a tougher, deliberately
  adversarial review before they go anywhere.
- No lane touches `docs/coordination/` - that is the coordinator's alone.
- No sweeping `git add` and no repo-wide reformatting in the shared checkout.

## State

| Issue | Lane name | Pane | Branch | Status |
|-------|-----------|------|--------|--------|
| #1498 | - | - | - | not started |
| #1529 | - | - | - | not started |
| #1336 | - | - | - | not started |
| others | - | - | - | queued behind the above |

Merges since the last coordinator handover: 1 (pull request 1831, documentation only).
