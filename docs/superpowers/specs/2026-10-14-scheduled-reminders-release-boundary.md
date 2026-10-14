# Scheduled reminders and Tasks checks: release boundary

Ben approved this release boundary for #3154 on October 14, 2026. The full scheduled-tasks and
proactive-messaging specification remains the long-term design; this release does not claim to
complete it.

## Included

- Stable Main conversation and history, existing chat repairs, saved email-alert choice and
  current-access checks, and the existing quiet-hours release.
- One-time and repeating fixed reminders, editing, pause/resume/delete controls, notifications,
  Settings history, and explicit conversation destinations.
- Bounded owner Tasks reads: one-time reports and repeating checks that report meaningful changes.
- Typed approval of an exact proposed task change, saved for inspection as an inactive agreement.
  These agreements create no scheduled action job and execute no change.

## Deferred

Keep the following containers and their unfinished dependencies open: full side-chat overlay and
navigation (#3126), condition watches (#3139), reliable goal/reading completion (#3140), suggested
responsibilities (#3141), background action execution and deletion (#3142 and #3143), renewed
scope agreement (#3144), and unsolicited findings in Main (#3147). Inactive approvals implement
only stage #3142a; #3142 remains incomplete. Connected-provider scheduled webmail acceptance
under #3137 is also deferred. The bounded owner Tasks source is the accepted source for this release.

Meal planning (#3440) is outside this work.

## Release acceptance

Compose and verify #3507 after the destination foundation, then #3508, and finally reconcile
#3154 with current main. Preserve applied migrations, owner access, destination authority,
historical result destinations, and inactive agreement semantics. Keep Moss's app-map declarations
aligned with the combined behavior.

Final acceptance requires independent Standards and Spec reviews, exact-candidate hosted checks,
the full isolated foundation gate, the separate browser suite, and installed real UI/worker proof.
Use the repository's verify-gate skill for all database gates. Earlier slice receipts retain their
original candidate and verdict; they do not certify a later composition.

The only approved exceptions are #1185's real-feed photo/text-only News mosaic mix and #2282's
Reddit article arrival blocked by the recorded HTTP 429. Preserve both failed receipts as failures.
Every other required failure remains a release blocker.

Reconcile issue completion individually after final acceptance. Do not automatically close the
original specification or deferred feature containers. Feature PRs squash into the integration
branch; #3154 uses a guarded merge commit into main. This task includes no deployment, registry
publication, force push, administrative bypass, or automatic merge enrollment.
