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
