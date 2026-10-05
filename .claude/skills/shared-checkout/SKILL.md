---
name: shared-checkout
description: Safety rules for the shared ~/Jarv1s working tree, which several agent sessions edit at once. Use BEFORE any git commit in the main checkout, and before any tree-wide git action — checkout, stash, reset, branch switch.
---

# Working in the shared checkout

Several agent sessions may share this working tree at once. Every git action here can sweep up or
destroy another session's in-flight work.

## Before any tree-wide action

Check `herdr pane list` and send a heads-up with the `herdr-pane-message` skill. Never
`git checkout` / `stash` / `reset` this tree while another session's build is mid-run — use a
separate worktree for anything that needs a different branch state.

## Committing

**Never `git add -A` / `git add .`, and never bare-`git commit`** — both sweep up whatever another
session has staged. Commit with explicit paths: `git commit <paths> -m "…"`.

That is necessary but not sufficient, and the gap has bitten repeatedly: `git commit <path>`
ignores the index and commits the **whole current content** of that path, so on a file two sessions
are both editing it carries their unfinished work under your message. There is no git-only safe
form. For a co-edited file:

1. Before committing, `git diff` the file and read the added lines — every one of them must be
   yours.
2. Commit by explicit path.
3. Afterwards, run `git show --name-only HEAD` and confirm the file list is exactly what you meant.

Search Hindsight memory for the shared-index commit sweep before doing anything clever here.
