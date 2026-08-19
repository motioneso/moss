# #1202 / #1187 — durable live-QA evidence (corrected GREEN, run_3)

Evidence-only directory. No executable or test code was changed to produce this commit — these
files are copied verbatim from a coordinator-run live visual QA pass and are preserved here so the
result survives after the ephemeral coordinator workspace is cleaned up.

## Verdict

**Corrected 26/26 CPs GREEN** at executable head `1e2a9a92` (the `#1187` Module Library
acceptance). Durable verdict comment:
https://github.com/motioneso/Jarv1s/pull/1202#issuecomment-5018568838

`results.json` in this directory is the raw harness output, which marks `CP6`/`CP7` as
`ok: false`. That raw failure reflects an invalid assumption baked into the automated checker — it
expected visible "Enable"/"Disable" text next to the Wellness switch. #1187's actual UI never
renders that text; the switch is a bare control with no adjacent label (consistent with
`libraryAction()` in
`~/Jarv1s/apps/web/src/settings/settings-module-registry-section.tsx`, where the `switch` action
kind carries no separate visible label string). `action-log.txt` step 7 (CP15) confirms the real
control works end-to-end: the Wellness switch was clicked in both directions, the server-side
`instanceDisabled` flag changed, and it was restored afterward. With that invalid checker
assumption accounted for, every one of the 26 checkpoints (`CP_SETUP`, `CP1`–`CP26`) passes.

## Non-blocking observation (not a gate)

The Wellness switch lacks a state-specific accessible name (e.g. it doesn't announce
"Disable Wellness" vs. "Enable Wellness" to assistive tech — only a generic switch role/state).
This is a legitimate accessibility follow-up but was never part of the approved `#1187` acceptance
criteria, so it does not block this PR. Tracked for a future accessibility pass, not fixed here.

## Contents

- `results.json` — raw per-checkpoint harness output (`CP_SETUP`, `CP1`–`CP26`), copied unmodified
  from the coordinator workspace at
  `~/Jarv1s/.claude/worktrees/coord-1179-pdf/outputs/qa-1202-1187-live-current/final_runs/run_3/results.json`.
- `action-log.txt` — the step-by-step action log for the same run (renamed from
  `final_script_log.txt` in the source directory), narrating sign-in, navigation, each checkpoint,
  and the exact dialog copy observed during the install-confirm step.

## Source run

Coordinator workspace, worktree `coord-1179-pdf`:
`~/Jarv1s/.claude/worktrees/coord-1179-pdf/outputs/qa-1202-1187-live-current/final_runs/run_3/`

Fresh isolated stack used for this run: API port 3034, web port 5184, DB
`jarvis_qa_1202_1187_r2`; torn down after the run completed (per the durable verdict comment).
