# Coming-soon Commitment Inventory

- **Issue:** #1002
- **Status:** Draft for UX Coordinator approval
- **Base:** `origin/main` at `514e9b78`
- **Tier:** Mixed UX and security planning; this issue does not deliver the promised capabilities

## Problem

Jarv1s may show honest future commitments, but every visible promise must have one concrete open
delivery issue. Current UI mixes four states: tracked promises, promises whose old trackers are
closed, explicitly unplanned options, and copy that says a capability is unavailable even though it
already ships.

This pass reconciles those states without building export, restore, push, or GitHub integrations.

## Locked decisions

- Keep a visible promise when the capability remains planned.
- Remove a promise only when live GitHub explicitly says the capability is not planned.
- One visible promise maps to one concrete open delivery issue with scope, scheduling state, and
  acceptance criteria. Umbrella/deferred indexes do not count.
- A shipped capability gets a working path or truthful instruction, not a tracker badge.
- Reuse the existing settings primitives and tests. Do not add a promise registry, backend, API,
  migration, or feature-flag system.
- Planning creates no issues and mutates no GitHub state. Tracker changes occur only after this plan
  is approved.

## Grounded inventory

| User surface                         | Visible commitment                             | Live source of truth                                                                                                                                    | Resolution                                                                  | Risk                             |
| ------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------- |
| Settings → Audit & operations        | Export instance data                           | #1069 was closed as not planned; personal export is a different, shipped capability and instance-wide private-data export has no bounded approved scope | Remove any instance-export promise; retain personal export only             | High: privacy/RLS design         |
| Settings → Audit & operations        | Backup & restore                               | #1070 was closed as not planned; scheduled DB/vault backups and restore safeguards already exist, while in-app status/PITR are not current requirements | Remove the unplanned admin/PITR promise; retain `docs/operations/backup.md` | High: destructive recovery       |
| Settings → Modules → Notifications   | Push                                           | #743 is closed; #827 is an open deferred umbrella, not a delivery owner                                                                                 | Reopen and refresh #743, then map the row to #743                           | High: private payload delivery   |
| Settings → Connected accounts        | GitHub                                         | #1061 is reduced to removing the orphaned promise; cleanup is complete in the working tree and awaits merge                                             | Remove the GitHub tile; close #1061 after merge                             | Medium: OAuth/secrets when built |
| Onboarding → Connect another account | Outlook and Microsoft 365, each labeled `Soon` | #270 is closed; Backlog milestone #15 explicitly says the Outlook connector is a personal sidecar and out of the shipped product                        | Remove both unplanned tiles and the “preview upcoming services” claim       | Low: presentation-only           |
| Settings → Profile → Delete account  | “Data export isn't available yet”              | Personal data export already ships immediately above this dialog through `DataExport` and `/api/me/export/*`                                            | Replace stale copy with an instruction to export data above before deletion | Medium: destructive-flow clarity |

### Reconciled items that need no build change

- The Connected accounts GitHub tile already references #1061 and is correctly non-actionable.
- Apple-specific and `Other (OAuth)` placeholders are absent after #995. This matches the #1002
  clarification: Apple-specific setup was explicitly scrapped and generic OAuth is not planned.
- #1003 remains an open iCloud Mail + Calendar delivery issue, but no current UI promise points to
  it. Generic iCloud Mail through IMAP is already offered as available now.

### Not current user-visible promises

- `calendar.planning`, `calendar.detect-commitments`, `calendar.writeback`, and
  `email.thread-summaries` retain internal `coming-soon` manifest metadata, but #732 removed the
  generic renderer. Current Email and Calendar settings select only shipped controls; these rows are
  not visible.
- `apps/web/src/shell/coming-soon.tsx` has no caller. It is dead presentation code, not a product
  commitment, and may be deleted while adding the guard.
- “Coming up soon” in Calendar briefing copy describes event timing, not a feature roadmap.
- Runtime “not available” messages describe current environment or request state, not future work.

## Tracker contracts

Tracker creation/reopening is the first approved execution task. The exact issue numbers are then
written into the UI and #1002 inventory.

### New: Admin operations — safe instance-wide data export

Scope:

- Define the export trust boundary and delivery path for all instance-held data.
- Preserve the no-admin-private-data-bypass invariant; a runtime admin role must not gain raw
  cross-user reads or `BYPASSRLS`.
- Exclude credentials, tokens, password hashes, session secrets, and encrypted secret material.
- Define module coverage, artifact protection/expiry, audit metadata, failure recovery, and operator
  access.

Acceptance:

- An approved security design names the trusted execution plane and recipient.
- Coverage is mechanically checked against module-owned data, with intentional exclusions listed.
- No private content or secret reaches browser responses, logs, jobs, prompts, or screenshots.
- The Audit & operations promise is replaced by a truthful working/status path only when delivery is
  verified with adversarial security tests and live UAT.

### New: Admin operations — backup status and point-in-time restore

Scope:

- Reconcile the scheduled vault-inclusive backup work in #56 and container tooling repair in #70.
- Define backup health/last-success visibility, retention/off-host posture, point-in-time recovery,
  maintenance/locking, and a restore rehearsal path.
- Keep destructive restore authority in the appropriate operator plane; do not add a casual browser
  restore button.

Acceptance:

- Database and vault data have a documented, tested recovery point and retention policy.
- Restore fails closed, protects secrets, records bounded audit metadata, and cannot restore into an
  active instance without the approved safety boundary.
- A restore rehearsal proves integrity and records the achieved recovery point.
- Audit & operations reports truthful health/action copy after the workflow ships.

### Reopen and refresh #743: Web Push notification delivery

Add parent #1002 and explicit scheduling state. Preserve its existing browser/PWA, permission,
subscription, quiet-hours, revocation, retry, and redaction scope. Acceptance must require per-device
enable/disable, preference gating, metadata-only jobs, private-payload protection, focused tests, and
live desktop/mobile-PWA verification.

## UX and implementation contract

- Change the shared settings row API from boolean `coming` to numeric `comingIssue`. Rendering a
  shared future badge without an issue number becomes impossible at TypeScript call sites.
- The badge reads `Coming soon · #<issue>` and remains non-actionable unless a reviewed issue-link
  treatment already exists. This pass does not introduce external navigation.
- Direct/custom promise copy must include `#<issue>` in its accessible text, as the GitHub tile does.
- Remove the unused shell `ComingSoon` component so there is one tracked settings primitive, not two
  competing promise mechanisms.
- In the delete dialog, replace the false statement with the truthful instruction “Export your data
  above before deleting your account.” The existing `DataExport` component remains the workflow.
- Remove `SOON_PROVIDERS`, Outlook, Microsoft 365, and “preview upcoming services” from onboarding;
  Google and all working IMAP providers remain unchanged.

## Regression guard

Add one stdlib-only Vitest contract test under `tests/unit/` that:

- rejects the old boolean `coming` prop and requires `comingIssue` for the shared row;
- scans rendered TSX source for direct `Coming soon` or standalone `Soon` markers without a nearby
  `#<number>` reference;
- asserts the known tracker mappings and the absence of the stale export, Outlook, and Microsoft 365
  promises.

Internal manifest metadata is deliberately outside this TSX guard because it is not rendered. If a
generic source-behavior renderer returns, its UI code will be subject to the guard.

## Verification

- Focused unit contract test, onboarding Playwright coverage, typecheck, and the full foundation and
  release-hardening gates pass.
- Live UI verification covers every changed surface at desktop and narrow widths:
  Audit & operations, Notifications, Connected accounts, onboarding provider picker, Profile data
  export, and the Delete account dialog.
- Each retained promise visibly carries its tracker; Outlook/Microsoft 365 are absent; the real
  personal export remains usable before deletion.
- No live verification captures credentials, tokens, private export contents, or destructive
  confirmation values.

## Non-goals

- Delivering instance export, backup/restore, Web Push, GitHub, iCloud, or another connector.
- Reopening source-behavior backlog UI.
- Changing RLS, data access, APIs, jobs, migrations, or secret handling.
- Closing #1002, merging the implementation PR, or mutating the roadmap board in the planning PR.

## Exit criteria

- Every visible future commitment has exactly one concrete open tracker and displays its number.
- Explicitly unplanned Outlook/Microsoft promises are gone; no other planned promise is removed.
- Shipped personal export is described as available in the delete flow.
- #1002's live inventory is updated with the final tracker numbers and resolved collisions.
- Automated and live UI verification are green.
