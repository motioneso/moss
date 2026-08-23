---
name: wrap-up
description: Close out a Jarv1s work session cleanly and truthfully. Use at the end of a session — especially after building/merging/PRing — or when the user says "/wrap-up", "wrap up", "close out", "are we set", or "is GitHub updated". Leaves the working tree, the full verification gate, GitHub (board/epics/milestones/PRs/issues), durable memory, and teammates in a consistent state. GitHub is the source of truth; verify, never assume; never disturb another session's work.
---

# wrap-up — close out a Jarv1s session

## Overview

A session is not "done" because the code looks finished. It is done when the tree is
committed and pushed, the **full** gate is _verifiably_ green, **GitHub matches reality**
(it is the source of truth), durable lessons are saved, and any other session sharing the
repo is left undisturbed. This skill is the checklist that gets you there.

**Announce:** "Using the wrap-up skill to close out." Create a TodoWrite item per step.

## Docs-only mode

If **every** change in this session is docs/coordination files (`.md`, `docs/**`, `.claude/skills/**`,
coordinator manifests) with **no source, migration, config, or test changes**, skip step 3 (the gate)
entirely. Confirm this by checking `git diff --name-only` — if every path matches `**/*.md`,
`docs/**`, `.claude/**`, or similar non-code paths, state "docs-only — skipping gate" and proceed
directly from step 2 to step 4. **Exception: executable files under `.claude/` are code, not
docs** — `.claude/hooks/*.sh`, `.claude/skills/**/*.sh`, and anything else that runs — a change
there does not qualify for the fast path (at minimum, syntax-check and exercise the script).
Never skip the gate when there is any doubt.

---

## Procedure

### 0. Know who else is in the tree (do this FIRST)

More than one agent session may share this working tree. Before any tree-wide git action:

```bash
git worktree list
herdr pane list            # or: tmux list-panes -a   (other Claude/agent sessions)
```

- **NEVER `git add -A` / `git add .` / `stash` / `reset` / `checkout`** while another
  session has uncommitted work or a build mid-run — you will sweep their changes into your
  commit or break their run. **Stage only your own files, by explicit path.**
- Send a heads-up with `herdr-pane-message` (or `tmux-pane-message`) about what you touched
  and what to avoid. This is the expected channel — use it proactively.

### 1. Nothing uncommitted that should be

```bash
git status --porcelain
```

Classify **every** entry:

- **Yours** → commit by explicit path with the right trailer (build commits:
  `Co-Authored-By: Claude`; your own edits: the model you are).
- **A linter/Prettier reformat** (incl. files you didn't think you changed) → `pnpm format`,
  then commit. `format:check` is part of the gate, so an un-normalized tree fails it.
- **Someone else's** → leave it. Do not commit it.

End with a clean tree, or a clean tree plus a deliberately-stated exception.

### 2. Branch pushed + synced

```bash
git status -sb                      # ahead/behind upstream
git log --oneline @{u}..HEAD        # unpushed commits
```

Push the branch if it is meant to land. Never force-push a shared branch.

### 3. The gate is GREEN — verified, not assumed

```bash
scripts/run-gate.sh start                              # fresh isolated gate DB, detached
scripts/run-gate.sh start --gate audit:release-hardening
scripts/run-gate.sh wait                               # Bash tool timeout: 600000 ms
scripts/run-gate.sh status                             # 0 green · 1 failed · 2 DIED · 3 running
```

- **Use the runner; don't hand-roll a background run and a wait loop.** A full
  `verify:foundation` runs 15–25 min and the Bash tool caps a call at 10 min, so the foreground
  recipe is unrunnable — every hand-rolled wait improvises, and that is where it breaks.
- **NEVER decide liveness from `pgrep`/`ps`.** Every Claude Bash call is wrapped in a shell whose
  command line contains your worktree path and command text, so `pgrep -f` matches wrappers — and
  the wait loop itself — forever. Lane #1273 lost 19 hours to exactly this. The runner decides
  from a trap-guaranteed `### FINAL rc=N` sentinel plus log mtime.
- **NEVER pipe a gate to `tail`/`head`/`grep` as the final stage** — the pipe returns the
  _filter's_ exit code (0) and masks a real failure.
- **Per-suite green ≠ done.** A shared-table/contract change can break _other_ modules'
  suites (e.g. a new `NOT NULL` column breaking another suite's raw seeds). Run the FULL
  suite, not just the module you touched.
- **Re-run known flakes** (e.g. the pg-boss worker-timeout tests) to confirm — don't wave a
  failure off as "pre-existing" without an actual passing re-run.
- **Don't trust an agent's "green."** Re-run the gate yourself.

If red: fix it (systematic-debugging) before claiming done. A red gate is not a wrap-up.

### 4. GitHub matches reality (source of truth)

Verify with `gh` — do not assume the board drifted with you:

- **Board** (project **#2**, "Issue and Roadmap Work"; field/option IDs are in the `start` skill —
  projects #1 and #3 are archived, never query those): each touched epic is in the right column.
  _Move the board item_ — editing a doc is not "started/done". Note the board largely self-maintains:
  new issues are added automatically and closed ones flip to Done, so this is usually a *verify*
  step, not an *update* step. Never hand-backfill it.
- **Epic exit-criteria**: checkboxes reflect what actually shipped. Close the issue only when
  **all** criteria are met **and** the gate is green. For a multi-plan/multi-PR milestone,
  post a progress comment and leave it **open**.
- **Milestone**: close only when its epic is truly done; else leave open.
- **Dependencies / sequencing**: if your work became a prerequisite for another milestone, or
  you re-prioritised, make it legible — add a "Depends on" note to the dependent epic and
  ensure the board **Status** tells the true sequence (active vs queued). Renumber milestones
  only if the user asks.
- **PRs**: opened/updated as intended; base and head correct; body states scope + verified
  gate result + what remains.
- **Issues**: close ones your work resolved; **open follow-ups for anything deferred** so
  scope never silently vanishes.

### 5. Durable memory saved — now, not "later"

For any non-obvious decision (why X over Y), discovered invariant, trap/gotcha that cost real
time, or shift in project state (milestone reached, known-good migration/test counts):
`memory_save` with `project: "jarv1s"` (or write the file-based memory + its `MEMORY.md`
pointer). Never store secrets or private data. "Later" loses the context — save it during
wrap-up.

### 6. Hand off cleanly (if work continues elsewhere)

If a follow-on session will pick up the thread: a committed handoff doc + a spawned or
messaged agent (`herdr-handoff` to start a fresh one, `herdr-pane-message` to brief a running
one). Tell teammates what you touched and what to avoid.

### 7. Final status report

One tight summary: what shipped (with the **verified** evidence — exit codes, test counts,
PR links), the board/PR/issue/milestone state, what's deferred and _where it's tracked_, and
anything awaiting the user.

## Red flags — STOP

- Claiming "gate green" from an exit code obtained through a pipe.
- `git add -A` while another session has changes in the shared tree.
- Closing an epic/milestone from an agent's self-report without your own gate run.
- Updating only a doc, not the board (the board is the source of truth).
- Letting deferred scope evaporate (no follow-up issue).
- Putting off the memory save.

## Quick reference

| Need                    | Command                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| Who else is in the tree | `git worktree list` · `herdr pane list`                                                         |
| Uncommitted?            | `git status --porcelain` · `pnpm format`                                                        |
| Unpushed?               | `git status -sb` · `git log --oneline @{u}..HEAD`                                               |
| Gate (real exit)        | `scripts/run-gate.sh start` → `wait` → `status` (never `pgrep`, never a pipe) |
| Board / issues          | `gh project item-list 2 --owner motioneso --format json --limit 800` · `gh issue …` · `gh pr …` |
| Coordinate / hand off   | `herdr-pane-message` · `tmux-pane-message` · `herdr-handoff`                                    |
| Memory                  | `memory_save` (project: jarv1s) or file-based memory + MEMORY.md                                |

See also the `start` skill (the SDD lifecycle this closes out) and CLAUDE.md (hard invariants,
GitHub tracking, coordinating with other sessions).
