# Relay: #1512 notes-path-recheck — live-path proof only

Spec: `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` §B1
Plan: `docs/superpowers/plans/2026-08-17-1512-notes-path-recheck.md` (read the "Live-path gate"
and "Residual risk" sections — do not read the whole plan, those two sections are current and
sufficient)
Issue: #1512 (security tier). PR: **#1671**, branch `1512-notes-path-recheck`, same worktree.
Coordinator: `coord-take35`, pane label "Coordinator" (resolve pane fresh by label — do not use a
baked `w1:pXX` number, it reflows).

## State: all QA remediation DONE and pushed. Only the live-path proof remains.

An Opus adversarial QA agent returned a RED verdict on PR #1671 (3 blocking + 4 non-blocking
findings). All 7 are fixed, committed, and pushed to `origin/1512-notes-path-recheck` as of commit
`b0b3077e3` (rebased onto current `origin/main`). A PR comment requesting re-QA is already posted.
Full isolated gate (`verify:foundation`) is green except two documented pre-existing/unrelated
flakes (`module-sdk-worker.test.ts`, `mcp-gateway-validation.test.ts`) — zero notes-package
failures. **Do not re-fix anything above; do not re-run the full gate unless you change code.**

The ONE remaining blocking item, per QA finding 3 and the plan doc's now-corrected "Live-path
gate" section: **spec B1 requires a live end-to-end proof**, and the plan's earlier "Not
applicable" override was invalid (a plan can't waive the spec's own acceptance row).

## Your task: produce the live-path proof, then hand back to Coordinator

1. Read `docs/DEVELOPMENT_STANDARDS.md` → "Live-Path Gate" section for the general procedure, and
   `dev-preview-recipe` memory / the `e2e-dev-uat-for-ui-features` memory for how proof is normally
   captured on this project.
2. Stand up (or reuse) a live dev instance. Configure a **disposable in-root notes source** — a
   throwaway directory that IS the configured notes root, not a symlink escape target.
3. Through the **real chat UI**, exercise:
   - Assistant create/edit/delete of a note file inside the root (should all succeed normally —
     confirms the new `recheckWithinRoot`/`canonicalizeAsFarAsExists` guard doesn't false-positive
     on legitimate in-root paths).
   - A notes sync run (worker path) over that same root.
   - One deliberate `NotesPathError` case (point at a path outside the configured root, or a
     symlink escape) and then read the **settings API response** for the `notes-last-sync`
     preference's error field — confirm it shows the generic `"path is not within the linked notes
     source"` message, NOT a raw host path. This is the specific thing commit `f717fe4c3` fixed;
     the live-path proof needs to show it holds end-to-end, not just in unit tests.
4. Capture evidence (screenshots under `test-results/…` or equivalent, plus the exact
   settings-response body for step 3's last case). **Do not paste literal host paths or
   outside-root file content into the PR evidence** — redact/genericize if the raw response needs
   quoting.
5. Post the proof as a PR comment on #1671 (`gh pr comment 1671 --body-file ...` — note `gh pr
   edit` silently fails on this repo due to a classic-projects GraphQL error; comments work fine).
6. Report to Coordinator `coord-take35` via `herdr-pane-message` skill: PR #1671 is now fully
   proof-complete, re-QA still needed, you are not merging/closing/moving the board (Coordinator's
   job).

## If you cannot get a live dev instance running

Say so explicitly in both the PR comment and the Coordinator report: **code-complete, unverified**
is the honest status, never "done." Do not fabricate or infer a live-path result.

## Do NOT

- Merge, close #1512, or move the project board — Coordinator's job.
- Re-fix any of the 7 already-addressed QA findings (see commit log: `9d66c1309`, `f717fe4c3`,
  `4d3801d42`, `807bdec19` on this branch, all already pushed).
- Read the full plan doc or full spec — only the sections named above.
