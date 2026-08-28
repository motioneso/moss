# Build Handoff — release notes through protected main

**Spec (approved):** `docs/superpowers/specs/2026-08-23-1794-release-notes-protected-main.md`
**GitHub issue:** #1794
**Risk tier:** `sensitive`
**Worktree:** `~/Jarv1s/.claude/worktrees/1794-release-notes-protected-main`
**Branch:** `build/1794-release-notes-protected-main` off `origin/main`
**Build skill path:** `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
**Coordinator agent name:** `coordinator`
**Coordinator session id:** `01a02f7f-5563-7590-ac66-9b2827dab85c`

## Start

1. Run `[ -d node_modules ] || pnpm install`.
2. Read the approved spec by section for the current task only.
3. Invoke `coordinated-build`: verify scope, create a `plan-build` plan, get coordinator approval
   before production code, build test-first, then use `coordinated-wrap-up` for the PR and report.

## Exit criteria

- Meet the spec exit criteria and the full isolated gate.
- Open a PR rebased on `origin/main` with the required release-note section.
- This internal release process has no live-UI gate, but the sensitive-tier process invariant and
  the spec's real post-merge acceptance proof still apply.

## Run-specific bans

- Work only in this worktree and branch; stage explicit paths only. Never run repo-wide formatting.
- Never edit `docs/coordination/`, the project board, milestones, or merge anything.
- Never revert other agents' work; this repo is active in parallel.
- No secrets in docs, payloads, logs, or prompts.

## Collision and ordering notes

- This lane changes release-note shape and process instructions, so it merges last.
- Rebase after every preceding run merge and rerun the append script rather than hand-merging the
  release-note page.
- The acceptance proof requires a real PR merged after this change. The run's small closing
  coordination-docs PR is reserved as that trigger; do not claim completion before that proof.
