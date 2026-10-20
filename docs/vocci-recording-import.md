# Completed Vocci recordings (developer proof)

This slice imports files already retrieved with the diagnostic probe. It does not
connect to a ring, recover credentials, provision ownership, retrieve files in the
background, or delete source recordings. Imported hold-button recordings are
classified as voice requests; they never execute instructions or create Tasks.

Enable Meetings and configure Voice (speech-to-text) in Settings → AI providers.
The endpoint must support OpenAI-compatible timestamped audio transcription. The
server uses that configuration rather than selecting a fixed provider or model.

Create an owner-only JSON credential file containing a normal authenticated Moss
session cookie, for example `{"cookie":"<session cookie>"}`. Never put its contents
in a command argument or in the repository. Companion-device credentials cannot
authenticate the import route. Use HTTPS remotely; HTTP is allowed only on loopback.

From `~/Jarv1s`, with locally retrieved packets, sidecar and decoded WAV:

```bash
python3 scripts/upload-vocci-recording.py \
  --url https://your-moss.example \
  --session-file ~/.config/moss/import-session.json \
  --source-state ~/.local/state/moss/vocci-import/device.json \
  --recording-id 1792470000_mono \
  --packets /private/captures/recording.opus.raw \
  --sidecar /private/captures/recording.json \
  --wav /private/captures/recording.wav \
  --wait
```

Keep one source-state file per physical ring and retain it across retries. Its UUID
is supplied provenance, not hardware attestation. `recording-id` is the original
ring filename without its extension, including `amsg_` for hold recordings.

The uploader canonicalizes an already-decoded PCM WAV; it does not decode Opus.
The server checks hashes, base64, filename pairing, packet lengths and continuity,
canonical 16 kHz mono PCM geometry, duration and recognized sidecar metadata. It
does not independently prove that the WAV was decoded from the supplied packets.
Original packets and sidecar bytes are retained exactly. Unknown sidecar fields
remain in those original bytes. Bookmarks are stored as millisecond offsets.

Limits: request 8 MiB, packets 1 MiB, sidecar 64 KiB, canonical WAV 3,840,044 bytes
(120 seconds). Larger recordings remain local. No resumable transfer is provided.

The import returns 202 after durable publication and transactional scheduling;
identical replays return 200 with the same import and meeting IDs. Changed evidence
for the same owner/device/recording returns 409. Query
`GET /api/meetings/recording-imports/:id` for `queued`, `transcribing`, `complete`
or `failed`. A replay does not reset a failed attempt. Transient processing gets
at most three attempts; provider calls may repeat after an interruption.
With `--wait`, the uploader exits 2 if its ten-minute wait expires while processing
is still pending, and 1 for a failed import. The printed status remains inspectable.

Completed transcripts appear in existing Meetings history with an imported-recording
source label. Source bundles are included in account export. Meeting deletion queues
vault cleanup atomically; account deletion removes the owner's private vault. An
abandoned publication is cleaned by a durable delayed job. No new bookmark UI ships.

Database tests run only through the isolated gate:

```bash
scripts/run-gate.sh start --gate test:recording-imports
scripts/run-gate.sh wait --follow
```

Live proof uses `test:recording-live` through the same gate, a warmed local STT
server on a claimed development port, and a private browser script supplied through
`VOCCI_LIVE_BROWSER_SCRIPT`. The script must create an owner through the real UI,
configure Voice in Settings, run the developer uploader with both local captures,
then open their transcripts through Meetings history. Keep browser credentials,
audio and transcript text outside git and public logs. CI/parts tests alone do not
replace that assembled live proof.
