# Scheduled/proactive dispatch seams and ownership

Revalidated against current main `2c81aa484` before dispatch. The user authorized reslicing
when a ticket cannot fit one fresh session including checks, review and real demonstration.
The accepted product behavior, mockups and approved migration rulings remain unchanged.

## Native reslices

| Original | Dispatch slice | Blocked by | Complete user outcome                                                                                                                                  |
| -------- | -------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #3132    | #3149          | #3125      | Request/cancel a relative fixed reminder in ordinary chat; receive one durable, replyable assistant message while away, safely alongside a live reply. |
| #3132    | #3150          | #3149      | Extend the same reminder with local-clock/DST timing, explicit deadlines and late/expired recovery.                                                    |
| #3137    | #3151          | #3133      | Schedule one exact authorized existing-source read through a real read-only gateway; receive a sourced status report while away.                       |
| #3137    | #3152          | #3151      | Extend that path with configured-model source reporting and bounded quiet retries.                                                                     |
| #3129    | #3155          | None       | Existing email refresh/monitoring respects current per-account access and module availability, with two-account revocation and real worker proof.      |

These five tasks are native children of their original tickets, tracked on project 2 with
native blocking edges. #3132 additionally waits for #3150; #3137 additionally waits for #3152;
#3129 waits for #3155 before its saved-choice and accepted Settings implementation.
Original downstream edges remain intact. #3132 and #3137 are scope containers, not extra builder
dispatches; their full acceptance criteria must pass after both children integrate. #3129 still
has its own saved-choice and Settings implementation session after its prerequisite.
Verified graph now has 29 task nodes and 35 blocking edges. All tickets remain open until
normal PR closure; integration/verification governs the working frontier.

## Session fit and shared conversation ownership

- #3127 can use the existing clean launch/replay boundary. Add capability-routed semantic
  summarization and success-only persistence; no provider runtime replacement. Existing
  concatenation/truncation is not semantic compaction.
- #3128 can add durable pending/completed identity at that boundary and conservatively explain
  unfinished work. Keep existing safe pre-acceptance retry versus uncertain-outcome handling;
  never blindly replay a possible action.
- #3149 owns assistant-only message persistence and exact streaming correlation. Current
  injection does not persist; current UI replaces the last unsaved reply, which is unsafe
  beside a background result. These changes ship with the complete reminder path.
- Serialize #3126/#3127/#3149 when their actual conversation/UI ownership overlaps. Settings
  lanes provide independent concurrency; do not merge conflicting runtime assumptions.
- #3151 must enforce read-only policy at actual dispatch. Existing approval-free gateway calls
  can still perform permitted writes and are not a substitute. Keep background run provenance
  separate from the destination conversation; use declared source APIs and current grants.
- Revalidate #3142 against integrated #3151/#3152 and #3135 before dispatch. One frozen existing
  non-destructive API operation fits its accepted scope when actor gateway/run/result seams
  exist. Persist initiation before invocation and prohibit automatic replay after it begins.
  Reslice if the required seams did not actually land; do not add a general model tool loop.

## Settings ownership — #3129 and #3130

#3155 first hardens the existing cached email source through public grant/module services and
per-account filtering. Its demonstration uses the existing refresh/worker/card seam; it adds
no competing UI, preference migration, cap/cursor rewrite or chat delivery. Fresh preflight
found that combining this access repair with the full preference/UI migration exceeded a
single verified session. #3129 retains all of its original acceptance criteria afterward.

#3129 owns Alerts & quiet hours registration/shell, email/delivery column, email client/query
entry, saved/effective email-choice mapping and relevant email source gates. It owns new surface
navigation/app-map metadata and delivery-control reuse. It does not implement quiet-hours policy.

#3130 owns the dedicated quiet-hours component, saved/draft/error/conflict detection, API
validation/metadata, unambiguous canonical migration, Profile link/control behavior and real
notification boundary proof. #3131 separately resolves conflicts. It uses existing quiet-hours
client/query seams and owns changed Profile/quiet-hours map metadata.

Shared Settings navigation, client/query files, app-map and manifest/composition hunks require
explicit handoff. #3129 integrates the shell first. #3130 may work on backend and a standalone
component concurrently, then merges the integration tip and receives shell wiring ownership
to finish accepted UI and live proof. This coordination does not add an artificial native edge.

## Verification infrastructure

The existing isolated UAT provisioner is the reuse path for actual UI/API/worker proof: build
the tested checkout, use unique Compose project/network/volumes, bootstrap a disposable owner,
exercise real Settings/chat and tear down. No rewritten Moss responses or screenshots.

Its historical hardcoded 20000–20099 host ports conflict with mandatory shared development
ports. The first implementation may add the smallest claimed-port override in the harness;
claim with `devports` in 5180–5299 and retain disposable-environment safeguards. Never use
production or the shared development instance for this proof. DB-touching checks still use
`verify-gate`; receipt reuse never replaces required review/live proof.
