# Minimal Meetings: Part A build plan (#2981)

Status: approved scoped implementation; draft pull request only, no merge or deployment.

## Source and boundary

Build from PR #3056 at `588f2d5ed779b39eb549679f06a547fb90f0f898`.
The approved design source is PR #3077 at `4d893f5c3bf7581f067cf412f9db1e6ef74cbe14`:
`docs/superpowers/specs/2026-10-06-meetings-minimal-design.md` and its seven frozen mockups.
Those source documents are copied unchanged here for reproducibility; their original draft
status describes the design PR, while this plan records the subsequently approved Part A scope.
The mockup markup, styles, seven screens and critique were inspected before implementation.

Part A keeps the existing one-time recording capability and explicit browser Start authority.
It does not restore per-meeting Prepare/Approve. Creating, linking, and opening never record.
The base already enforces the server-stored once-per-account current recording notice and
binds it to each grant; retain that service, browser race fencing and migration 0290. Pause/Stop remain notice-independent.
Existing denial, cancellation, cutoff, auth-reset and export safeguards remain in force.

Part B remains separate and cannot start before Part A is published. Its link controls,
capability inactivity changes, native notification/panel and protection-removal test matrix
are not claimed by this PR. Hardware-bound secrets are deferred. Existing pairing and capability
status may be displayed, without changing the link authorization model.

## Work lanes

1. Server and contracts: new module migration 0292 (recheck open inventory before publication),
   durable preferences, existing account-notice integration, saved-source Start validation,
   title updates, and bounded/idempotent summary dispatch after finalized meaningful transcript.
2. Setup and settings: one-time setup and Settings → Meetings, existing device/capability status,
   source defaults and current notice, summary-on-Stop default on, shared input CSS correction.
3. Meeting workspace: plain inline title, autosaved notes and conflicts, full-width transcript and
   notes, mobile tabs and bottom controls, summary/version/overflow actions, simpler list and copy.
4. Normal chat and shell: route-derived removable meeting context including notes before transcript,
   timestamp links, recording dot and return timer through the lightweight persistent-controls seam.
5. Integrate app-map declarations and release note, then validate the complete changed tree.

## Validation and limits

- Focused unit/component tests for setup, preferences, auth reset, controls, autosave/conflict,
  routing/chat, list, summary finalization and idempotency, preserving current capture denial tests.
- Real isolated integration coverage for preferences and stored notice, source validation and
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
starts from the verified published `588f2d5ed` head; preserve its account notice, title feedback
correction, schema/cascade fixtures, visible notice label click and new-meeting timing assertions.
No additional #3056 publication is authorized. PR #3071 separately owns migrations 0289, 0291,
0293 and 0294; this Part A reserves 0292, checked against the live inventory before publication.
Add 0292 to the foundation schema catalog and all affected lifecycle/export fixtures.

## Publication

Make explicit-path local commits. Coordinate remote publication with the parent before pushing.
Open a new draft PR targeting `feat/2981-native-meeting-capture`; do not modify or merge #3077.
The release note is Category Changed, Title Simpler meetings, with a plain-English description.

## Implementation and offline verification (2026-10-06)

Implemented Part A on the published base above. The live recording capability and account notice
remain the base services. A person can continue first-use setup with notes when no recorder is
available; this does not mark recording setup complete. Capture requires an explicit Start.
Sources are exact named microphone/app choices because the current native inventory does not
identify a system-default microphone. Settings changes apply to the next Start or Resume; the
paused page displays the sources Resume will use. A stopped meeting remains ended.

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
