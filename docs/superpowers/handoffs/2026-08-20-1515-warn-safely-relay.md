# Relay handoff — 1515-warn-safely-commitment-extraction

**Spec:** `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md`, section for #1515 / "C2" only.
**Plan (approved by coordinator, follow it exactly):** `docs/superpowers/plans/2026-08-20-1515-warn-safely-commitment-extraction.md`
**Branch/worktree:** this one, no need to switch.
**Coordinator:** find the pane labeled `Coordinator` fresh via `herdr pane list` (don't trust any pane number written anywhere else — it goes stale). Relay trigger stays the same: context-meter 70% warning, or seeing a compaction summary in your own context.

## Done (committed, don't redo)

- `d3862ad04` — Task 1: `packages/commitments/src/extractor.ts` gets a small local warning port and calls it on the model-call failure and the two malformed-output paths. Tests in `tests/unit/commitment-extractor.test.ts`, verified green: `pnpm test:unit tests/unit/commitment-extractor.test.ts` -> 9 passed, exit 0.
- `7a3c94db7` — the build plan doc itself.

## Left to do — exactly what the plan's Task 2 and Task 3 say

**Task 2 — `packages/commitments/src/workers.ts`:** add the same kind of warning call at the four places the worker gives up early (missing source provider, missing model, missing credential, invalid credential) using the exact event names and messages the plan lists for each. Pass the warning logger through to the extractor call already in that file. Rename `tests/unit/commitment-worker-shape.test.ts` to `tests/unit/commitment-worker.test.ts` and add the six behavior tests the plan describes, copying the fake-queue test pattern already used in `tests/unit/news-jobs.test.ts`. Commit this as its own task, separate message, `Co-Authored-By: Claude` trailer, mention #1515 and #1137.

**Task 3 — `packages/module-registry/src/index.ts`:** touch only the commitments worker-registration block (around line 1850-1856) to wire the same module logger pattern already used for chat and news. No new test needed — the plan says the existing export check and the package typecheck cover it. Commit separately.

Read the plan file by section for whichever task you're on — do not read it front to back in one go.

## After Task 2 and 3 land

Run, unpiped, each with `echo "EXIT=$?"` after:
- `pnpm test:unit tests/unit/commitment-extractor.test.ts tests/unit/commitment-worker.test.ts`
- `pnpm --filter @moss/module-registry typecheck`
- `pnpm --filter @moss/commitments typecheck`
- `pnpm check:file-size`

Then `coordinated-wrap-up`: full gate via the `verify-gate` skill on an isolated database, rebase on `origin/main`, push, open the pull request. This is a backend safety fix with no user-facing screen, so say that plainly in the wrap-up report instead of skipping the live-proof question — no UAT run is needed for this one.

Don't touch anything under `docs/coordination/`, the project board, or milestones, and don't merge — that's the coordinator's job.

One more thing to watch: issue #1517 touches the same commitment-handling files and is waiting to start once this branch is merged, so leave things tidy — no half-finished edits, no loose test files.

## Communication rule (carries to any agent you spawn too)

Keep every message to the coordinator and every status update in plain English. Say what a thing does, not what the repo calls it. Only use an exact name (a file to open, a command to run, an error to search for) when the reader has to act on that exact one.
