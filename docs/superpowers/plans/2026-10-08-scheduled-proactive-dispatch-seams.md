# Scheduled/proactive dispatch seams and ownership

Revalidated against current main `2c81aa484` before dispatch. The user authorized reslicing
when a ticket cannot fit one fresh session including checks, review and real demonstration.
The accepted product behavior, mockups and approved migration rulings remain unchanged.

## Native reslices

| Original | Dispatch slice | Blocked by | Complete user outcome                                                                                                                                                                  |
| -------- | -------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #3132    | #3149          | #3125      | Request/cancel a relative fixed reminder in ordinary chat; receive one durable, replyable assistant message while away, safely alongside a live reply.                                 |
| #3132    | #3150          | #3149      | Extend the same reminder with local-clock/DST timing, explicit deadlines and late/expired recovery.                                                                                    |
| #3137    | #3151          | #3133      | Schedule one exact authorized existing-source read through a real read-only gateway; receive a sourced status report while away.                                                       |
| #3137    | #3152          | #3151      | Extend that path with configured-model source reporting and bounded quiet retries.                                                                                                     |
| #3129    | #3155          | None       | Existing email refresh/monitoring respects current per-account access and module availability, with two-account revocation and real worker proof.                                      |
| #3130    | #3158          | None       | Existing Profile saved quiet window correctly defers and releases normal outward notifications at its local boundary, with proactive parity, DST/UTC+14 and installed UI/worker proof. |
| #3130    | #3164          | #3158      | Existing Profile/chat/legacy quiet-hours edits and undo preserve the latest validated saved schedule, with real controls and worker proof.                                             |
| #3130    | #3165          | #3164      | Raw unambiguous saved schedules carry into Profile and govern real notification/focus/proactive consumers, preserving conflicting policies and migration-aware write/undo safety.      |
| #3127    | #3156          | #3125      | Retain earlier decisions on return/restart through semantic summary coverage and safe bounded replay in the same conversation.                                                         |
| #3127    | #3157          | #3156      | Continue typing through an automatic bounded provider-session rollover while preserving conversation and transcript identity.                                                          |

These ten tasks are native children of their original tickets, tracked on project 2 with
native blocking edges. #3132 additionally waits for #3150; #3137 additionally waits for #3152;
#3129 waits for #3155 before its saved-choice and accepted Settings implementation; #3127
additionally waits for #3157. #3130 waits for #3165 and retains its #3158 edge; #3131 still waits for original #3130.
#3128 still waits for original #3127, including both children. Original downstream edges remain
intact. #3127, #3132 and #3137 are scope containers, not extra builder dispatches; their full
acceptance criteria must pass after both children integrate. #3129 and #3130 each retain a full
builder session after their prerequisites. Verified graph now has 34 task nodes and 42 blocking
edges and is acyclic. All tickets remain open until normal PR closure; integration/verification
governs the working frontier.

## Session fit and shared conversation ownership

- The #3127 fit audit at `8fecaacae` requires two complete vertical children. #3156 owns
  capability-routed semantic summarization, detached AI preparation/composition, durable
  revision/coverage checkpoints, compare-and-swap publication and coverage-aligned replay.
  `prepareTextGeneration` is private; its generalized detached public contract does not
  exist yet. Current summary writes are unconditional and truncated; checkpoint/CAS and
  coverage-safe failure replay are pending work, not existing guarantees. Keep model work
  outside the publish transaction. Failed, empty or stale summaries never advance coverage;
  refuse an incomplete bounded launch when the unsummarized suffix cannot safely fit.
- #3156 proves retention through return/restart with a disclosed small replay budget in the
  isolated container and a real configured-model answer for a decision absent from raw replay.
  #3157 then owns conservative context accounting, the admitted-turn rollover, exact owned
  session disposal/relaunch and Stop/selection/provider/shared-warmup/seed races. It proves
  automatic rollover through ordinary real chat with unchanged IDs and no duplicate turns.
  Existing clean launch/replay seams are reusable; neither native context exhaustion nor
  automatic rollover is shipped. Serialize both children across their shared chat/runtime files.
- #3128 can add durable pending/completed identity at that boundary and conservatively explain
  unfinished work. Keep existing safe pre-acceptance retry versus uncertain-outcome handling;
  never blindly replay a possible action.
- #3149 owns assistant-only message persistence and exact streaming correlation. Current
  injection does not persist; current UI replaces the last unsaved reply, which is unsafe
  beside a background result. These changes ship with the complete reminder path.
- Serialize #3126/#3156/#3157/#3149 when their actual conversation/UI ownership overlaps. Settings
  lanes provide independent concurrency; do not merge conflicting runtime assumptions.
- #3151 must enforce read-only policy at actual dispatch. Existing approval-free gateway calls
  can still perform permitted writes and are not a substitute. Keep background run provenance
  separate from the destination conversation; use declared source APIs and current grants.
- Revalidate #3142 against integrated #3151/#3152 and #3135 before dispatch. One frozen existing
  non-destructive API operation fits its accepted scope when actor gateway/run/result seams
  exist. Persist initiation before invocation and prohibit automatic replay after it begins.
  Reslice if the required seams did not actually land; do not add a general model tool loop.

## Settings ownership — #3129, #3158 and #3130

#3155 first hardens the existing cached email source through public grant/module services and
per-account filtering. Its demonstration uses existing grant/module controls, authenticated
proactive-refresh API, real worker and radar result UI. The radar UI has no refresh action;
connector refresh is a different path. The approved UI/API/worker seams suffice; this adds
no competing UI, preference migration, cap/cursor rewrite or chat delivery. Fresh preflight
found that combining this access repair with the full preference/UI migration exceeded a
single verified session. #3129 retains all of its original acceptance criteria afterward.

#3129 owns Alerts & quiet hours registration/shell, email/delivery column, email client/query
entry, saved/effective email-choice mapping and relevant email source gates. It owns new surface
navigation/app-map metadata and delivery-control reuse. It does not implement quiet-hours policy.

#3158 first repairs the existing Profile saved quiet window's normal outward notification
defer/release boundary and compatible proactive quiet-end calculation. It owns existing local
delivery consumers, the smallest compatible time helper and tests if needed, the local behavior's
map metadata, and installed current-UI/worker proof. It preserves wall-time membership (including
legacy equal-time handling), strict local-instant rejection, Profile owner-zone/UTC fallback and
proactive's existing owner-zone fallback. A gap end uses the first valid instant; a fold end uses
the later occurrence. It does not add a canonical resolver, writer, CAS, undo, editor, conflict
choice, task allowance or cap-day change.

The [post-#3158 canonical prerequisite plan](2026-10-08-canonical-quiet-hours-prerequisites.md)
records the source-fit audit at `7a2efc3f3b` and published #3164→#3165→#3130 sequence.
#3164 first owns validation and safe existing Profile/chat/legacy writes, caller expectations,
revision/CAS/undo and recoverable feedback with real UI/chat/worker proof. #3165 then owns raw
presence/canonical carry-forward, durable provenance, all-writer/undo migration safety and real
notification/focus/proactive consumer authority. Conflicts preserve raw values and separate
policies until #3131. Quiet GET stays observational under settings.view; owner timezone still
controls scanner provider/ranking/cap days separately from explicit canonical quiet deferral.

Original #3130 remains a full builder for the accepted Alerts editor and Profile links,
saved/draft/load/error/retry/conflict fallback, query and map wiring, and its own real UI/worker
proof. Revalidate its complete fit after both prerequisites; no new approval or proof is implied.
#3131 separately resolves conflicts and remains blocked by #3130.

Shared Settings navigation, client/query files, app-map and manifest/composition hunks require
explicit handoff. With #3129 integrated from `8dc523ece`, shared-hunk ownership now transfers
serially through #3164 and #3165 to #3130: `apps/web/src/settings/settings-page.tsx`, `settings-alerts-pane.tsx` and
`settings-personal-panes.tsx` in that Settings directory, `apps/web/src/api/client-proactive.ts`
plus quiet-hours client/query hunks in `apps/web/src/api/client.ts` and `query-keys.ts`
in that API directory, `packages/shared/src/app-map-core.ts`,
`packages/settings/src/manifest.ts`, and relevant route-dispatch composition in
`packages/module-registry/src/route-chat-rules.ts`. Preserve the integrated email choice,
delivery controls and external-effect classification while wiring canonical quiet hours.
#3164 and #3165 receive only their required contract/Profile/client/query/map hunks;
#3130 starts from the latest verified integration tip and owns the shell/Alerts/Profile
composition, query and app-map changes needed for its accepted UI and live proof. The Settings
shell/accepted-editor ownership transferred by #3129 remains #3130's; #3158 changes only local delivery
consumer/time/map/UAT hunks and adds no shell or control. #3131 remains the separate conflict slice.

## Verification infrastructure

The existing isolated UAT provisioner is the reuse path for actual UI/API/worker proof: build
the tested checkout, use unique Compose project/network/volumes, bootstrap a disposable owner,
exercise real Settings/chat and tear down. No rewritten Moss responses or screenshots.

The claimed-port override already exists in the provisioner and runner through
`JARVIS_UAT_CLAIMED_WEB_PORT`; reuse it rather than adding another override. Claim with
`devports` in 5180–5299 and retain disposable-environment safeguards. Never use
production or the shared development instance for this proof. DB-touching checks still use
`verify-gate`; receipt reuse never replaces required review/live proof.
