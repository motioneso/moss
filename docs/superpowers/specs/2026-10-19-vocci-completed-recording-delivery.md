# Vocci completed-recording delivery — first slice

Status: **Approved by Ben in chat, 2026-10-19.** Meetings is the initial destination;
use a local transcription server for verification and continue overnight. Preserve
the separately running longer tests and the reserved proof instance.

Build task: [#3547](https://github.com/motioneso/moss/issues/3547).

## Outcome and scope

Prove that a completed Vocci recording reaches Moss, is retained with its source
metadata, and produces a transcript using the person's configured transcription
model. Start with a developer uploader and the already-validated Android probe
captures. This slice proves the receiving path; it does not ship automatic Android
delivery or consumer onboarding.

The proposed destination is an imported record in the existing Meetings history.
Both normal recordings and hold-button voice requests are retained there. A voice
request is a recording classification, not permission to create a task or execute
an instruction. Approval of this spec includes approval of that initial destination.

No new screen ships in this slice. The existing history and transcript views are
the review surface. Dedicated ring setup, recording inbox design, and request
execution require subsequent design work.

## Grounding

The Vocci research handoff and authentication validation report document fresh
session authentication and independent retrieval on the tested legacy ring. Both
normal and hold recordings decode as 16 kHz mono; JSON sidecars retain bookmarks.
This is reported hardware evidence, not a test repeated for this proposal.

Current Moss code provides:

- `packages/shared/src/companion-api.ts`: device pairing is explicitly `macos` and
  branded for Trail Marker. Do not label an Android client as a Mac to use it.
- `packages/meetings/src/capture-domain.ts` and `capture-service.ts`: live capture
  uses grants, leases, source inventories, generations, and epochs. A completed
  ring file must not fabricate a live capture session.
- `packages/ai/src/configured-transcription.ts`: exported configured transcription
  with timestamped results and explicit dispatch admission.
- `packages/meetings/src/repository.ts` and `transcript-repository.ts`: record and
  transcript persistence under the normal actor-scoped database context.

Graph discovery located transcription and companion entry points, but queries for
the capture package were incomplete; the paths above were also read directly.

## Proposed flow

```text
Android probe capture
  -> developer exporter: original packet file + raw sidecar + decoded WAV
  -> authenticated Moss import
  -> retained source bundle and imported meeting record
  -> configured transcription job
  -> existing transcript history
```

The developer uploader reads an existing authenticated Moss API credential from a
private file, never from a command-line value. It uses only the normal authenticated
user route; existing companion credentials gain no access. Confirm the selected
credential kind against the current general access resolver during implementation.
No Vocci binding key, Vocci account token, or device MAC is part of this bundle.

The exporter consumes local captured files and does not connect to the ring,
disable Vocci, change ownership, delete recordings, or send sync acknowledgements.
It may reuse the research decoder as an external development tool; the Moss server
must not import research-workspace files or depend on a local research path.

## Receiving contract

Add `POST /api/meetings/recording-imports` and
`GET /api/meetings/recording-imports/:id` behind the existing Meetings availability
and authenticated user checks. Add contracts in a focused shared wire-contract
file, exported through `@moss/shared`.

The version-1 upload contains:

- A persisted opaque `sourceDeviceId` UUID, and the ring's original `recordingId`.
  The uploader retains its source UUID between runs. This is supplied provenance,
  not proof of ring ownership or hardware attestation.
- The original packet-file name and bytes, their SHA-256, and the original JSON
  sidecar name, bytes, and SHA-256. Preserve sidecar bytes exactly; parse a separate
  copy. Accept only expected legacy filename pairs and never use supplied names
  as filesystem paths.
- A decoded 16 kHz, mono, signed-16-bit PCM WAV and its SHA-256. The source packet
  file is a legacy Vocci container, not an Ogg Opus file.

Use bounded JSON/base64 for this short-recording proof rather than a general upload
framework. Proposed limits: 8 MiB total request body, 1 MiB source packet file,
64 KiB sidecar, 4 MiB WAV, and 120 seconds of decoded audio. Larger recordings get
413 and remain local. Base64 decoding must reject malformed input. A later slice
must design resumable large-recording delivery rather than silently raising limits.

The server recomputes all hashes, validates WAV geometry and duration, and validates
legacy packet boundaries and sequence continuity. It does not independently decode
Opus in this slice, so it must not claim the uploaded WAV is cryptographically proven
to correspond to the packet file. Exporter tests establish correspondence for the
known decoding path; the server treats WAV audio as authenticated user-supplied input.

Derive normal versus `voice-request` mode from the validated recording name;
`amsg_` identifies a hold recording. Preserve unknown sidecar fields in the raw
bytes. Normalize recognized bookmark offsets to milliseconds using the documented
legacy schema; reject non-finite or out-of-range offsets, and retain recording time
from the source separately from receipt time. Do not invent timestamps from filenames
without a verified mapping. Preserve sidecar duration separately from decoded
duration; minor recorded-duration rounding must not silently change audio length.

## Identity, state, and recovery

The unique source identity is `(owner, sourceDeviceId, recordingId)`. Store an
immutable fingerprint of the canonical manifest and all three recomputed file
hashes. Identical retries return the existing import and meeting ID. Changed input
for an existing source identity returns 409; it never overwrites old evidence.
Concurrent identical uploads must create one import and one meeting record.

Return 202 when a new import is durably accepted and 200 for an identical replay.
The response names the import ID, meeting ID, and current processing state. A 2xx
acceptance is not a claim that transcription finished. Status exposes `queued`,
`transcribing`, `complete`, or `failed`, with a finite error code and retryability;
it does not return raw sidecar bytes, audio bytes, credentials, or provider errors.

Persist upload acceptance before scheduling transcription. Use metadata-only jobs
containing actor and import IDs. Add a bounded recovery sweep for accepted imports
whose enqueue or worker attempt was interrupted. Stable import IDs and transactional
transcript commits prevent duplicate transcript revisions after a worker restart.
Provider calls can repeat after a crash before commit; do not promise exactly-once
provider billing or execution.

A retryable failure uses bounded attempts and backoff. Missing configuration,
revoked access, module disablement, or exhausted retries leaves a visible failed
import without deleting its retained bundle. A replayed upload does not reset the
retry counter. Transcription dispatch rechecks current access and configuration;
do not copy the live-capture authorization rules without establishing import-specific
admission. No request text is executed automatically.

## Ownership and package boundaries

Keep import orchestration, repository, migration, routes, and worker registration
inside `@moss/meetings`, with public exports for composition-root wiring. Use the
existing AI public API for transcription, rather than selecting a fixed provider
or duplicating credential handling. Do not add Vocci branches to live capture.

Add a module-owned import table linked to its meeting record. All access uses
`AccessContext`, `withDataContext`, and owner-only RLS, including admins. Retain
original files and derived WAV using `VaultContext`; database rows contain opaque
vault references, hashes, normalized bookmarks, mode, and processing metadata.
The implementation must establish and test staging/compensation for interrupted
vault writes, and orphan cleanup after abandoned uploads. Account export and
deletion, meeting deletion, and retention cleanup must include the new artifacts.

The job reads audio under the owner's current context, invokes configured
transcription, and writes timestamped segments through the Meetings transcript
repository. Extend source provenance explicitly for imported recordings; do not
pretend the ring was a live microphone. Preserve offsets relative to the full
recording, including if future transport splits audio into clips.

Update the Meetings manifest/app map to describe imported completed recordings,
requirements, limits, and recoverable errors. Do not advertise Android onboarding,
background sync, bookmark UI, or request execution before those exist. Normalized
bookmarks remain retained metadata in this slice; no new bookmark screen is promised.

## Verification and completion

Before implementation tests, search project conventions and use the repository's
`verify-gate` skill for any database-touching command. Do not touch the separately
running longer tests or the live development database.

Required checks cover:

1. Synthetic normal and hold bundles: mode, raw-sidecar preservation, bookmarks,
   recorded versus decoded duration, hashes, malformed packet framing and WAV,
   bad base64, mismatched file pairs, and every size limit.
2. Concurrent replay and conflict: one import/record/transcript, unchanged evidence,
   owner isolation, unauthorized credential kinds, and owner-derived identity.
3. Failed enqueue, interrupted worker, provider error, changed configuration,
   revoked access, bounded retry exhaustion, and status after process restart.
4. Deletion/export and abandoned-write cleanup through real database/vault paths.
5. A developer uploader exercising the real receiver with existing validated normal
   and hold captures. Keep personal recordings and their transcripts out of git,
   PR bodies, job payloads, and logs. Retain only redacted counts/status evidence.
6. Existing Meetings UI on a live dev instance: the owner reaches the imported
   record through history and reads its transcript. Record executable assertions
   and bounded evidence on the PR. Mark code-complete, unverified if that assembled
   path cannot be exercised; do not merge or call the feature done.

Run the relevant lint, formatting, file-size, type, and targeted test checks, plus
the isolated required gate. Security-property assertions need the repository's
required failing-with-protection-removed evidence.

## Follow-on work

After this slice proves delivery, design the Android client and its explicit Moss
authorization, secure retained ring keys with Android Keystore, and implement
completed-file retrieval with a durable local queue. Consumer sign-in/key recovery,
Vocci connection handoff, disconnect/reboot behavior, background reliability,
large-file delivery, and user-facing ring setup remain separate work. Package
disabling and manual credentials are diagnostic tools, not consumer onboarding.

Live streaming, fresh ring ownership provisioning, iOS, other firmware variants,
automatic request execution, and source-file deletion are outside this slice.
