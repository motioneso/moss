# Meetings development foundation

Issue [#2981](https://github.com/motioneso/moss/issues/2981), approved
[design](../../docs/superpowers/specs/2026-10-03-meeting-companion.md) and
[plan](../../docs/superpowers/plans/2026-10-03-2981-meeting-companion.md).

This package is the first development checkpoint, not a meeting recorder. It contains:

- Explicit capture selections and pure lifecycle/send-eligibility rules.
- Stable transcript revisions, bounded snapshots and revision-pinned evidence.
- Optional meeting draft storage and personal notes API.

The database migration and repository are designed for owner-scoped access. Database isolation
and rollback/concurrency tests are written but have not run in the cloud development environment;
do not treat the design as verified privacy evidence. The new routes use the existing general-session resolver; this checkpoint adds no companion grants.

## Draft API

In a development instance, the API uses the signed-in user's normal
session and data context. It does not start capture or send audio/text to a provider.

- `POST /api/meetings/records`: `{ requestKey, title }`; a UUID request key makes creation retryable.
- `GET /api/meetings/records`: optional bounded `limit`, plus paired `beforeId` and
  `beforeCreatedAt` cursor fields.
- `GET /api/meetings/records/:id`: read the current draft and personal notes.
- `PUT /api/meetings/records/:id/notes`: `{ requestKey, expectedRevision, personalNotes }`.
  Notes start at revision zero. A stale version returns a conflict and current notes. Reusing a
  key with the same input returns the original saved snapshot, even after later edits; fetch
  the record again to obtain its current version. Reusing a key with different input conflicts.

Titles are at most 240 UTF-8 bytes and notes at most 64,000 UTF-8 bytes. Draft titles are immutable
at this checkpoint. No recording status is inferred from a stored record. No transcript, audio,
summary, Task or vault artifact is stored by these endpoints. No delete route is included yet;
use only disposable development data until lifecycle and deletion UI are implemented.

## Verification still needed

Run the repository's isolated verify-gate procedure for database tests, including
`tests/integration/meeting-records.test.ts`. Record a failing isolation test with its protection
removed before claiming the property, as required by the development standards.

The Linux unit tests cannot prove macOS/Windows audio routes, source permissions, device release,
Teams/Zoom compatibility, diarization quality, provider pin enforcement or real UI behavior.
These remain separate implementation and live-proof requirements before release.

The built-in module compatibility gate uses deny-only enablement and requires
`defaultEnabled: true`. Meetings therefore registers as an optional, default-enabled draft
API and can be disabled through the existing module controls. This does not start capture,
contact providers, or add a recording UI. This repository compatibility rule was verified
in `packages/module-registry/src/compat-gate.ts`; a default-disabled built-in would prevent
application startup and must not be used.
