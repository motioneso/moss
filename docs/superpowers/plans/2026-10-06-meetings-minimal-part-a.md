# Minimal Meetings: Part A build plan (#2981)

Status: approved scoped implementation; draft pull request only, no merge or deployment.

## Source and boundary

Build from PR #3056 at `ce573bcb70a6af1530259a68ab8371b704b793e5`.
The approved design source is PR #3077 at `4d893f5c3bf7581f067cf412f9db1e6ef74cbe14`:
`docs/superpowers/specs/2026-10-06-meetings-minimal-design.md` and its seven frozen mockups.
Those source documents are copied unchanged here for reproducibility; their original draft
status describes the design PR, while this plan records the subsequently approved Part A scope.
The mockup markup, styles, seven screens and critique were inspected before implementation.

Part A keeps the existing one-time recording capability and explicit browser Start authority.
It does not restore per-meeting Prepare/Approve. Creating, linking, and opening never record.
The temporary per-request notice may be removed only when the server enforces stored current
policy acknowledgement and binds the version to the grant. Pause/Stop remain notice-independent.
Existing denial, cancellation, cutoff, auth-reset and export safeguards remain in force.

Part B remains separate and cannot start before Part A is published. Its link controls,
capability inactivity changes, native notification/panel and protection-removal test matrix
are not claimed by this PR. Hardware-bound secrets are deferred. Existing pairing and capability
status may be displayed, without changing the link authorization model.

## Work lanes

1. Server and contracts: new module migration 0290 (recheck open inventory before publication),
   durable preferences, server-authored notice acknowledgement, saved-source Start validation,
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

## Publication

Make explicit-path local commits. Coordinate remote publication with the parent before pushing.
Open a new draft PR targeting `feat/2981-native-meeting-capture`; do not modify or merge #3077.
The release note is Category Changed, Title Simpler meetings, with a plain-English description.
