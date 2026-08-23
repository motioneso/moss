# Issue #1872 — Fable-authored implementation plan

## Assignment

You are the Fable planning authority for run 1834. Author the implementation plan for issue #1872
from scratch using:

- `docs/superpowers/specs/2026-08-23-service-worker-image-fetch-recovery.md`
- https://github.com/motioneso/moss/issues/1872
- https://github.com/motioneso/moss/issues/1872#issuecomment-5384238958

Do not read or reuse the Sonnet-authored draft in the separate
`1872-service-worker-image-diagnosis` worktree. Ben explicitly requires Fable to build plans, not
review plans authored by Sonnet.

## Deliverable

Use the `plan-build` planning standard and write the authoritative plan to
`docs/superpowers/plans/2026-08-23-service-worker-image-fetch-recovery.md`. Ground the plan in the
actual shared Service Worker flow and issue acceptance criteria. It must include the smallest
deterministic regression test, live-path proof for an article image and sports logo, and preserved
offline navigation behavior.

Commit only the plan and any required plan metadata. Then report the plan path, commit, and a
one-line APPROVED/BLOCKED verdict to agent `coordinator` with the `herdr-pane-message` skill,
signed with your pane id. Do not implement product code.

## Guardrails

- No product code, PR, or production mutation.
- Do not touch `docs/coordination/`, run repo-wide formatting, or use broad `git add`.
- Keep CSP and chat-stream warnings out unless evidence proves they share the root cause.

## Start

Read the spec and issue evidence, inspect the relevant code, invoke the planning workflow, author
and commit the plan, then report to `coordinator` without pausing between steps.
