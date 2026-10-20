# Vocci automatic delivery implementation plan

Spec: `../specs/2026-10-20-vocci-automatic-delivery.md`. Task #3550, part of #3547.
Scope authorized by Ben's boot brief/handoff; consumer design is not approved.

## Seams checked before implementation

- Normal owner auth: `packages/auth/src/index.ts:454` resolves cookie sessions and
  rejects inactive owners. Companion resolution is separate; no Android app exists.
- Receiver: `packages/meetings/src/recording-import-routes.ts:14` authenticated POST;
  `:39` status. `packages/shared/src/meeting-recording-import-api.ts:8` wire contract.
- Immutable dedup/publication: `packages/meetings/src/recording-import-service.ts:57`
  identity lock; `:63` fingerprint conflict; `:83` vault publication; `:90` scheduling.
- Configured transcription: same service `:115` owns processing. Existing Meetings
  history/transcript and manifest own the destination. No server pipeline changes.
- Validated ring handshake/transport is research reference, not a Moss dependency.
  Port the small protocol/auth logic into the client, with provenance and tests.
- SDK/JDK and an authorized Android phone are available locally. Retained probe
  credential availability verified without exposing its contents.

## Phase 1 — one installed vertical slice

1. Add `apps/vocci-delivery/{AndroidManifest.xml,build.sh,README.md}` and focused
   `src/ai/moss/vocci` classes: `RingAuth`, `RingProtocol`, `RingConnection`,
   `SecretStore`, `DeliveryStore`, `OpusWav`, `MossClient`, `DeliveryService`,
   `DeliveryActivity`. Use explicit allowlisted read operations. Keep every file
   bounded and separate protocol, storage and orchestration responsibilities.
2. Contracts: `RingConnection.retrieve(Config, DeliveryStore)` returns complete
   source pairs only; `OpusWav.decode(byte[])` produces canonical WAV;
   `MossClient.accept(JSONObject)` returns the shared status shape;
   `DeliveryStore` atomically owns source UUID, frozen bundles, retry state and IDs.
   Credential config pins ring serial/device ID, owner and origin. No backend DDL.
3. Add host protocol/auth tests and device instrumentation assertions. Tests must
   catch wrong device proofs, corrupt/split frames, wrong filenames/size/end state,
   incomplete files, gaps, mutable retries, account switching and attempt exhaustion.
   Device tests cover Keystore tampering and actual platform decoding. Record
   protection-removed negative controls for security assertions.
4. Add a reproducible private-input installed proof driver; extend existing live
   gate only as needed to invoke Android instead of the host uploader. Claim ports
   with devports and restore only phone state/resources touched by this run.
   Exercise interruption/restart and screen-off, plus both modes/history UI.
5. Update Meetings app-map declaration, usage docs and PR release note. Commit/push
   code; open draft PR with actual evidence and limitations; do not deploy production.

Rejected alternative: extending the research diagnostic APK is faster initially,
with proven handshake code, but would leave Moss dependent on an external workspace,
raw diagnostic storage and activity-bound execution. Port verified read-only
protocol primitives into a repo-owned foreground client instead. Extending Trail
Marker's macOS companion auth would falsely label the platform and broaden an
unrelated capability; use the receiver's existing general session auth for this
explicit developer slice. Consumer device auth is deferred to its own design.

## Determinism boundary

All notification/status feedback derives from durable local/server records. The
client never injects chat turns. The model has only two existing server jobs:
transcribe the supplied audio and return timestamped segments. It receives no new
prompts, control authority or model-authored configuration in this slice.

## Verification

Expected exit 0 for each unpiped command:

- `apps/vocci-delivery/test.sh` — host protocol/state tests and SDK APK/signature build.
- `pnpm lint`, `pnpm format:check`, `pnpm check:file-size`, `pnpm typecheck`.
- `scripts/run-gate.sh start --gate test:recording-imports`, then
  `scripts/run-gate.sh wait --follow` — isolated receiver regressions.
- `scripts/run-gate.sh start --gate test:recording-live`, then
  `scripts/run-gate.sh wait --follow` with private Android browser proof driver —
  real installed ring → Android → Moss → local inference → Meetings history.
- Device instrumentation command documented in client README — crypto/codec/store.

Kill gate: if the installed client cannot authenticate without destructive changes,
or a permission handoff fails to stop competing reconnects, or no bounded platform
decoding path produces valid audio, the implementing agent stops that line and
records the blocker. Ben owns any expansion to consumer setup/new auth/transport.
No phase 2 implementation is planned before phase 1 live acceptance.

## Rulings ledger

- Receiver independent review: 14-day queue retention fixed before #3548 merge.
  Interrupted receiver publication can leave a visible permanent failure; replay
  never resets it. Client must show that state, not invent a new source identity.
- Existing-key recovery is already complete. Do not repeat sign-in while its
  retained credential remains valid. Production storage requires Android Keystore.
- Official app force-stop alone is insufficient (reconnect services relaunch it).
  Developer permission handoff must be tested, and restored after validation.
