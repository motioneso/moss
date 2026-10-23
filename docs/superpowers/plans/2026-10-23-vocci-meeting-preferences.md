# Shared Meeting transcript language — group 4

Approved scope: `docs/superpowers/specs/2026-10-23-android-hardware-settings.md`.
Task #3584 stays open. Work in `~/Jarv1s/.claude/worktrees/vocci-meeting-preferences`,
branch `feat/vocci-meeting-preferences`, stacked on `feat/vocci-recording-management`
(draft #3592), then #3586, #3576 and guided setup #3566. The later review mandate
below supersedes the original no-merge instruction; no deployment is requested.

## Existing seams

- `packages/shared/src/meeting-preferences-api.ts:12` defines shared preferences;
  `packages/meetings/src/preferences.ts:26` reads actor-scoped structured preferences.
  `preferences-routes.ts:20` authenticates GET/PUT. No migration is needed.
- `packages/meetings/src/web/meeting-settings-form.tsx:67` and
  `meeting-settings-state.ts:43` own the existing Settings → Modules → Meetings form.
  Extend its shared `Field`, `FormLabel`, `Select`, loading/error and retry behavior.
- `packages/meetings/src/capture-service.ts:826` dispatches live speech;
  `recording-import-service.ts:271` dispatches short imports;
  `recording-window-service.ts:73` dispatches long import windows. All use the
  configured transcription port. Normal imports have a meeting ID; hold imports
  deliberately do not. Do not apply Meeting language to hold input.
- `packages/ai/src/configured-transcription.ts:214` calls the configured adapter;
  `adapters/http-api.ts:159` sends timestamped multipart ASR. Only the existing
  OpenAI-compatible transcription protocol is supported by this port; unsupported
  provider kinds already fail availability. Extend the generic protocol with its
  standard optional `language` field, with no vendor/model selection or fallback.
- `packages/meetings/src/action-presentations.ts:209` presents preference changes
  for approval. Include the new field and its before/current version identity.
- `packages/meetings/src/manifest.ts:100` declares settings; update descriptions,
  language behavior, requirements, processing errors and remediation in the app map.

## Bounded decision

Add `transcriptLanguage: string | null` to Meeting preferences. Null means automatic
detection and omits `language` from ASR. Validate explicit values against ISO 639-1
codes and offer those codes with English language names in the existing select.
The list describes input languages, not a promise that every configured model
supports every language. The service must support the chosen language and the
standard parameter. Failed normal imports have no retry action; changing preferences
or replaying an upload does not restart them. Original evidence remains retained.
Rejection is an existing transcription failure; never silently retry without the
hint or change providers. A service silently ignoring a
standard parameter cannot be detected by this contract; do not claim otherwise.

Resolve the preference before each new live speech request and normal import/window
request. Changes affect subsequent requests, including subsequent windows of an
in-progress import; already retained transcript text is unchanged. Automatic mode
preserves current request behavior. Hold consent, review, Send and Main stay intact.
No duplicate native preference store or ring control is added: Android supplies
normal recordings to this same server-side Meetings path. Vocabulary, enhancement,
firmware and automatic-transcription controls are deferred. Existing automatic
processing and the automatic-summary switch remain the canonical mechanisms.

## Implementation and verification

1. Extend shared contract/schema, scoped preference storage, approval presentation
   and form/state; preserve unrelated saved choices and retry unsaved choices.
2. Carry the language through live capture, short normal imports, long normal
   windows, configured ASR and actual multipart transport. Exclude voice requests.
3. Add meaningful regression coverage: defaults/validation/round-trip and partial
   saves; UI save/failure/retry/clear; approval field; all transcription consumers;
   actual transport presence/omission; provider rejection without a fallback request.
4. Run focused Vitest suites (expected exit 0), `pnpm verify:static` (expected 0),
   app-map tests (expected 0). Run DB checks only via
   `scripts/run-gate.sh start --gate <script>` and its detached wait procedure;
   expected exit 0. Commands are
   unpiped, with output files and bounded reads preserving actual exit status.
5. Exercise owner signup → real Settings → Modules → Meetings → save/reload language
   → real normal recording import → retained transcript on an isolated live dev
   runtime, with a devports reservation. Prove the configured ASR receives the hint;
   a disclosed ASR protocol stand-in may prove request behavior, while real-ASR
   linguistic quality is a separate claim. No response interception or screenshots.
   Cover automatic reset and phone-width/dark-theme traversal. Record exact proof
   limits and restore temporary choices. Do not access the configured phone for
   this server/web slice.

## Determinism, kill gate and evidence ledger

All feedback renders from saved responses and local pending/error records. No new
chat turns or prompt guidance. The model jobs are speech transcription and the
existing optional summary; this slice changes only the former's request language.
No model-authored preference values enter user data automatically.

Owner: implementing agent. Kill further group 4 scope if the generic ASR parameter
cannot reach a supported request through the actual UI/data path. Leave the draft
code-complete, unverified if live proof cannot run. Ship/evaluate language alone
before planning vocabulary or enhancement.

Rechecked the source commit `093f97c84` failures: app-action job 120541199129 and
model-fixtures job 120541198312 timed out in browser dependency installation at five
minutes; browser shard 2 job 120541237439 failed on dpkg lock held by apt-get; unit
job 120541237354 timed out installing Chromium at ten minutes. No product assertions
ran in those failed phases. New source `11336f180` is docs-only and its checks were
still running at initial inspection. Recheck before closeout; do not call pending
checks green or infer a regression from setup failures.

Commit/push the plan before implementation. Review every added line and commit only
explicit owned paths; open a separate stacked draft PR with release note, evidence,
limitations and Merge Danger. Stop owned processes and finish with a clean tree.

## Implementation and proof record — 2026-10-23

Implemented the language-only decision in the shared contract, preference repository,
approval presentation, existing Settings form, live capture and both normal-import
paths. The configured transcription port forwards the optional standard multipart
field to the configured service. Automatic detection omits it. The shared language
list validates saved values; it does not advertise provider support. The module
manifest records the setting, failure behavior and recovery limits. No migration,
native changes or configured-phone access were needed. The exported capture
transcriber type moved to its own file to keep the existing service below the file
size limit; its old export remains available.

Observed checks:

- `pnpm verify:static`: **exit 0**, including lint, formatting, file size, design
  checks, dependency/migration checks, application/test/web/external-module type
  checks and app-map build. Final scoped formatting and `git diff --check` passed
  after the proof record was added.
- Focused Vitest command covering preferences, Settings, approval, configured ASR,
  capture, capture connections/web, Stop summary, web interaction and app-map
  integrity/contract: **11 files, 355 tests passed; exit 0**. Assertions inspect the
  actual ASR multipart body, automatic omission and rejected-language/no-fallback
  behavior, alongside the shared UI's save/reload/clear/failure/retry behavior.
- `scripts/run-gate.sh start --gate test:integration:3584`, then detached
  `scripts/run-gate.sh wait --follow`: **3 files, 49 tests passed; exit 0**. Final
  run receipt `vocci_meeting_preferences-20261023-102050` tested plan commit
  `6e98a0724` plus the recorded dirty tree, fingerprint `3ad5735f6cc3`, Node 22.22.2,
  pnpm 10.6.2. It covered actual owner-scoped preference reads in short normal
  imports, changing language between normal windows, and both short/window hold
  independence. The isolated gate database/container was removed by the runner.
  Subsequent edits changed only the UAT test and proof documentation; the tested
  database production/test paths stayed unchanged.
- `tests/uat/run-uat.ts 3584-meeting-language.uat.spec.ts`: **1 test passed; exit 0**,
  with capture disabled, no configured provider credentials, a devports reservation,
  a freshly built isolated Docker image and a bare database. The final run used
  actual owner signup, skipped optional setup through its UI, then Account menu →
  Settings → Modules → Configure Meetings. Spanish survived reload. Appearance's
  actual Dark control changed the saved color mode; the Meetings control fit at
  390 × 844 with no horizontal overflow.
- The same live test submitted generated normal-recording evidence through the
  authenticated receiver API. The real vault, job queue, worker, configured ASR
  adapter and retained transcript ran unchanged. A disclosed third-party ASR
  protocol stand-in validated WAV bytes and observed exactly `es`, absent language,
  then rejected `aa`. The rejected import reported `transcription_failed` and
  `retryable: false`; no fallback request occurred. After resetting to Automatic,
  the earlier transcript remained visible through the real phone-width Meetings
  Transcript tab. Meetings were removed and preferences, color mode and AI pin
  restored before fixture/container teardown. This proves Moss request behavior,
  not recognition quality, physical ring delivery or native capture.

Corrections made during verification:

- The app-map validator rejected a remediation reference on a non-prerequisite
  error. Removed that reference and retained inline recovery guidance; the
  integrity/contract checks passed afterward.
- Failed normal imports cannot be restarted. Corrected the plan, UI and app map
  to refer to subsequent requests, rather than promising a retry action.
- Live proof first exposed an incorrect module-card selector, then incomplete
  transcript-query bounds. Read the actual rendered control and complete schema,
  corrected the test, and observed the final run pass. Fresh signup and saved dark
  mode replaced the preliminary seeded sign-in/media-emulation coverage. No Moss
  responses were intercepted or rewritten, and no screenshot was captured.

Prerequisite CI recheck at `11336f180d197a6bdf46389feed1bb4ad8c27faa`:
Android, static, unit, all four integration shards, browser shard 1, compose and
Meeting link/draft checks passed. App-action job `120546109246` timed out after
five minutes installing browser dependencies. Browser shard 2 job `120546162702`
hit the five-minute install budget, then failed acquiring dpkg's frontend lock
held by apt-get. Their product test steps were skipped, and the aggregate CI gate
failed accordingly. These conclusions come from the downloaded job logs, not a
presumption about infrastructure. No unrelated CI changes were made.

The bounded language slice has live request-path proof. Task #3584 remains open:
custom vocabulary, additional automatic-processing controls, enhancement,
firmware and the preceding slices' device-verification limits remain deferred.
Keep this draft stacked and unmerged; do not treat this record as release proof for
the whole Android Hardware task.

## Independent review and merge mandate — 2026-10-23

Ben subsequently requested independent review of this PR and its prerequisites,
resolution of all findings, and merge in dependency order. The order is #3566 →
#3576 → #3586 → #3592 → #3594. Required checks and live-path evidence still apply.
This supersedes the earlier instruction to leave the stack unmerged. It does not
complete task #3584 or authorize a production deployment or new physical recordings.

Separate independent Standards and Spec reviewers examined #3594 at
`892b1458617df25f148d2a117a51a0e1703e77d5`; both reported zero findings.
They inspected the bounded language scope and its committed live evidence.

CI on that commit exposed three exact expectations omitted from the focused local
checks: the capture fixture's new `language: null` observation, the registry's new
`meetings.transcript_language` feature, and the integration lifecycle's new
`transcriptLanguage: null` default. Updated those expectations without weakening
their exact comparisons and added the minimal lifecycle suite to
`test:integration:3584`.

After correction, the two affected unit files passed **10 tests**, exit 0.
The isolated `test:integration:3584` gate passed **60 tests / 4 files**, exit 0,
receipt `vocci_meeting_preferences-20261023-104741`; its disposable server was
removed by the runner. The gate tested `892b1458617df25f148d2a117a51a0e1703e77d5`
with the recorded dirty correction inputs. These results do not replace CI on the
committed correction or reviews of the other PRs. No product code changed in this
correction.
