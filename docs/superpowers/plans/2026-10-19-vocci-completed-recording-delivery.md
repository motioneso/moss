# Vocci completed-recording delivery implementation

Task #3547; approved spec: `../specs/2026-10-19-vocci-completed-recording-delivery.md`.

Ben approved the first slice and Meetings destination in chat, then selected local
speech-to-text for overnight verification. No additional user credentials are needed.
Work only in the `feat/vocci-completed-delivery` worktree. Do not restart the held
proof instance or interfere with longer tests.

1. Add a bounded shared upload/status contract and pure legacy bundle validator:
   hashes, packet framing, filename pairing, WAV geometry, sidecar schema, bookmarks,
   and original-versus-decoded duration. Cover malformed and boundary cases.
2. Add module-owned owner-only storage, vault staging/lifecycle, immutable replay
   identity, and transactional job scheduling/recovery. Use canonical data/vault
   contexts and metadata-only jobs. Test real concurrent import and isolation paths.
3. Wire routes and transcription workers through public package interfaces. Extend
   transcript provenance for imported recordings, reuse configured transcription and
   transcript repositories, and keep the app map truthful.
4. Add the developer uploader, reading credentials from a private file and refusing
   redirects. Preserve source bytes and stable source-device identity across retries.
5. Run targeted tests and the isolated verification gate. For security assertions,
   record failing negative controls with protections deliberately removed.
6. Start an owned development instance and real local transcription service using
   claimed dev ports. Upload both already-captured recording modes; prove transcript
   access through the existing Meetings history UI using executable assertions.
   Keep personal audio, transcripts, and credentials outside git and logs.
7. Commit/push reviewable changes and update PR #3548 with actual evidence and any
   remaining limitations. No merge or Done claim without the required live proof.

Runtime state and private artifacts stay outside the repository. No live streaming,
Android onboarding, background retrieval, automatic task execution, or ring-file
deletion is included in this slice.
