# Meeting audio enhancement

Status: DRAFT, awaiting Ben's ruling on the open questions below. Part of #3584 item 4.
No code is written until this spec and its mockups are approved.

## Source rule

#3584 item 4: audio enhancement belongs with Meeting audio tools, original preservation
is defined before it runs, and AI stays provider agnostic. The Hardware settings spec
and the 2026-10-23 handoff add that it is never a ring control and never overwrites
an original.

## What exists today

- A Meeting recording is retained in the owner's vault as a validated bundle holding the
  decoded WAV, and its fingerprint is checked before every transcription.
- Transcription reads that WAV with the owner's shared transcript language and
  vocabulary, through the configured transcription route.
- Retained transcripts are never rewritten to demonstrate a setting.
- No code path today changes audio. There is no audio-processing capability in the
  model router and no audio tooling in the server image.

## Proposal

Enhancement is an explicit, per-Meeting action on a Meeting that has retained audio.
It never runs automatically and has no ring or Android control.

1. **Original is immutable.** The retained WAV and its fingerprint are never replaced,
   re-encoded or deleted by enhancement. Deleting the Meeting deletes both.
2. **Output is a separate derived file.** Stored next to the original in the owner's
   vault with its own fingerprint, the source fingerprint it came from, the capability
   that produced it, and a timestamp. Vault access goes through `VaultContext`.
3. **Transcript stays on the original.** Existing transcripts are not touched. A user may
   choose "Transcribe the enhanced audio", which creates a new transcript revision
   labelled with its audio source. The old revision stays.
4. **Provider agnostic.** The feature asks for an `audio.enhance` capability. The router
   picks the user's configured provider. No provider or model name appears in code.
   With no provider offering the capability, the action is hidden and Settings says
   enhancement is unavailable. Nothing is faked locally.
5. **Privacy.** Enhancement sends the Meeting audio to the provider, so the first use
   shows the same send-to-provider notice transcription uses. Job payloads carry IDs
   only. Audio and credentials never enter logs or job payloads.
6. **Failure is safe.** A failed or cancelled run leaves the original and any earlier
   enhanced file as they were, and shows the reason plainly.

## Screen

One change to the existing Meeting record screen. An "Audio" row under the transcript
holds Original (play), Enhanced (play, once it exists), and an "Enhance audio" button
with progress and error states. Mockups for desktop and phone, light and dark, are
required here before build and are not yet drawn.

## App map

New feature entry in the Meetings manifest, a settings or navigation note only if the
agreed design adds one, and the error and remediation text for "no provider offers
enhancement". Updated in the same PR as the code.

## Open questions for Ben

1. Does "enhancement" mean noise reduction and clearer speech (audio in, audio out), or
   something else such as better transcripts?
2. Is a provider-served `audio.enhance` capability acceptable even though none of the
   current providers offer one, so the feature would ship dark until one does? The
   alternative is bundling a local audio tool (for example ffmpeg filters) in the server
   image, which is not provider-based.
3. Should enhanced audio be offered for transcription, or play-only?
4. Per-Meeting button only, or also an optional "enhance new recordings" preference?

## Verification

Original bytes and fingerprint identical after success, failure and cancel. Enhanced
file carries its source fingerprint. No-capability state hides the action. A live run on
a real Meeting through the real UI, with the phone-sourced Meeting as one case.
