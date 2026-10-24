# Bound ASR window-end drift for imported recordings

Task: [#3565](https://github.com/motioneso/moss/issues/3565). This repairs the
approved [companion specification](../specs/2026-10-20-vocci-companion-meetings-chat.md),
section 3, rather than adding a new recording capability.

## Evidence and seams

A real production recording failed in its second 30-second window before a phone
update. The first window committed. Replaying the retained second window through
the unchanged configured transcription service returned a final segment spanning
29,840–30,340 ms. Its positive duration and text were valid, but the window ends at
30,000 ms. The failure is reproducible without changing credentials or source bytes.
Private receipts contain timing/count metadata; private speech stays outside git.

- `recording-transcription-window.ts:9` reads hash-checked PCM and derives the exact
  window duration from the retained WAV, independently of provider timestamps.
- `recording-transcription-window.ts:58` rejects every segment beyond that duration.
- `recording-window-service.ts:106` validates before offsetting/persisting segments,
  advancing the checkpoint or admitting a final voice request/summary.
- `capture-processing.ts:11` already normalizes a bounded trailing timestamp excess
  for live capture. Its 100 ms allowance does not cover the observed 340 ms excess.
  Live capture is a separate contract and will remain unchanged.
- `tests/integration/meeting-recording-uploads.test.ts:77` supplies the real import,
  chunk, window, checkpoint and transcript machinery with an injectable ASR port.

## Decision

Normalize only trailing end timestamps up to 500 ms beyond an imported window.
The half-second bound covers the measured 340 ms excess with a small explicit
margin. Preserve starts and text, reject segments starting outside the audio,
reversed/noninteger/negative intervals, larger excess and existing output-budget
violations. Never mutate the provider array. Persist only normalized timestamps.

Keep this in the recording window seam. Changing the shared provider adapter would
also alter live capture and other transcription consumers with different contracts.
Allowing arbitrary drift would hide a mismatched response; keeping strict equality
continues rejecting the measured real response. Neither is appropriate for this fix.

No provider/model selection, source bytes, destination identity, transcript editing,
schema, prompt, UI or credential changes. ASR supplies text and estimated times;
the retained audio defines the deterministic bounds and existing stored records
continue to drive progress/feedback.

## Implementation and verification

1. Commit this bounded plan before code. Add a regression at the real import
   service seam; observe the current implementation reject the measured timing
   pattern. Run DB tests only through the isolated verify-gate procedure.
2. Return normalized segments from `normalizeWindowTranscript`, consume that return
   in both Meeting and voice window paths, and update the owning app-map feature.
   Cover the 500/501 ms boundary, invalid starts/data, short final windows, unchanged
   input, checkpoint offsets and exactly one final summary.
3. Run focused unit tests, isolated recording-upload integration and full static
   checks, each unpiped and requiring exit 0. Replay the actual retained window
   against the candidate helper and assert all persisted intervals fit its PCM.
4. Exercise the real Meeting UI on a disposable live instance with genuine ASR
   before merge; disclose generated audio separately from physical source evidence.
   Obtain independent Standards and Spec reviews on the final commit, resolve
   findings and require green CI before merging.
5. After verified image publication, deploy through the existing coordinated
   backup/image-only procedure. Repair only the identified retained failed import
   with guarded operational recovery, then verify its complete transcript, same
   Meeting identity and summary through the real production UI.

Kill gate: if the measured response still fails after this bounded normalization,
or another response needs more than 500 ms, keep the PR unmerged and investigate
with exact timing evidence. The implementing agent owns that decision. Do not
weaken source integrity or claim interrupted upload proof from an already uploaded
recording.
