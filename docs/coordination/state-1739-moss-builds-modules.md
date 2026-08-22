# Live state: Moss builds modules on Moss (#1739)

Updated 2026-08-19. Pointer doc, not a transcript. Read the spec for detail.

## Where everything is

- Spec: `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md` on branch
  `spec/1739-moss-builds-modules`, worktree `.claude/worktrees/1739-spec`.
- PR #1743, auto-merge armed, waiting on checks. Task issue #1739 (board 2, Ready). Map #1738.
- Mockups: `docs/superpowers/specs/assets/2026-08-19-moss-workshop/`. The Workshop screen is
  approved. `approval.html` is SUPERSEDED - do not build it.

## Decided by Ben, 2026-08-19

- Approve the plan up front; the finished draft runs immediately for its author alone; the admin
  judges and refines the running thing; shipping is a human action.
- No self-operation rule loosens. Moss never ships its own work. Moss never handles a module's key.
  New chat tools are fine, no cap.
- How much Moss stops to ask reuses the existing three-part YOLO setting (Moss cannot turn it on for
  itself, which is why this is safe).
- Build agent may use the internet. Mitigation is a record of what it fetched, not a block.
- Source lives in its own per-module directory outside the scanned modules directory. Builds happen
  there. Refining is change-rebuild-reinstall, never an in-place edit of an installed folder.
- Staged delivery: (1) draft with a page + background work, no new tables, no chat tools - this is
  the Good Mythical Morning example; (2) chat tools; (3) own tables. Storage out of stage 1, agreed.
- Removing a blocker is in scope: "even if something TODAY blocks us, we then remove that blocker as
  part of this work."

## Still open

- The replacement for the rejected approval screen has not been designed. Needs: the plan-approval
  moment, and the running draft with a way to ask for changes. Next design task.
- Ben's earlier steer stands: too many cards is a smell; only the thing needing a decision is a card.
  The ~920px column on the Workshop is correct and reviewed.

## Two verified findings that drive the design

Both grounded in code, not docs.

1. An installed module folder has no source (publishing strips it) and is hashed at enable time, so
   editing it in place disables it. Hence the separate source directory, and drafts must be exempt
   from drift detection.
2. Running a module without a restart is much cheaper than documented: module workers are already
   separate processes spawned on demand, per-module queue/cron registration is already live, and
   pages and their files are already per request. Only four things block a live draft, all named in
   the spec's "A draft runs live" section with file references.

## House rule to carry into every spawn prompt and handoff

Plain English. Ben reads status to know whether the work is going well, not to review code. Name
things by what they do, not what the repo calls them. Keep exact names only where he must act on
them. If a sentence has more than one backtick, say it again without them. No coined shorthand.
Plain ASCII punctuation. This applies to every agent you spawn, and must be passed on.

## 2026-08-19 (later) — spec delivered, stage 1 queued

- Spec PR #1743 merged. Failed once on `prettier --check` in the docs gate; formatting-only fix,
  re-rendered all three mockups at 390px before and after to confirm nothing moved.
- Mobile: `draft.html` had no narrow-screen rule, so the fixed 360px drawer column squeezed the page
  to a sliver. Added a max-width:900px block. **Ben's ruling: on a phone the real chat stays the app's
  normal pop-up drawer over the page — the stacked layout is a limitation of a static mockup and must
  not be copied.** Recorded in the mockup README.
- Corrected a stale note in that README: the width ruling had been written down as "about 1240px",
  which came from misreading Ben's gutters comment. The workshop at ~920px is what he approved.
- Stage 1 build issues created and on board 2: #1752 rescan after boot, #1753 author-only drafts,
  #1754 the build agent, #1755 the Workshop page, #1756 the two chat moments.
- #1739 closed as delivered. Stages 2 and 3 are in the spec, not yet broken out.
