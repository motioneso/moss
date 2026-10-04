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

## First code checkpoint (3 October 2026)

Slice A now contains executable lifecycle/send-eligibility and transcript-revision code.
Independent review found that changing a source ID could bypass transcript epoch chronology;
that finding was corrected with switched-source regression cases. This is a domain foundation,
not an actual recording controller or a claim that native devices have been stopped.

The initial persistence checkpoint adds an optional Meetings module with
browser-authenticated draft-record endpoints: create, list, read, and versioned personal-note
writes. It does not add a navigation item, enable recording, or widen companion grants.
The manifest's feature/error declarations describe only this implemented draft API.
Owner-scoped repository types, migration 0260, and isolated integration tests are present;
privacy/isolation claims remain unverified until the database tests and protection-removal
negative proof actually run.

This narrows Slice B's first checkpoint to draft identity and notes. Persisted lifecycle,
transcript events, separate meeting-device authorization and native ingest still follow.
Do not present a draft record as evidence that a capture occurred.

Local verification status and exact commit evidence are recorded on draft PR #2982. The
supported database launch failed with exit 4 because the expected development Postgres
container is absent. The user will pull the branch into their existing local development
environment; no desktop connection or new environment setup is required for that workflow.
Native macOS/Windows capture and real UI live-path proof have not run.

### Local continuation

Use a separate checkout or worktree if another agent is actively editing the local tree.
Read the repository's shared-checkout and verify-gate skills before Git tree changes or any
DB-touching command. Use the project-pinned pnpm version and its frozen lockfile.

- Branch: `feat/2981-meeting-companion`
- Focused tests: `pnpm test:unit tests/unit/meeting-api-schema.test.ts tests/unit/meeting-lifecycle.test.ts tests/unit/meeting-transcript.test.ts tests/unit/meeting-record-routes.test.ts`
- Full isolated gate: `scripts/run-gate.sh start`, then `scripts/run-gate.sh wait --follow`.
- Integration suite `tests/integration/meeting-records.test.ts` is included in the normal
  integration gate through registry migration discovery.
- Do not run migrations/tests against a shared/live database by hand. No native capture or
  provider test should use real workplace audio before its separate approval.

The built-in module compatibility gate uses deny-only enablement and requires
`defaultEnabled: true`. Meetings therefore registers as an optional, default-enabled draft
API and can be disabled through the existing module controls. This does not start capture,
contact providers, or add a recording UI. This repository compatibility rule was verified
in `packages/module-registry/src/compat-gate.ts`; a default-disabled built-in would prevent
application startup and must not be used.

## Next runnable workspace checkpoint

Add the real package-owned Meetings web contribution and sidebar entry, using the approved
Masthead/SectionHead/RowIndex vocabulary. The three capture choices are explicit and may be
saved only as an intentional personal default. Source selectors and Start remain unavailable
until native capture exists. History lists actual drafts, not invented recordings. Personal
notes use the existing draft API with same-input retry keys, version conflict review and
memory-only recovery across signed-in navigation. Unmounted or cleared-session callbacks must
not restore another session's cached data. Permanent draft deletion requires an explicit
confirmation and a separate unapplied migration, 0261, for its runtime grant.

The independent AI change adds explicitly requested segment timestamps to the existing
pin-respecting transcription route, plus fetch cancellation on timeout/disconnect. Plain text
callers retain their previous form/response. Timestamp parsing is bounded and rejects malformed
ranges without a provider fallback or diarization claim. Provider errors are not logged as raw
objects by this route. This does not wire native capture or validate a meeting provider profile.

Seams verified for this checkpoint:

- `packages/settings-ui/src/scanner.ts:151–200` discovers `./web` package exports and checks
  their backend navigation. `apps/web/src/app.tsx:318–326` gates contributed routes.
- `packages/module-web-sdk/src/index.ts:65–164` provides browser-safe requests and UUIDs.
- `packages/ui/src/masthead.tsx` and `section-head.tsx` own the visual primitives. The later
  Tasks redesign adds an optional Masthead mark without changing the props used here.
- `packages/structured-state/src/preferences-repository.ts` supplies actor-scoped preference
  reads/writes. A missing or invalid capture default stays null rather than broadening capture.
- `packages/ai/src/adapters/http-api.ts:127–160` was the existing file-ASR seam. Provider routing
  remains in the unchanged repository resolver; this slice extends only the explicit response
  request and cancellation behavior.
- Existing chat surface seeding gives text user-turn authority, so it must not be used to feed
  a transcript as instructions. Meeting chat remains unavailable until its separate authorized,
  revision/cutoff-bound server retrieval path exists.

`tests/uat/specs/2981-meeting-drafts.uat.spec.ts` exercises real sign-in → Meetings → create →
notes → history/reopen → explicit default → confirmed fixture deletion. It must not intercept or
rewrite API responses. The cloud workspace cannot execute its Docker-backed harness; leave this
checkpoint code-complete, unverified until that real path runs. See the package README for the
supported isolated gate commands. Component visual QA is explicitly separate from this proof.

## Verified draft workspace and next transcript slice (4 October 2026)

Commit `468aaa8bdcf1367d9b8288cbdd4796d2e57ee189` passes the full CI gate
([run 37165385320](https://github.com/motioneso/moss/actions/runs/37165385320)) and
real browser/API draft acceptance
([run 37165385348](https://github.com/motioneso/moss/actions/runs/37165385348)).
The test enters Meetings from signed-in navigation, saves an explicit default, creates a draft,
preserves unsaved notes through navigation, verifies saved notes after reload, cancels deletion,
then confirms deletion and cleans up its fixture. This supersedes the preceding pending UI
proof status for the draft workspace only. Native capture remains unimplemented/unverified.

The next staged slice persists transcript ingestion and immutable revisions through authenticated
owner-context operations. Batch receipts provide same-input replay, optimistic versions serialize
concurrent ingest, source intervals retain monotonic epoch bounds, and Stop fixes an immutable
cutoff. Bounded snapshots and exact-revision evidence become a public Meetings API for chat.
No ingest endpoint implies native capture proof or expands existing companion token grants.

Existing chat integration must retrieve transcript data on the server, bind each turn to an
authorized meeting/revision/cutoff, preserve citation versions, and recheck access before releasing
content. Transcript text must never be supplied as seeded user instructions. Long-lived engine
sessions and streamed output require explicit context isolation and revocation handling before
the Ask Moss action can be enabled. Backend and live-path tests remain required for this slice.

### Tool-free meeting questions checkpoint

The initial existing-chat integration is capability-limited to the currently selected API-key
chat model. It resolves the current chat route and hard pins, then uses the existing no-tools
HTTP text-generation API. It must never substitute a different provider/model. CLI/subscription
models return a specific unsupported-capability error in the normal chat flow. This restriction
is required because the current ACP `chat` launch enables native filesystem/web tools; an MCP
allowlist alone does not isolate those capabilities. Supporting those models requires a separately
verified restricted ACP launch policy, not a prompt-only promise or legacy transport workaround.

The meeting selector opens existing Moss chat and never automatically sends a message. Per-turn
context binds an authenticated owner, meeting, revision, cutoff and evidence ranges; generated
content is buffered until final authorization. Questions do not inherit unrelated memory or Notes
retrieval, and no tools/actions execute in this first scoped mode. Reviewed Tasks and vault saves
remain explicit meeting actions. This is a staged capability limit, not completion of meeting chat
for CLI/subscription configurations. Questions are independent in this stage: each uses the current
transcript evidence, not previous assistant answers. The shared drawer retains history for review,
but follow-up questions must include their context; conversational continuity is not yet claimed.

### Native implementation prerequisites

The existing macOS host is Trail Marker. A future `TrailMarker/Meetings/` capture subsystem
should separate a pure lifecycle machine, serial runtime, microphone adapter, Core Audio process
tap, read-only preflight and permissions. The app currently targets macOS 14.0; process taps need
an availability guard for 14.2+. Apple's documented tap recording flow triggers system-audio
consent when the aggregate starts, so preflight must not start capture as a permission probe.
`NSAudioCaptureUsageDescription`, microphone usage description and release audio-input entitlement
belong to the explicit capture slice, not a background permission workaround.

Trail Marker Pause All, logout, account changes, Quit and application termination must tear down
both tracks before continuing. Its existing Backtrack recording indicator must coexist with the
meeting indicator. A restart/reconnect must never resume meeting capture automatically. Existing
`tm1_` authorization stays unchanged; separate meeting-device approval, bounded grants and
revocation enforcement are prerequisites to enabling native submission.

No Windows host exists in this repository. An eventual process-tree-loopback adapter can be
spiked independently, but host UI/distribution and signed updates require an architecture/release
decision before Windows support is claimed. Current macOS CI runs on macos-15 and may prove
compilation/synthetic lifecycle behavior; only actual OS/device tests can prove capture scope,
consent, Teams/Zoom compatibility, timestamps and device release.

Primary API references: [Apple process taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps),
[Apple microphone consent](<https://developer.apple.com/documentation/avfoundation/avcapturedevice/requestaccess(for:completionhandler:)>),
[Microsoft process loopback](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/).
