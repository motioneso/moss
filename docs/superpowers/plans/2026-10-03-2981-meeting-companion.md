# Meeting companion implementation plan (#2981)

Approved design: [meeting companion](../specs/2026-10-03-meeting-companion.md).
Task: https://github.com/motioneso/moss/issues/2981 (part of #216).
Baseline: `12ff22bf0af2125f75eaf3b2b48363d95311fd1b`.

## Verified seams and decisions

- Shared wire contracts are exported from `packages/shared/src/index.ts:20–27`;
  meeting wire types belong in `packages/shared/src/meeting-api.ts`.
- Product logic belongs to its owning package, not shared
  (`docs/DEVELOPMENT_STANDARDS.md:315–324`). Create `packages/meetings` for
  deterministic lifecycle and transcript revision rules. Do not register a shipped
  module or add a navigation entry before a reachable product path exists.
- Existing ASR is raw audio to text only (`packages/ai/src/transcription-routes.ts:60–76`,
  `packages/shared/src/ai-api.ts:541–550`). Pins fail closed
  (`packages/ai/src/repository.ts:1201–1283`). Timestamp-aware and cancellable adapters
  are missing; they are a later owned AI seam, not assumed capabilities.
- Current HTTP adapter passes audio to its configured provider
  (`packages/ai/src/adapters/http-api.ts:127–160`). Existing timeout does not abort
  the upstream request (`packages/ai/src/transcription-routes.ts:137–146`).
- Companion identity resolves from its token, not body fields
  (`packages/auth/src/companion-devices.ts:95–131`). Existing credentials must NOT
  gain meeting access. A separately scoped owner/device authorization contract,
  issuance approval, revocation and upload limits are prerequisites to native ingest.
- Platform route composition precedents exist at `apps/api/src/companion-routes.ts:273–295`
  and `packages/module-registry/src/focus-wiring.ts:3–55`. They establish wiring
  patterns, not permission to reuse existing companion grants for meetings.
- New package-local tests are not automatically discovered (`vitest.config.ts:406–418`);
  put foundation tests under `tests/unit`.
- macOS capture compilation requires Xcode (`apps/trail-marker/README.md:7–13`).
  This Linux development environment cannot prove native capture on either target OS.

## Slice A: executable foundation (first draft PR checkpoint)

Add public capture, lifecycle, source/epoch, envelope, transcript and evidence contracts.
Implement pure transitions in the Meetings package: explicit readiness/start, pause,
resume with a new epoch, immutable stop cutoff, bounded pre-cutoff finalization,
no automatic scope broadening. Reject invalid chronology and incompatible sources.
Keep provider capabilities separate from source attribution and person attribution.
Implement stable segment revision acceptance, conflicting duplicate rejection, event
cursor handling and revision-pinned transcript snapshot selection for future chat.

Tests must distinguish no-op replay from conflicting duplicates; out-of-order from stale
updates; pause from transcription delay; terminal Stop from resumable Pause; source labels
from speaker identity. Test exact boundaries and invalid numeric input.

This slice has no runtime recording or data access and is not a usable feature. It makes
no RLS, secret-confinement or device-release claims. No app-map feature is declared until
real reachable behavior exists. Tests using generated data are unit evidence only.

## Slice B: first persisted owner-private path

Add Meetings-owned SQL, actor-scoped repositories, explicit route authorization and event
transport. Use `AccessContext` and `DataContextDb`; no admin read bypass. Implement source
and transcript persistence, optimistic revisions, notes, Stop, interrupted sessions and
bounded retention. Add integration tests through the isolated gate, including another owner
and admin denial. Observe protection tests fail when the protection is removed.

Prerequisites: isolated Postgres tooling and environment; database gate must run before
calling this slice verified. Current cloud environment has neither `psql` nor Docker.

## Slice C: real capture and transcript experience

Create separately approved meeting-device grants, native adapters and platform-specific
proof harnesses. Deliver the approved Setup/Live/Review/History screens using shared UI
primitives and real server records. Add app-map declarations in the same product PR.
Extend configured transcription with timestamps, bounded chunks, explicit capability
validation and cancellation. Never fake a connected companion or working native capture.

Prerequisites owned by the implementation: validated macOS/Windows route, supported builds,
exact output coverage and Moss exclusion; native development runners; signed distribution
before installability claims. Provider configuration and workplace audio use require their
own authorization. No persistent grants are issued by this plan.

Real-path UAT: owner signup → Settings → provider readiness → explicit source mode →
Start → transcript → Pause/Resume → Stop → Review, against real app data. Record bounded
assertions and network evidence, not staged screenshot proof. Native fixtures support tests
but do not replace Teams/Zoom and multi-remote-speaker acceptance.

## Subsequent slices (boundaries, not detailed implementation)

1. Explicit independent diarizer capability, tested stable speakers and uncertainty.
2. Existing shared chat context bound to owner/meeting/revision/cutoff, authorization at
   retrieval and release, evidence links and stale-version handling.
3. Grounded summaries and reviewed actions; Tasks public API with stable provenance.
4. Notes/VaultContext export with stable identity, conflict protection and separate write
   and index receipts; retention, recovery, deletion and pilot proof.

## Determinism and phase-one kill gate

All UI feedback comes from stored records. Meetings never injects turns into host chat.
Models have two language jobs: grounded summarization/action suggestions, and answering
explicit meeting questions from scoped evidence. Audio transcription/diarization are
separate typed processing capabilities. Model-derived changes require schemas, bounded
instructions with examples, validation and explicit per-item review before writing.

After the first real capture/transcript path, the product owner evaluates whether capture
scope is enforceable and transcript usefulness/latency meet the approved targets. If either
fails after a bounded documented correction, stop expanding summaries/exports and revisit
the native/provider route. Source-only delivery does not satisfy speaker separation.

## Verification

Expected exit code is 0 for each applicable command; keep exit codes unpiped:

- `pnpm exec vitest run tests/unit/meeting-*.test.ts`
- `pnpm exec eslint <changed TypeScript files> --max-warnings=0`
- `pnpm exec prettier --check <changed files>`
- `pnpm exec tsc --noEmit`
- `pnpm verify:static`
- Full DB gate only using `.claude/skills/verify-gate/SKILL.md` and `scripts/run-gate.sh`.
- Required CI on the exact published commit; real UI UAT and actual native OS proof remain
  independent gates. No merge/deployment is authorized.

## Rulings ledger

- Approved mockups define capture-focused Setup. Provider profiles remain solely under
  Settings → AI providers. Current captured source is not a speaker identity.
- No usable connected desktop or saved coding environment was available at kickoff. Public
  source was cloned on the development cloud computer without GitHub credentials.
- CodeGraph/codebase-memory and Herdr are unavailable here. Current source was read directly;
  this is a new isolated clone, not the user's shared checkout. Existing active PRs #2972,
  #2976 and #2860 must be considered before modifying their shared seams.
