# Vocci: recovery slice and continuing delivery

## Start

Ben requested independent `code-review` of completed work, resolution of findings,
then a fresh session for each next slice, continuing until the approved work is
finished. This is a standing continuation mandate; another general go-ahead is
unnecessary. Own the next bounded recovery slice for #3565, then pass the remaining
queue to a verified fresh session using the cycle below.

1. Run `pnpm install` in your fresh isolated worktree. Read AGENTS.md, CLAUDE.md,
   `docs/DEVELOPMENT_STANDARDS.md`, this handoff and
   `docs/evidence/vocci/2026-10-24-code-review.md` in full.
2. Recheck live issues #3565 and #3584. Read the approved specifications
   `docs/superpowers/specs/2026-10-21-vocci-initial-ring-setup.md`,
   `docs/superpowers/specs/2026-10-20-vocci-automatic-delivery.md` and
   `docs/superpowers/specs/2026-10-23-android-hardware-settings.md`.
3. Before configured-runtime or device access, read the private current handoff at
   `~/.local/state/moss/vocci-recovery/runtime.md`. Older runtime notes describe
   retired development identities and obsolete preferences. Recheck actual state.
4. Use graph-first discovery, the diagnosing-bugs workflow and repo plan-build skill
   to diagnose the observed package-replacement recovery gap. Trace the installed
   manifest, enabled choice, receiver/service lifecycle and Android restrictions.
   Commit a bounded plan with behavioral checks and a real-device proof approach
   before changing implementation. Build against #3565 or a linked task if needed.
5. Complete the smallest useful supported recovery improvement, independently review
   and verify it, then continue the queue through a new session. Preserve the working
   production setup and recordings throughout.

## Current acceptance

Guided setup, native Hardware settings, recording inventory/inspection/exclusion,
shared Meeting transcript language and instance transcription-provider selection
are merged. The configured production path has physical normal-recording proof:
delivery, real ASR, a visible timestamped transcript and a fresh automatically saved
summary. The acceptance record is
`docs/superpowers/plans/2026-10-24-vocci-production-acceptance.md`.

A real ready recording with upload pending survived signed APK replacement and
completed after the actual native Start button was tapped. Android's broadcast
history reported that it skipped the package-replacement receiver; the delivery
service did not resume automatically. The reason still needs diagnosis. This is
manual recovery proof, not automatic restart or interrupted-chunk/byte-offset
resume proof. Earlier failed automatic-summary receipts remain failed; their
successful manual retries are separate from the fresh automatic-summary proof.

No new recording or unlock request is pending. Delivery was left enabled, hold and
source cleanup off, and the original two-minute screen timeout restored. Desktop
test browsers and owned test servers were closed. Those are last observations,
not permission to assume the phone is still available or unlocked.

The shorter Settings/Meetings copy in #3613 is merged; this session did not deploy
that cleanup. Keep helpers brief and show setup/recovery advice when relevant.

The final independent audit found one excluded-source transcription-retry bypass.
Correction `6c174d80b84001a42cd3145a80ea2f73769bb738` blocks the service command
and hides the retry control. Both independent re-reviews are clear; the installed
disposable local contract/UI proof passed. Read the linked review record for its
exact scope and negative controls. The production companion was not replaced by
that proof; include the correction in the next reviewed signed release and verify
installation separately.

## Remaining queue

Select one bounded deliverable at a time, preferring work that unblocks daily use:

1. #3565: package-update/background recovery, followed by actual reboot/unlock,
   offline/out-of-range recovery and interrupted-upload verification. Preserve the
   enabled/disabled choice and current source/configuration identity.
2. Deploy the merged copy cleanup with the reviewed release when appropriate.
   Recheck live CI, immutable image provenance, deployment ownership and effective
   configuration; preserve the customized deployment and follow the existing
   coordinated-backup procedure before production replacement.
3. Optional production hold-to-talk review/Send/Main proof when Ben chooses to
   enable hold and provides a suitable sample. Keep hold separately opted in.
4. #3584: real long-recording reminder/endurance checks, supported shared custom
   vocabulary and any other approved missing Meeting-processing behavior. Follow
   preferences into actual consumers; unsupported settings are not implementation.
5. Safe individual ring deletion, original-preserving Meeting audio enhancement,
   firmware compatibility/recovery and streaming research or implementation only
   within their approved scope and established hardware capabilities. A source-level
   lead is not a validated device operation. Obtain any missing design or disposable
   sample authorization before dependent writes.

The simulated two-hour validation already accepted for the delivered slice is not
a new physical two-hour completion gate. Record additional endurance evidence with
its actual scope. Keep #3565 and #3584 open until their own criteria are met.

## Repeat for every slice

1. Re-read the live backlog and relevant decisions. Choose an actionable slice,
   identify its approved scope/task and commit a bounded repo plan-build plan.
   Research missing answers in code, Hindsight and the Obsidian project notes before
   asking Ben. New behavior needing a design decision still needs that decision.
2. Implement through existing module seams. Keep UI concise, provider agnostic and
   deterministic, preserve preferences, and update Moss's app map in the same PR.
3. Run `code-review` against immutable base/head commits with independent Standards
   and Spec agents. Record both reports separately. Resolve every actionable finding,
   obtain independent re-review of corrections and record why a finding is invalid
   when the evidence establishes that. Self-review does not replace this gate.
4. Run checks appropriate to the change. Use repo verify-gate for every DB-touching
   command, reserved devports for servers, and actual live UI/data for user-facing
   acceptance. Disclose stand-ins and physical verification limits. Required CI and
   real-path proof must pass before merging; user has authorized reviewed merges.
5. Commit and push explicit paths, update the task/PR with accurate evidence, restore
   temporary user choices and stop owned tools. Preserve useful private receipts
   outside git; keep the worktree clean. Verify deployment separately from merge.
6. Once that slice is finished, use `herdr-handoff` to commit the next handoff on the
   successor's base, create a fresh isolated worktree and start a new session. Carry
   this continuing mandate and the remaining queue forward. Verify the successor
   actually begins work; record its durable agent name and immutable session ID.
   One session owns production/device mutations at a time. Relinquish that ownership
   after the verified handoff rather than duplicating the successor's work.

Continue this cycle until the approved backlog is complete. When an external
prerequisite blocks a slice, record the exact blocker in the tracker and applicable
AWAITING-BEN/needs-ben flow, then work another independent actionable slice. Avoid
repeatedly spawning successors into the same unchanged blocker. If all remaining
items require unavailable hardware, a user action or a missing design decision,
leave an explicit blocked list rather than claiming completion or manufacturing
verification. Resume the cycle when those prerequisites arrive.

## Device and data boundaries

Use only the authorized phone identified privately, with an explicit serial on every
ADB call. Preserve account/ring ownership, signing identity, Keystore, queues,
exclusions, retained originals and hold destinations. Device checks and production
probes must not expose credentials or private recordings in logs, prompts or git.
Reversible temporary device settings require restoration to observed values.

No clear-data/uninstall of the production package, destructive rebind, ring reset,
erase-all, ownership write, guessed legacy/V3 command or firmware operation is
authorized by this continuation. Individual source deletion needs a proven exact
command and explicit suitable sample authorization. Audio enhancement preserves
originals. The official Vocci app can compete for Bluetooth and sync/delete sources;
use the private current handoff for the intentional production permission state.

Review historical helper scripts before reuse. Completed imports and saved summaries
are not pending work, and old queue-recovery scripts are not instructions to replay
mutations. State uncertainty explicitly and keep completed evidence intact.
