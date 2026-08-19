# Run manifest — 2026-08-19 app-map description fill-in (#1702)

Ben's instruction: kick off a fleet to fill in missing/thin description text across module
manifests, per issue #1702 ("Populate app-map descriptions across all modules"). This is the root
cause of Moss repeatedly telling users it doesn't have info about parts of the app — the mechanism
exists (#1110), the content is thin.

Content-only work: no schema changes, no changes to `app-map.ts` / `app-map-tool.ts` / the
registry's assertion logic (`assertAppMapDeclarations` in `packages/module-registry/src/index.ts`).
Just writing better `description` strings on each manifest's navigation surfaces, settings
surfaces, features, remediations, and error codes.

**Tier: routine** (pure content/docs edits inside each module's own manifest file, no shared-table
migration, no cross-module contract change, no auth/session/RLS surface). Auto-merge after CI
green. No live-path gate — this changes descriptive text read by a tool, not user-facing behavior.

## Queue — 4 lanes, split by module, no file overlap

| Lane | Modules | Worktree / branch |
|---|---|---|
| A | ai, briefings, calendar, chat, commitments, connectors | 1702-appmap-lane-a |
| B | email, goals, memory, news, notes | 1702-appmap-lane-b |
| C | notifications, people, proactive-monitoring, settings, sports | 1702-appmap-lane-c |
| D | structured-state, tasks, usefulness-feedback, weather, web-research, wellness | 1702-appmap-lane-d |

Each lane only touches its own modules' `packages/<module>/src/manifest.ts` (and any sibling
files that own the description strings for that module, e.g. remediation/error-code declarations
in the same package) — no shared files between lanes, so no collision risk and no need to
serialize.

Each lane opens its own PR, all four can merge independently and in any order once green.

## What each lane does

For each of its modules:
1. Read the module's `packages/<module>/src/manifest.ts` in full.
2. For every navigation surface, settings surface, feature, remediation, and error code that has
   a missing or generic/thin `description`, write a real one — specific enough that Moss's chat
   can answer "what can I do here" or "why did this error happen" with it, grounded in what the
   surface/feature/error actually does. Match the tone and specificity of the best existing
   descriptions already in the file (or in a sibling module) rather than inventing a new style.
3. Do not add fields, do not touch `app-map.ts`/`app-map-tool.ts`/the registry, do not change
   behavior — text only.
4. Run `pnpm build:app-map` (or the module's own check if narrower) to confirm the descriptions
   still satisfy `assertAppMapDeclarations` and the file compiles into `dist/app-map.json` cleanly.
5. Commit, push, open a PR against `main`, comment the PR link on issue #1702.

## Verification

CI green (lint/typecheck/build:app-map/test:unit) is the merge bar for this routine-tier, content-
only change. Spot-checking against a live chat instance (per the issue's Verification section) is
a nice-to-have follow-up, not a merge blocker for this fleet.

## Coordinator identity (for lock purposes)

Session id 26201b49-079c-409a-b5e0-4a60987ca935, pane w1:pG4, labelled "Coordinator", tab w1:t6.
main confirmed green at commit 480292bd6f6da918eaaf1c84c8d0c646c9081e57 before spawning.
