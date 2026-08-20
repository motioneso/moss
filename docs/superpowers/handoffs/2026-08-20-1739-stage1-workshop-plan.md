# Handoff — write the build plan for Workshop stage 1 (#1739 stage 1)

You are writing a plan, not code. Nothing in this branch should touch product source files.

## Background

The spec for "Moss builds modules on Moss" is approved and merged:
`docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`. Read it in full.

Also read `docs/coordination/state-1739-moss-builds-modules.md` — a short pointer doc with
the decisions Ben already made and two verified technical findings the design depends on.

Five build issues exist on the GitHub board (project 2, "Issue and Roadmap Work"), all in
"Ready", none started:

- #1752 — Workshop 1: find modules that appear after the server has started
- #1753 — Workshop 2: a draft module that runs for its author alone
- #1754 — Workshop 3: the build agent — agree a plan, then build it
- #1755 — Workshop 4: the Workshop page
- #1756 — Workshop 5: agreeing the plan, and changing a running draft, in chat

Read all five issue bodies with `gh issue view <number>`. #1752's body states the required
build order explicitly: **#1752 first (depends on nothing), then #1753, then #1754. #1755
and #1756 are front-end work and can run alongside any of the backend work.** Confirm that
ordering still holds once you've read all five in full — if you find a dependency the issue
text missed, say so in the plan rather than silently reordering.

## What to produce

A single plan document, written with the project's `writing-plans` skill (invoke it — this
is a superpowers-plugin skill you have available, same as Claude Code sessions in this repo).
It should break the five issues into buildable steps in dependency order, name the files each
step touches, and be usable directly by a separate build agent per step (or per small group
of steps) — assume the agent reading each step has not read this handoff or the spec, only
the plan step itself plus the spec/issue references you give it.

Save it to `docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md`.

## Guardrails carried from this project's CLAUDE.md — read the real file too

- No new feature ships without this plan being grounded in the approved spec — don't
  reopen decisions Ben already made (see the state doc above); flag anything you think is
  wrong rather than silently changing it.
- Module isolation: modules collaborate only through declared public APIs and events, never
  by importing another module's internals or querying its tables.
- Moss never handles a module's own credential/key, and never ships a module's work without
  a human action — this is a hard rule from the spec's own decisions, not just a preference.
- Keep status/plan language in plain English: name things by what they do, not by internal
  identifiers, except where a builder must act on an exact name (a file path, a command, an
  error string). No invented shorthand terms.

## Start

1. `pnpm install` (this is a fresh worktree).
2. Read the spec, the state doc, and all five issues in full.
3. Use the `writing-plans` skill to produce the plan.
4. Commit the plan doc on this branch (`plan/1739-stage1-workshop`) and push it.
5. Stop there — do not start building, and do not spawn a successor. Report back that the
   plan is committed and pushed, and where it lives.
