> Current direction: use the approved four states and capture rules in `../specs/2026-10-06-meetings-minimal-design.md`. Earlier implementation checkpoints below are historical.

# Minimal Meetings: Part A build plan (#2981)

Status: approved scoped implementation; draft pull request only, no merge or deployment.

## Source and boundary

Build from PR #3056 at `588f2d5ed779b39eb549679f06a547fb90f0f898`.
The approved design source is PR #3077 at `4d893f5c3bf7581f067cf412f9db1e6ef74cbe14`:
`docs/superpowers/specs/2026-10-06-meetings-minimal-design.md` and its seven frozen mockups.
The historical Part A source was the seven-screen mockup. The current four approved #3087
states and updated design brief supersede its setup, Settings and recording-control direction.

Part A keeps the existing one-time recording capability and explicit browser Start authority.
It does not restore per-meeting Prepare/Approve. Creating, linking, and opening never record.
Existing denial, cancellation, cutoff, auth-reset and export safeguards remain in force.

Part B remains separate and cannot start before Part A is published. Its link controls,
capability inactivity changes, native notification/panel and protection-removal test matrix
are not claimed by this PR. Hardware-bound secrets are deferred. Existing pairing and capability
status may be displayed, without changing the link authorization model.

## Work lanes

1. Server and contracts: new module migration 0292 (recheck open inventory before publication),
   durable preferences, OS-default source resolution, saved-source Start validation,
   title updates, and bounded/idempotent summary dispatch after finalized meaningful transcript.
2. Linking and Settings: native app linking, the ready workspace, and Settings → Meetings with
   link status, audio mode and Unlink only. Fresh accounts use microphone + system audio.
3. Meeting workspace: plain inline title, autosaved notes and conflicts, full-width transcript and
   notes, mobile tabs and bottom controls, summary/version/overflow actions, simpler list and copy.
4. Normal chat and shell: route-derived removable meeting context including notes before transcript,
   timestamp links, recording dot and return timer through the lightweight persistent-controls seam.
5. Integrate app-map declarations and release note, then validate the complete changed tree.

## Validation and limits

- Focused unit/component tests for setup, preferences, auth reset, controls, autosave/conflict,
  routing/chat, list, summary finalization and idempotency, preserving current capture denial tests.
- Real isolated integration coverage for preferences, source defaults/validation and
  summary dispatch. Run only through the repository verify-gate procedure in hosted CI.
- ESLint, Prettier, file-size, design tokens, UI classes, catalogue, migration numbers, all relevant
  TypeScript configurations, app-map build and applicable offline tests.
- Preserve the two Today e2e assertions unchanged. Add synthetic UI assertions for desktop/mobile
  without representing fixtures as live proof. This executor cannot run Chromium (socket EPERM).
- No local database command: Docker is unavailable and no live/development DB work is authorized.
- No real credentials, audio, provider activation, OS permissions, production work or deployment.
- Live owner-controlled Mac acceptance is outstanding. Even a green hosted run leaves this
  user-facing change code-complete, unverified until the real assembled path is recorded on the PR.

## Published base and publication boundary

The owner published the #3056 corrections and its narrow acceptance-fixture fixes. This build
starts from the verified published `588f2d5ed` head; preserve title feedback, schema/cascade
fixtures and new-meeting timing assertions while removing obsolete setup requirements.
The owner now authorizes the coordinated rebuild across #3056/#3079/#3082 and the #3077 spec.
Merge main a92148a01 into the implementation branches; preserve history and push fast-forward only.
Main owns migrations 0289, 0291, 0293 and 0294; Part A owns 0292. Recheck the live catalog before publication.
Add 0292 to the foundation schema catalog and all affected lifecycle/export fixtures.

## Publication

Make explicit-path local commits. Coordinate remote publication with the parent before pushing.
Update the existing draft #3079 targeting `feat/2981-native-meeting-capture`; update #3077 as the design source. No PR merge or deployment is authorized.
The release note is Category Changed, Title Simpler meetings, with a plain-English description.

## Implementation and offline verification (2026-10-06)

The original Part A implementation introduced the transcript-and-notes workspace and durable
summary behavior. The 7 October rebuild removes its first-use setup and source pickers, adds
OS-default microphone resolution and reduces Settings to link status, audio choice and Unlink.
Explicit Start remains required, and a stopped meeting remains ended.

Stop persists summary intent and metadata-only queue work transactionally through the existing
job adapter. An enqueue savepoint prevents an optional queue failure from undoing Stop. The
worker waits for finalization or its bounded cutoff, reserves the existing output request before
model dispatch, and preserves its replay, evidence-revision and current configured-model checks.
Unavailable, skipped and interrupted outcomes remain visible. The summary title refreshes the
open workspace; neither Stop/status replay nor opening a page creates another generation.

Offline checks on the assembled implementation:

- 67 Meetings, shell and module-loader suites: 901 tests passed. After the final Markdown-copy
  access-loss fix and test type annotations, the affected seven-suite privacy/citation group
  passed 123 tests, including clipboard payload assertions for 401/403/404.
- All six TypeScript configurations passed: root, tests, web, and the three external modules.
- Full ESLint and Prettier, file-size, design-token, UI-class, migrated-section, UI-catalogue,
  persisted-locale, development-password, package-dependency, migration and app-map checks passed.
  The password audit covers the working files only, not old public history or credential rotation.
- Migration audit found no local/base collision. A separate read-only review of all six open PRs
  confirmed 0292 remains unclaimed; their reserved migration numbers are recorded above.
- Hosted UAT source discovers eight tests across six Meetings specs. These exercise actual Moss
  routes/UI with explicitly synthetic recorder, transcript and model fixtures. They were not run
  in this executor.

Observed red-to-green regressions include delayed title save/refetch/reset, rapid typing,
post-navigation title completion, title-cache deletion/access loss, stale source details after
access denial, exact-microphone selection, finalization-before-summary dispatch, optional queue
failure preserving Stop, concurrent claim/Stop versus cancellation, native capture timestamp
identifiers, removed chat context on reopen, stale chat callbacks across route/account changes,
and denied transcript bytes in Markdown and clipboard output. Protection-removal probes for
source selection and finalization were restored and their focused suites rerun successfully.

Authored isolated database integration coverage includes worker-role execution and owner RLS,
metadata-only transactional queue rollback, the real Stop/finalized-status lifecycle, queue
failure, concurrent claim/cancel locks, title CAS/create replay, notes-only chat ownership, and
0292 two-owner upgrade/backfill/rollback plus lifecycle export. None ran locally: Docker and the
required isolated verify-gate database are unavailable. No live database was used instead.

The browser cannot launch in this executor because Chromium's socket operation is denied.
There is no assembled visual, live Mac/device/permission/audio or real-provider proof here.
This remains code-complete, unverified until hosted checks and the owner-controlled live-path
acceptance are recorded. Both existing Today e2e specs are unchanged. Part B has not started.

## Review and CI repair on published `bef8e89f` (2026-10-06)

The [owner review on PR #3079](https://github.com/motioneso/moss/pull/3079#issuecomment-6021129354)
identified obsolete app-map controls, an early-enqueue failure that cancelled the already queued
delayed summary, overly broad input styling, phone navigation stacking, missing automatic-title
copy and retries after meeting deletion. The repair updates the map, preserves the delayed attempt
when its optional early enqueue fails, and treats only the exact missing-meeting result as a
completed no-op. The CSS exception now covers only radio-card radios in Meetings settings; the
other screens retain their original input selector matching and declarations. Phone capture
controls sit below both the navigation scrim and drawer.

Hosted CI also exposed three fixture/precondition problems:

- The queue-definition and lifecycle-cascade inventories omitted the new summary queue/table.
  Their expected lists are corrected; no applied migration changed.
- The real-service Stop-summary integration fixture submitted audio after claim without first
  reporting the recorder's recording acknowledgement. An offline service regression reproduced
  the exact interrupted response. The fixture now reports that status before audio; the
  production admission guard is unchanged.
- The sign-out UAT timed out finding Notes after it switched offline immediately after a row
  click. No hosted DOM artifact was retained. Controlled component tests confirm that navigation
  can precede the initial record response, leaving no editor if that request fails. The UAT now
  awaits the matching route and visible, editable Notes before going offline. Both failed-save
  checks, cancel preservation, successful retry, confirmed discard and no-second-warning
  assertions remain intact. This diagnosis is corroborated by source and component behavior,
  not by an unavailable hosted screenshot or trace.

Repair validation: eight UI/capture/chat suites passed 133 tests and seven server/queue suites
passed 130 tests. The CSS boundaries had four observed failures before correction; early queue,
deleted-job, queue-inventory and audio-admission regressions also ran red before their fixes.
Root, tests, web and all three external-module TypeScript configurations passed, as did full
ESLint/Prettier, file-size, design-token/UI-class, migrated-section, catalogue, persisted-locale,
working-file password, package-dependency, migration-number and app-map checks. Independent
source review found no remaining high-confidence blocker in the repair.

The earlier 901-test build validation above is historical. Hosted UAT and isolated database
integration reruns are still required for this repair. Neither ran locally; the Docker and browser
restrictions remain. Structural CSS checks are not live visual proof. No Mac/device/audio or
real-provider acceptance occurred, and Part B remains paused until this correction is published.

## Account-export policy fixture correction (2026-10-06)

Hosted integration found that the policy-removal negative control inferred
`meeting_stop_summaries_export_worker`, which does not exist. Migration 0292 defines
`meeting_stop_summaries_owner` for `ALL` commands and both app and worker runtime roles.
The fixture now asserts that exact name, role list and command; the other twelve export tables
retain their worker-only `SELECT` policy expectations. The owner-isolation failure assertion,
transaction rollback restoration and `ENABLE`/`FORCE ROW LEVEL SECURITY` checks are unchanged.
No applied migration or production code changes.

This failure already appeared on `bef8e89f` in integration shard 4, job `112388037857`, at
16:50:03 UTC before the job was later cancelled. Neither the test nor migration 0292 changed
between that head and `5cd2550e`; this is an existing fixture omission, not a regression from
the intervening review repair. Cancelled shard status is not evidence that its tests passed.

Offline validation: the existing account-export and migration unit suites passed all 11 tests;
scoped ESLint and Prettier passed. A read-only source audit matched all thirteen expected policy
names, role lists and commands to their migration declarations. Root and test TypeScript checks
passed sequentially with a 4 GB heap. Database integration and its policy-removal negative control were not run locally:
Docker and the required isolated verify-gate database remain unavailable. Hosted verification
of the corrected control is still required.

## Automatic-summary UAT Origin correction (2026-10-06)

The automatic-summary fixture uses Playwright’s cookie-sharing request context, which does not add Origin automatically. Capture mutations must supply the configured browser Origin; the server still rejects missing or untrusted values before resolving the session.

The automatic-summary fixture now uses a small request helper that supplies the configured base
URL's origin for the Stop replay POST. The registered Fastify routes retain negative coverage for missing and untrusted Origins before session or store access. Setup/cleanup preferences, transcript, record deletion, AI configuration and device
session revocation use their existing authenticated routes; no other capture-browser mutation
in this spec was missing the header. Production authentication and CSRF checks are unchanged.
The helper is included in the Meetings workflow paths and maps to the automatic-summary spec
in the canonical UAT trigger map, so helper-only changes retain that acceptance coverage.

Five focused offline fixture/capture/preferences/UAT-environment suites passed all 57 tests, and scoped
ESLint, Prettier, file-size and root/tests TypeScript checks passed (compilers ran sequentially
with a 4 GB heap). No database or browser UAT ran locally. Hosted execution remains required
to verify the rest of the automatic-summary scenario.
