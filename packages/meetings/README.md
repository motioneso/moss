# Meetings development checkpoint

Issue [#2981](https://github.com/motioneso/moss/issues/2981), approved
[design](../../docs/superpowers/specs/2026-10-03-meeting-companion.md) and
[plan](../../docs/superpowers/plans/2026-10-03-2981-meeting-companion.md).

This package is not yet a meeting recorder. The current checkpoint contains:

- A package-owned `/meetings` screen for Setup, draft history and personal notes.
- Explicit capture-mode defaults; Start remains unavailable until native capture exists.
- Real draft creation, reopening, version-checked notes, conflict review and confirmed deletion.
- In-memory unsaved-note recovery across signed-in navigation; save before closing/signing out.
- Pure capture/lifecycle/send-eligibility and transcript-revision/evidence rules for later wiring.

The AI-owned clip transcription API separately supports an explicit timestamp request and
cancellation. That adapter is not yet wired to meeting capture or a persisted meeting transcript.
There is no claimed streaming, speaker separation, summary, Tasks, vault export or meeting-chat
implementation in this checkpoint. Setup links to existing AI providers configuration and does
not present an unvalidated meeting profile as ready.

## Draft API

All routes use the existing general-session resolver and actor-scoped data context. They do not
start capture, contact a provider, or create/expand companion grants.

- `POST /api/meetings/records`: `{ requestKey, title }`; a UUID request key makes creation retryable.
- `GET /api/meetings/records`: optional `limit` (1–100), plus paired `beforeId` and
  `beforeCreatedAt` cursor fields.
- `GET /api/meetings/records/:id`: read the current draft and personal notes.
- `PUT /api/meetings/records/:id/notes`: `{ requestKey, expectedRevision, personalNotes }`.
  Notes start at revision zero. A stale version returns a conflict and current notes. Reusing a
  key with identical input returns the original saved snapshot, even after later edits; fetch
  the record again for its current version. Reusing a key with different input conflicts.
- `DELETE /api/meetings/records/:id`: permanently remove the owner's draft and cascading note
  receipts. Repeated and inaccessible deletion requests return the same 204 response. The UI
  requires confirmation and explains that saved notes and unsaved edits will be lost.
- `GET` / `PUT /api/meetings/preferences`: `{ defaultCaptureMode }`, where the value is
  `microphone-only`, `selected-app`, `computer-audio`, or `null` to clear the explicit default.
  Reading preferences never creates a default, and choosing a mode alone does not save it.

Titles are at most 240 UTF-8 bytes; notes at most 64,000 UTF-8 bytes. Draft titles are immutable
at this checkpoint. A stored draft is not evidence that capture occurred. Migration 0260 defines
the records and receipts; 0261 separately grants owner-policy-governed draft deletion.

Meetings is optional but default-enabled, as required by the repository's deny-only built-in
module model. Existing module controls can disable it. This does not start any recording.

## Local verification

Use a separate checkout/worktree if another agent is editing your local tree. Read the
repository's `shared-checkout` and `verify-gate` skills. Use the pinned pnpm version and run
`pnpm install --frozen-lockfile`.

Focused checks (expected exit 0):

```sh
pnpm test:unit tests/unit/meeting-api-schema.test.ts tests/unit/meeting-lifecycle.test.ts tests/unit/meeting-transcript.test.ts tests/unit/meeting-record-routes.test.ts tests/unit/meeting-preferences-routes.test.ts tests/unit/meeting-manifest.test.ts tests/unit/meeting-web.test.tsx tests/unit/meeting-web-interaction.test.tsx tests/unit/ai-transcription-routes.test.ts tests/unit/ai-transcription-timestamps.test.ts
pnpm verify:static
```

Full isolated database gate (expected exit 0):

```sh
scripts/run-gate.sh start
scripts/run-gate.sh wait --follow
```

Real UI acceptance uses the existing UAT harness and its own disposable fixture, without
rewriting network responses. The dedicated Meetings wrapper points the harness at an absent
auth file in a fresh temporary directory, so this draft-only test does not read or copy the
host’s real chat login. Use this wrapper rather than invoking the general UAT command directly. Through the supported gate wrapper:

```sh
scripts/run-gate.sh start --gate test:uat:2981-meetings
scripts/run-gate.sh wait --follow
```

Do not hand-run database reset/migration/integration commands against the shared development
database. The cloud development workspace has no Docker/Postgres stack, so local DB/UAT commands
could not run there. Exact CI results, commits and remaining blockers are on PR #2982.

## Remaining release proof

Database tests cover owner/admin isolation, idempotency, concurrent notes, rollback and cascading
receipts. Required protection-removal negative proof for database isolation remains outstanding.
UI component tests or fixture screenshots are not real-path acceptance. Run the real UI UAT above
and record its result before claiming the draft workspace verified end-to-end.

The Linux checks cannot prove macOS/Windows audio routes, permissions, device release, Teams/Zoom
compatibility, provider handling, diarization, live/post-meeting chat context or capture latency.
These remain separate implementation and live-proof requirements before the meeting recorder is
ready. Do not use real workplace audio before its separate policy and provider authorization.
