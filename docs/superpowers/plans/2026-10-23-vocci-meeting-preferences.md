# Shared Meeting transcript language — group 4

Approved scope: `docs/superpowers/specs/2026-10-23-android-hardware-settings.md`.
Task #3584 stays open. Work in `~/Jarv1s/.claude/worktrees/vocci-meeting-preferences`,
branch `feat/vocci-meeting-preferences`, stacked on `feat/vocci-recording-management`
(draft #3592), then #3586, #3576 and guided setup #3566. No merge or deployment.

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
standard parameter. Rejection is a visible existing transcription failure; never
silently retry without the hint or change providers. A service silently ignoring a
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
   app-map tests (expected 0). Run DB checks only via `scripts/run-gate.sh start
--gate <script>` and its detached wait procedure; expected exit 0. Commands are
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
