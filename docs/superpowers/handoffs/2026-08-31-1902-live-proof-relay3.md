# 1902 live proof — relay 3 continuation

## Where things stand

Pull request 2101 is rebased onto current main (which now includes the root-cause fix, pull
request 2156) and pushed with force-with-lease to the branch `1902-module-tools-live`. The feature
diff was checked before and after the rebase with `git patch-id --stable` and is unchanged. No
feature code was edited this session.

A real browser proof was run against a separate, isolated copy of the app (its own web, API, and
worker processes, its own ports, sharing the normal dev database). Login worked, the chat prompt
was sent, the plan-approval card appeared, and clicking "Build it" started a real module build.

**The build never finished.** The database row for that build stayed at status "building" for the
full 15 minutes the proof script was willing to wait, then the script gave up. The worker's log
for that whole window shows no sign the build job was ever picked up — the only worker activity
during that time was an unrelated background news-compilation job. So the blocker looks like: the
module-build job is not reaching the worker, or the worker is silently not processing it. This is
not something a retry fixes by itself; it needs someone to look at why the worker never picked up
the job.

That row and the isolated instance's empty module-storage folder have been deleted as cleanup.
**One mistake this session: the proof's screenshots and full log file were deleted during cleanup
before being copied anywhere durable.** The text evidence below (the polling log and the worker
log excerpt) was captured in the working session before deletion, but there are no image files to
attach to a pull request comment. If a screenshot-level trail matters, the proof needs to be rerun.

No pull request comment has been posted, because the proof did not pass. Per the task brief, a
failed proof is reported as a blocker, not silently retried.

## Evidence captured (text only — screenshots lost, see above)

Build row: id `7da6c8dd-feb2-4dce-843c-f0ade7156970`, created `2026-08-31 20:15:06 UTC`, still
`status=building` at `2026-08-31 20:31:34 UTC` (over 16 minutes after creation) before it was
deleted as cleanup.

Proof script's own log (polling every 15 seconds for 15 minutes, all identical):
```
[20:14:46.216Z] start marker
[20:14:50.275Z] post-login url: http://localhost:5184/today
[20:14:53.983Z] prompt sent, waiting for plan-approval card
[20:15:17.458Z] clicked Build it, build started
[20:15:32.874Z] poll 1: build 7da6c8dd-... status=building
  ... (60 polls, all status=building) ...
[20:30:23.585Z] poll 60: build 7da6c8dd-... status=building
[20:30:23.869Z] build finished with status: null (build id: 7da6c8dd-...)
```

Worker log for the same window: only one unrelated job ran ("news compilation"); nothing
referencing the module build or its id appears anywhere in the log.

## What is NOT the cause (ruled out this session)

- Not a login problem — login and prompt submission worked, confirmed by URL changes and the
  plan-approval card appearing.
- Not the rebase or the pull request 2156 fix — the feature diff is confirmed byte-for-byte
  unchanged by the rebase.
- Not a stale process — the isolated instance's processes were freshly started for this run
  (verified process start times), and a port-collision near-miss earlier in the session (accidentally
  binding to the shared dev instance's port 5173) was caught and fixed before this run; it did not
  affect this build.

## What's preserved

- All 16 original `drive-1902*.mjs` proof scripts from the sibling worktree
  `1902-module-tools-live` are copied to `/tmp/1902-drive-scripts-preserved/` (outside any
  worktree, safe from cleanup).
- The scratch proof script used this session, `scripts/tmp-1902-proof.mjs`, remains untracked in
  this worktree (`resume-1902`) — do not commit it. It is a working proof driver: logs in, opens
  the workshop chat, sends the build prompt, waits for "Build it", polls the database for the
  build's status, and (if it ever reaches ready) sends a follow-up message to use the new tool in
  the same browser session. It is safe to reuse for the next attempt.

## Next steps for whoever picks this up

1. Read this doc, not the full prior history — it is short by design.
2. Before re-running the proof, find out why the worker didn't process the build job. Suggested
   starting points: check whether the isolated worker process was actually subscribed to whatever
   queue module builds use, and check the API log (not archived this session — capture it fully
   next time) for whether the build request even reached the worker's queue.
2. **Do not restart the shared dev instance's processes.** The dev instance lives at
   `192.168.50.36:5173` / port 3000 and is not this proof's target — a near miss with vite's default
   port happened earlier this session; watch for the same trap.
3. This session's isolated web (port 5184), API (port 3010) and worker processes have already
   been stopped; ports are confirmed clear.
4. When the proof is rerun and it does pass: keep the screenshots — copy the whole log/screenshot
   folder to a location outside `/tmp/1902-proof-logs` (or wherever it's regenerated) BEFORE
   running any cleanup command, then post it as a pull request comment on 2101 with the run output,
   exit state, and the assertions it proved, plus the exact cleanup performed.
5. If it fails again the same way (build stuck, worker log silent), that is enough evidence to
   report a real defect rather than a flaky proof — say so plainly instead of retrying a third time.

## Branch / pull request state

- Worktree: `~/Jarv1s/.claude/worktrees/resume-1902`, branch `resume/1902-live-proof`.
- Pushed to `1902-module-tools-live`, which is pull request 2101 (open, targets main).
- Working tree is clean of feature changes; only this handoff doc and the untracked scratch script
  exist outside committed history.
