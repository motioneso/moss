# Ring thin-piece retry — #3745

Approved scope: the bug fix chosen in issue #3745 and the boot brief. No denoising or legacy one-shot import changes.

## Existing seams

- `packages/meetings/src/recording-window-service.ts:77`: validated canonical window audio already in memory.
- `packages/meetings/src/recording-window-service.ts:93`: provider-neutral request with dispatch admission, availability checks and a per-call timeout.
- `packages/meetings/src/recording-transcription-window.ts:56`: bounded provider timestamps.
- `tests/integration/meeting-recording-uploads.test.ts:94`: metadata-only jobs and resumable upload fixture.

## One bounded implementation phase

1. Extend `tests/unit/meeting-recording-window.test.ts` first: loud/thin retries once, silence/full skip, richer wins, weaker/tied loses, overlap counted once, blank text ignored, half timestamps bounded/offset, short tail, request rejection propagation. Observe failure before production edits.
2. Add `transcribeWindowWithRetry(audio: Buffer, durationMs: number, transcribe: (audio: Buffer) => Promise<{ segments: readonly { startMs: number; endMs: number; text: string }[] }>)` to the window helper. Normalize first; retry only below 25% unique nonblank segment coverage and at least -35 dBFS RMS. These simple thresholds catch premature stops in clearly audible audio. Split at 15 seconds (midpoint for a shorter final piece), rebuild WAV lengths, transcribe halves sequentially, normalize each and offset the second. Compare unique covered duration, keeping the original on ties. Enforce existing combined output budgets.
3. Call the helper through the existing provider callback, so options, route, fresh timeout and dispatch admission apply to all three requests. Keep checkpoints, resume and payloads unchanged.
4. Add integration coverage through upload/process for meetings, no-meeting voice requests, original checkpoint grid and stale dispatch rejection. Update resumable-recording app-map description.

The model only transcribes audio through the existing configured capability; deterministic code chooses the result and persists normal records. No prompt/UI change.

## Verification and finish

Expected exit 0: `pnpm test:unit tests/unit/meeting-recording-window.test.ts tests/unit/meeting-manifest.test.ts`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`.

Database tests only via `scripts/run-gate.sh start --gate test:integration:ring-hold`, then `scripts/run-gate.sh wait --follow` with its actual exit code preserved.

Kill gate: if split coverage does not recover actual noisy speech, coordinator decides after hosted-provider live proof; local fixtures do not establish ASR quality. Live proof and independent review belong to vocci-coordinator per the boot brief. Push a PR closing #3745 with Category Fixed, report code-complete/unverified pending that proof, do not merge.
