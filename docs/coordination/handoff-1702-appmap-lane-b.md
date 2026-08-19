# Build Handoff — 1702-appmap-lane-b

**GitHub issue:** #1702 — "Populate app-map descriptions across all modules"
**Risk tier:** routine (content-only, no schema/behavior change, no live-path gate needed)
**Worktree:** ~/Jarv1s/.claude/worktrees/1702-appmap-lane-b **Branch:** 1702-appmap-lane-b (off origin/main)
**Coordinator label:** `Coordinator` — verify `herdr pane list` shows exactly one pane with this
label before messaging it.
**Coordinator session id:** 26201b49-079c-409a-b5e0-4a60987ca935
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill.

## Your modules (this lane only — no other lane touches these files)

`email`, `goals`, `memory`, `news`, `notes`

Files: `packages/<module>/src/manifest.ts` for each of the six above, plus any sibling file in
that same package that declares the description strings for its remediations/error codes (read
the manifest first — it will show you if descriptions live inline or are imported from a sibling
file).

## What to do

Issue #1702 in full context: root cause of Moss telling users "I don't have that info" is that
most module manifests have missing or generic/thin `description` text on their navigation
surfaces, settings surfaces, features, remediations, and error codes. These descriptions compile
into `dist/app-map.json` and are what the chat assistant actually reads to answer "what can I do
here" / "why did this error happen." This is content work, not a feature build — no schema
changes, no touching `packages/module-registry/src/index.ts`, `packages/settings/src/app-map.ts`,
or `app-map-tool.ts`.

For each of your five modules:
1. Read `packages/<module>/src/manifest.ts` in full.
2. For every navigation surface, settings surface, feature, remediation, and error code with a
   missing or generic/thin `description`, write a real one — specific enough that the chat
   assistant could ground an answer in it. Match the tone/specificity of the best existing
   descriptions in that file or in a well-described sibling module — don't invent a new style.
3. Text only. Don't add/remove fields, don't change behavior, don't touch shared app-map code.
4. After each module (or once done with all six), run `pnpm build:app-map` from repo root to
   confirm `assertAppMapDeclarations` still passes and `dist/app-map.json` compiles cleanly.
5. Run `pnpm lint` and `pnpm typecheck` scoped to your changed files if possible; otherwise the
   PR's CI gate will catch it.

## Exit criteria

- All five modules' manifests have real descriptions on every navigation surface, settings
  surface, feature, remediation, and error code — none left empty or copy-pasted generic.
- `pnpm build:app-map` passes.
- CI green on the PR (lint, typecheck, build:app-map, test:unit — this is content-only so the
  existing test suites should pass unchanged unless a test asserts on old description text, in
  which case update that assertion to match, don't weaken it).
- PR open against `main`, PR link commented on issue #1702.
- **No live-path gate for this PR** — it's routine-tier content, not user-facing behavior. State
  that explicitly in your PR description so nobody blocks on it by mistake.

## Run-specific bans

- Work only in this worktree/branch; `git add` by explicit path, never `git add -A` or a repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, or merge your own PR —
  the coordinator merges after CI green.
- No secrets in any doc, payload, log, or prompt.
- **Plain English in every message to the coordinator or in the PR description** — no jargon, no
  invented shorthand. Say what a description covers in normal words; keep exact file paths/names
  only where someone needs to act on them.

## Collision notes

None — the other three lanes (`1702-appmap-lane-a/c/d`) touch a disjoint set of modules. No shared
files.

## When done

Comment the merged... actually, comment the **open PR link** on issue #1702 (`gh issue comment
1702 --repo motioneso/moss --body "..."`), then message the coordinator (`herdr pane run` to pane
`w1:pG4` label `Coordinator`) that your lane is ready for review, signed with your own pane id.
