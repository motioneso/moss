# Vocci next slice: shared Meeting preferences

## Start

Ben requested a new Codex session for the next part after recording management.
Own the next bounded group 4 slice from the approved Android Hardware specification
in `~/Jarv1s/.claude/worktrees/vocci-meeting-preferences`, branch
`feat/vocci-meeting-preferences`. The preceding implementation session is finished;
preserve its branch and PR.

1. First run `pnpm install` in this fresh worktree. Read AGENTS.md, CLAUDE.md,
   docs/DEVELOPMENT_STANDARDS.md and the approved specification in
   docs/superpowers/specs/2026-10-23-android-hardware-settings.md in full.
2. Read this handoff and the group 3 implementation/verification record at
   docs/superpowers/plans/2026-10-23-vocci-recording-management.md. Before any device
   or configured-runtime access, read the private runtime handoff at
   `~/.local/state/moss/vocci-recording-management-handoff/runtime.md` in full.
   It includes newer closeout corrections; do not use its older preference defaults.
3. Recheck live task #3584, draft #3592, draft #3586, prerequisite #3576 and guided
   setup. At source commit `093f97c841708d7a4d83ea9626f97140954ae8a4`, Android,
   static, Meetings chat/runtime and compose checks passed, but app-action browser,
   Meetings model-fixtures and browser shard 2 had failures, with other checks still
   running. These failures have not been triaged. Inspect actual failed assertions
   and establish relevance before advancing; fix regressions attributable to this
   stack rather than labelling them infrastructure without evidence. Do not merge.
4. Use graph-first discovery and the repo plan-build skill to trace shared Meeting
   preferences, their native/web entry points, the ASR capability contract and real
   transcription consumers. Read design-system and docs/design-system.md before UI
   changes. Commit a bounded plan before implementation.
5. Own the smallest useful supported group 4 capability end to end, then run focused
   regressions, app-map checks and the real live UI path. Preserve existing behavior
   and user preferences, commit/push explicit paths and open a separate stacked draft
   PR against `feat/vocci-recording-management`. Keep #3584 open. Begin autonomously;
   clarify only material behavior not resolved by the approved scope or existing
   project decisions.

## Next part: approved group 4

Shared Meeting preferences should cover transcript language, custom vocabulary and
supported automatic transcription/summary behavior. These are shared Meetings
capabilities, not duplicate Vocci-only toggles. Existing automatic Meeting processing
and automatic summaries using the instance default model already exist. Reuse them.

The previous specification records that transcript language and vocabulary were not
in the Meetings preference contract/form at that time. Verify current code. Saving
an unused setting is not implementation: follow the value into the actual ASR
request, define capability handling for unsupported providers, and test that the
selected behavior changes the real pipeline. Keep AI provider agnostic. Start with
a bounded supported slice rather than implementing all of group 4 at once.

Audio enhancement belongs with Meeting audio tools. Original preservation must be
defined before it runs; do not turn it into a ring control or overwrite originals.
Defer enhancement if no established preservation/capability seam supports it. Firmware
updating requires separate compatibility/recovery proof and is not this slice.

Existing Main chat, mobile layout and hold consent remain intact. Hold audio stays
separately opted in, with transcript review and explicit Send; replies remain text.
Do not add a second chat, a settings dashboard or provider-specific hardcoding.

## Preceding recording-management slice

Draft #3592 is stacked on draft #3586 (`feat/vocci-hardware-settings`), which is
stacked on #3576 (`fix/meeting-default-provider`) and guided setup. No merge or
production deployment has occurred. This new worktree includes those pending changes;
it does not make them released.

Group 3 adds actual dated ring inventory, 25-source pages, selected-source inspection
and durable exclusions from further delivery. `DeliveryService` owns the single
worker/GATT connection and ledger writes; Activities read snapshots and submit
commands. `RingRecordings` binds observations/exclusions to origin, owner, saved
ring identity and the delivery journal's source identity. Exclusions survive empty
inventories and restart, preserve evidence/destinations, and have no undo in this
build. A current request may finish before the exclusion saves; existing Moss items
and bytes already sent cannot be recalled. Existing non-recording service commands
retain live-owner checks before touching the queue or server.

The official APK's selected-file transport was traced statically, but complete
legacy audio/sidecar removal and safe physical behavior remain unverified. Individual
deletion remains unavailable. No delete command was implemented or sent. Do not
substitute reset, erase-all, unbinding, V3/debug commands or guessed opcodes. No
additional source deletion is authorized by this handoff.

## Evidence and device state

PR proof:
https://github.com/motioneso/moss/pull/3592#issuecomment-6370172080
Task progress:
https://github.com/motioneso/moss/issues/3584#issuecomment-6370179409

- Android host protocol/crypto/telemetry/reminder/PCM checks, including generated
  two-hour audio, and APK build passed. Final installed DeviceChecks passed.
- New installed checks cover identity fields, stale selection, exclusion restart and
  reinventory, admission/chunk races, queued resume, retained evidence and unknown
  metadata. Removing the ledger constructor identity guard produced FAIL; restoring
  it, rebuilding and reinstalling produced PASS.
- Native UI runs passed 20 empty-inventory assertions, then 16 selected-source
  assertions using Ben's explicitly authorized disposable normal sample: inspect,
  exclusion cancel, confirm, saved receipt, real reinventory and process restart.
- The sample was still present during the initial post-exclusion inventory. A later
  refresh failed once with ring_unavailable, then succeeded with zero sources. The
  saved exclusion remained. The reason for that later absence is not established.
  Never claim the sample is currently present or that this proved deletion.
- Final APK passed 10 further native assertions for real stopped refresh, the actual
  current empty inventory and persistent exclusion after restart. The sample-present
  proof preceded the final non-recording owner-check correction and deletion-copy
  cleanup; this distinction is recorded on the PR.
- Full local verify:static passed; 27 focused app-map tests passed. The inherited
  web-only settings-path assertion was extended to validate Android package/activity
  declarations against the real Android manifest. No DB changes were made.
- Original observed delivery/reminder/cleanup choices, device timeout/stay-awake,
  appearance/font and official-app Nearby devices grants were restored. Encrypted
  configuration hash stayed unchanged; both completed queue entries remained.
  Journal activity fields changed, so do not claim a byte-identical journal.
- Test app processes were stopped; no server/browser was left running. Private final
  APK, signing key, scripts and raw evidence are outside the checkout. Runtime.md
  identifies them; worktree build outputs were removed.

Preserve the configured account, pairing, queue, exclusion and hold state. Do not
clear app data, reprovision or casually launch the official Vocci app: it can compete
for the ring and automatically sync/delete sources. Any physical UI proof must use
only the authorized phone identified in runtime.md, never the other attached device.
Recheck actual inventory/preferences instead of assuming a prior observation holds.
The sample authorization was exclusion-only, not deletion; do not reuse it for a new
sample or an unrelated destructive action.

## Working and finishing rules

Use repo plan-build, design-system, shared-checkout and verify-gate as applicable.
Any DB-touching check must run through verify-gate's isolated procedure. Every dev
server needs a devports reservation. The graph is preferred for code discovery;
fall back to bounded reads when its results are insufficient.

Keep feedback deterministic, app-map declarations truthful in the same PR, and
verification unpiped. Live proof must exercise actual UI/data; never rewrite network
responses to manufacture success. No screenshot is needed. If a capability cannot
be exercised, report its exact verification limit and keep the draft unmerged.

You are not alone in the repository: preserve others' work and do not revert their
edits. Stay in your assigned worktree. Review every added line, use explicit-path
commits, push worthwhile plans/handoffs, stop owned servers/browser/test processes,
restore any temporary user choices/settings/grants, and finish clean. No extra agent
is needed unless Ben or an applicable skill explicitly asks for one.
