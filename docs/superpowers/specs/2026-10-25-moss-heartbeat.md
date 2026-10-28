# Moss heartbeat: useful check-ins without another request

Date: 2026-10-25. Status: **Approved.** Ben ruled the open questions on 2026-10-25 and approved all
four mockup sets as drawn on 2026-10-28.
Mockups: [moss-heartbeat](mockups/moss-heartbeat/README.md). Plan: written separately under
`docs/superpowers/plans/`.
Build tracker: [task #3752](https://github.com/motioneso/moss/issues/3752).

## Problem and desired outcome

Moss knows parts of the owner's day but generally waits to be asked to put them together. A
remembered deadline can pass unnoticed; a followed team's match can matter to tomorrow's plans.
Requested reminders solve instructions the user already thought to schedule. The heartbeat asks
whether there is something useful to say, or an important question whose answer Moss needs, without
requiring the user to invent every reminder.

A recurring check every 30–60 minutes considers authorized calendar, Tasks, memory and followed
sports teams together. Most checks produce no message. Useful findings become ordinary, durable,
replyable assistant messages in Main, with existing app push delivery subject to attention controls.
The heartbeat has no authority to submit a timecard, edit a calendar or create a responsibility.

## Authority and relationship to earlier work

Ben's 2026-10-25 rulings in the task brief bind this design: default on; an in-app off switch and
frequency control in the same release; importance gating; multiple items per beat; durable no-repeat
and stop controls; daily caps; quiet-hours deferral without model-selected exceptions; a cheap
change check; provider neutrality; owner access; metadata-only jobs. Those decisions are settled.
His later rulings 1-7 (see "Rulings and design ledger") and the approved mockups settle cadence,
caps, upgrade, design, quality signal, information reach and scheduled-job listing. Where an older
paragraph here conflicts with those rulings, the rulings win.

Read alongside:

- [Scheduled tasks and proactive messaging](2026-10-07-scheduled-tasks-and-proactive-messaging.md).
- [Its approved release boundary](2026-10-14-scheduled-reminders-release-boundary.md): bounded
  owner Tasks reads are included in that scope; broad unsolicited findings (#3147) were deferred.
  This heartbeat is a separate extension, not evidence that deferred work is complete.
- [Restrained proactive monitoring](2026-06-27-restrained-proactive-monitoring.md): reuse
  source ownership, suppression and attention policy where suitable. Its default-off card contract,
  Today placement, 30-day dismissals and card visibility rules do not define heartbeat behavior.
- [Approved migration decisions](../plans/2026-10-08-scheduled-proactive-migration-decisions.md):
  retain saved choices and existing email budgets; Profile remains quiet-hours authority.

> 🧠 **From Hindsight memory (Scheduled tasks, proactive messages, and continuous Moss chat)** —
> Earlier work separates execution, durable Main results and outward notification delivery, and
> treats quiet success differently from failure. Its historical implementation claims are not
> release evidence; current source seams are checked below.

## User stories and acceptance examples

1. I receive a useful question such as “Did you submit your timecard? You said it is due today.”
   only when an attributable, still-open commitment supports it. Moss does not claim submission
   failed merely because it cannot see a submission. My answer closes the open question.
2. I receive a relevant planning note such as “Liverpool play tomorrow at 7am; you have the vet
   appointment for Luke at 10, so no overlap.” These are illustrative scenario facts, not real
   calendar or match claims. A production note must verify the fixture, timezone and appointment.
   “No overlap” also needs the match's supported end time or duration; kickoff alone is insufficient.
   Without that evidence, state the two start times without concluding there is no overlap.
3. I can receive two distinct useful items in one concise message rather than multiple interruptions.
4. Unchanged facts and unanswered questions do not come back every hour or the next morning.
5. “Stop telling me about timecards” persists until I explicitly undo it, including after restarts,
   upgrades, source edits and model changes. I can inspect and remove that suppression in Settings.
6. I can turn the heartbeat off or choose its cadence in the app. Off stops queued future output
   and pending heartbeat push; previously saved messages remain readable.
7. During quiet hours I can read a saved useful message in Moss, but its push waits. A model's
   urgency or confidence cannot override that hold.
8. A quiet beat costs no full generation when nothing relevant changed. I can distinguish that
   success from a disconnected source, a budget hold or a failed check in Settings.

## What a heartbeat sees

Collection is read-only, owner-scoped and bounded. Each source supplies stable references, material
revision, observed time, freshness/gap status and attributable evidence. Source content is data,
never instructions. Missing data means unknown, not absence. Permission is rechecked at collection
and before publication; revocation invalidates affected candidates and pending delivery.

| Source          | Bounded view                                                                                                                                           | Must not infer                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Calendar        | Today and tomorrow in the profile timezone, at most 20 visible events; times, supported duration, cancellation/change and source freshness             | No conflict from a truncated list, missing calendar or unknown match duration                                      |
| Tasks           | At most 20 open, due/overdue or explicitly important tasks, plus completion revisions of tracked candidates                                            | An old task is still unfinished after current completion evidence                                                  |
| Memory          | At most 10 relevant owner-visible commitments/preferences with provenance, explicit dates, corrections and resolved state; total context bound applies | A vague recollection is a deadline; silence is non-completion; private/incognito context is eligible automatically |
| Sports          | Explicitly followed teams and each team's next verified fixture, at most 20 fixtures; stable team/competition identities and timezone-aware times      | A team mentioned once is followed; an ambiguous team or stale fixture is confirmed                                 |
| Heartbeat state | Prior decisions/messages, suppressions, source checkpoints, outstanding questions, effective settings, budgets and recent equivalent requested results | General memory retrieval alone guarantees deduplication                                                            |

All four sources are considered when available. Ruling 6 lets the heartbeat fetch what it needs,
such as a followed team's next match; V1 does that through these four public module reads. News is
not a V1 source (the approved controls show four source switches); see open question 1 below. No
email-body scanning or general web research in V1. An unavailable source does not block an independently supported item; it does block any claim
that relies on its missing evidence. Truncation is recorded, and negative claims such as “no other
appointments” are prohibited when coverage is incomplete. Existing public module APIs own reads;
the heartbeat must not import module internals or query their tables.

## Runtime decisions and cost

One owner has one heartbeat schedule and at most one active beat. Cadence choices are 30 or 60
minutes, default **60 minutes** (ruling 1), measured in elapsed time; daylight saving changes do not
create duplicate runs. Profile timezone controls local-day budgets and presentation. A missing
profile timezone follows the existing locale resolver, never the worker host's timezone.

1. Load current owner settings/version and claim the due occurrence. Disabled, stale-version,
   deleted-owner or already-claimed work exits without source reads or model work.
2. Run a deterministic cheap pre-check through module-owned bounded change summaries. Compare
   material revisions of relevant sources, completion/correction and suppression changes, plus the
   next relevance boundary in time (today begins, a due window opens, tomorrow's fixture enters the
   horizon). Time advancing can matter even if no row changes. Do not use the current timestamp
   itself as a fingerprint: that would force generation on every beat.
3. With no relevant change, save a quiet-success checkpoint and schedule the next beat. Do not
   embed a retrieval query, call a model, regenerate sports prose or poll uncached remote endpoints
   merely to calculate this comparison. Bounded source refresh may use existing module sync/cache
   policy; its staleness is exposed. Unknown freshness is not an unchanged success.
4. If changed, collect the bounded view and filter expired, resolved, suppressed, duplicate and
   already-covered requested-reminder findings before invoking AI. If none remain, finish quietly.
5. Reserve a generation budget slot atomically, then make one provider-routed structured request.
   It has exactly two model jobs: **judge which supported items warrant attention now**, and
   **compose one concise grounded message/question for those items**. An empty selection is valid.
   No tools, permissions changes, model-created schedules or autonomous actions occur in this turn.
6. Validate every selected item and recheck current evidence, settings, suppression, permission,
   budget and destination. Changed evidence invalidates that item; do not publish stale prose.
   Commit the selected finding identities, message, budget charges and notification intent once.
7. Record the outcome and reconcile the next occurrence durably. After downtime do one fresh
   check, then resume cadence; do not replay missed beats or an old snapshot.

Ruling 1 keeps the model-check allowance bounded and has Ben monitor cost instead of gating on a
trial. Shipped defaults per owner: at most **6 generation attempts per local day**, **8,000 input
tokens** and **800 output tokens** per attempt, **60-second** timeout. Attempts, including failed
ones, consume this allowance; no retry evades it. At most two transient retries per occurrence with
bounded backoff, within the same daily allowance. No automatic provider escalation or paid fallback
outside the owner's AI configuration. Record counts, token usage when supplied and duration; do
not invent a currency cost for providers without pricing/usage information.

At a 30-minute cadence there can be 48 cheap checks, not 48 generation calls. At the daily budget
limit keep deterministic checks/status current and hold generation until the next local day, shown
as "On hold" in Settings. If important work routinely misses its window, Ben decides whether to
raise the allowance; the code never raises it silently. Do not advance a successfully-evaluated fingerprint on read/model
failure or budget hold; keep evaluation pending without repeatedly retrying during that hold.
Stable persona prefixes remain unchanged; dynamic observations belong in request context.

## Importance check and evaluation

“Is this actually important?” is a decision grounded in evidence, not a free-form confidence number.
A candidate must have all of: an explicit owner commitment or followed interest; supported facts;
a specific reason it matters now; useful information or an answerable question; and a novel,
unresolved proposition. Routine empty-calendar commentary, general sports chatter, generic advice,
low-confidence deadline guesses and “just checking in” fail the gate.

Only high-confidence selections may proceed; uncertain candidates stay silent.
The model returns either silence or bounded item references, evidence references, importance
rationale, an ordinal confidence assessment and proposed text. Treat model confidence as advisory;
deterministic validation rejects unknown IDs, unsupported factual clauses, stale/expired evidence,
missing why-now, suppressed topics, duplicate facts, too many items and malformed output. When
validation cannot establish support, stay silent and record a rejected outcome. Structured field
descriptions, a prompt contract with a worked timecard/silence example, a boundary validator and
per-item source-to-proposed-message review are required at the model boundary. User tasks and
calendar records are never written by model output. Settings feedback renders from saved records.
Production guidance must stay below 150 words; add validation rather than prompt patches.

Ruling 5 makes thumbs up and thumbs down on each check-in message the quality signal. There is no
separate usefulness threshold and no owner-day trial. Ratings are stored per message against the
heartbeat outcome so Ben can read them alongside call counts.

The deterministic validator still needs a fixed scenario suite with model doubles: positive
deadlines and cross-source plans, unchanged negatives, completed timecards, vague memories,
ambiguous teams, unavailable/truncated calendars, DST, fixture postponements, source instructions
trying to alter authority, suppressed subjects and already-delivered reminders, including both
brief examples above. The suite proves **zero unsupported factual claims** and **zero repeated or
suppressed items** reach publication; those two are invariants, not quality targets. Changing
provider must not change access or delivery policy.

## Durable memory, suppression and limits

Heartbeat state is distinct from general semantic memory. Persistent records cover:
owner settings/version; per-source checkpoints and next time boundary; occurrence/lease/outcome;
material finding identities and evidence revisions; a message/outbox reference; daily budget charges;
explicit topic/source-item suppressions; and outstanding questions with resolution evidence.
New storage must have owner-only FORCE RLS and participate in owner export/deletion. Private
content belongs only in authorized result/evidence records, never queue data or operational logs.

A finding identity represents the owner, source entity/commitment, proposition and material episode,
not the generated wording, model/provider, beat ID or date of the scan. A new due occurrence of a
truly recurring commitment is a new episode; a changed title, timestamp or paraphrase is not.
For cross-source messages, record each constituent finding and its sources separately. Use owner-
scoped opaque keys; a hash is not permission to expose private source identifiers in logs.

States distinguish evaluated/silent, selected, published, notification pending/delivered, resolved,
suppressed and failed. Quiet evaluation does not mean “told the user”; selection/pending publication
reserves the identity to block races. Only a committed Main message counts as published. A crash
before commit can retry; one after commit only reconciles delivery, never regenerates the message.
Outstanding questions do not recur without a genuinely new owner-approved reason; an answer,
completion or correction resolves them. A material factual correction can warrant one new update;
explicit suppression always wins. In V1, retain minimal dedupe tombstones until owner deletion;
content retention may redact evidence without forgetting that a proposition was already raised.

“Stop telling me about X” creates an indefinite owner suppression through the normal authorized
chat/settings command path, outside the heartbeat generation turn. Exact source-item and topic
scope must be visible. Ambiguous X gets one ordinary clarification before any broad suppression;
Moss must not pretend it saved one. Persist before acknowledging. Suppression invalidates queued
items and pending pushes, survives memory compaction and provider changes, and is removable in-app.
Removing it does not replay prior findings. An opt-out for one topic does not cancel an explicit
requested reminder; changing that responsibility uses existing task controls.

Ben ruled 2026-10-25 that the heartbeat has **no message cap of its own**. An important finding is
never held back because earlier messages went out. Spam control comes from the importance check,
remembered "already told" identities, one message per beat that may carry several items, and quiet-
hours deferral. Muse and Duet document no daily cap either (see the research note below).

Heartbeat findings do not draw from the existing 8/day unsolicited-finding ceiling, because that
ceiling would be a message cap by another name. Existing email 3/day and hourly limits remain
unchanged for email; requested reminders/reads consume no unsolicited budget. An owner's explicit
saved limit is preserved (ruling 3) and never relaxed by migration. A finding already shown as a card, scheduled result or Main
update must not produce a second heartbeat interruption. Shared durable identity/accounting for
non-email cross-source findings is new work, not established by the existing email ledger.

## Reuse seams checked against the current tree

Inspected baseline: `578599b17`. Paths below are relative to `~/Jarv1s`; line citations identify
reuse evidence, not proof that the proposed heartbeat exists. The builder must refresh this check.

| Capability                                 | Current evidence                                                                                                 | Decision / remaining work                                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor-scoped queue and payload guard       | `packages/jobs/src/pg-boss.ts:196` (`sendJob`), `:403` (`registerDataContextWorker`)                             | Reuse pg-boss, scoped enqueue and actor context. Extend payload allowlists explicitly for heartbeat metadata; no second scheduler.                                                                            |
| Versioned execution and recovery pattern   | `packages/chat/src/scheduled-reads/runner.ts:59`, `:128`, `:164`; `packages/chat/src/scheduled-reads/queue.ts:3` | Reuse lifecycle/version checks, quiet outcomes and bounded retry pattern. A heartbeat is a system responsibility, not a forged user-created reminder.                                                         |
| Stable owner Main                          | `packages/chat/src/repository.ts:475`, `:490`                                                                    | Resolve/create canonical Main under owner context, not the most recently active side chat.                                                                                                                    |
| Durable assistant result and arrival       | `packages/chat/src/reminders/deliver.ts:139`                                                                     | Reuse reserved assistant message and after-commit arrival primitives. This helper also advances reminders, so do not pass fake reminders to it; extract only genuinely shared publication behavior if needed. |
| Notification identity and queued delivery  | `packages/chat/src/reminders/notifications.ts:27`, `:51`                                                         | Reuse metadata-only notification/outbox and event-key dedupe pattern, with a distinct heartbeat kind and lifecycle check. Existing worker expects a reminder record.                                          |
| Quiet-hours, mute and live lifecycle check | `packages/notifications/src/push-worker.ts:358`                                                                  | Reuse push delivery. It has an urgent bypass: heartbeat must always request normal urgency and no allowance, and recheck heartbeat off/suppression at dispatch.                                               |
| Provider-routed structured generation      | `packages/chat/src/scheduled-reads/report-generation.ts:40`                                                      | Reuse model resolution/capability routing. Request structured economy capability without hardcoded provider or model.                                                                                         |
| Bounded background source access           | `packages/ai/src/gateway/gateway.ts:567`                                                                         | Currently only `tasks.get`; multi-source bounded background reads are a required new seam, not a ready tool loop.                                                                                             |
| Visible calendar API                       | `packages/calendar/src/manifest.ts:343`                                                                          | Existing bounded read surface; background eligibility, cheap revisions and aggregate coverage need explicit module-owned support.                                                                             |
| Followed sports facts                      | `packages/sports/src/manifest.ts:581`; `packages/sports/src/sports-service.ts:988`                               | Existing tool is today-only; tomorrow fixtures and cheap material changes need a bounded public Sports contract.                                                                                              |
| Scoped memory retrieval                    | `packages/memory/src/retrieval.ts:12`, `:27`                                                                     | Retrieval exists; cheap commitment/correction revisions and reliable unresolved/deadline semantics are not proven. Semantic retrieval uses embeddings and cannot be the cheap pre-check.                      |
| Preference revision/conflict pattern       | `packages/proactive-monitoring/src/preferences-repository.ts:77`                                                 | Reuse owner-scoped compare-and-set behavior; a separate versioned heartbeat preference avoids redefining the old card switch.                                                                                 |
| App map ownership                          | `packages/shared/src/app-map-core.ts:55`, `:189`; source module manifests above                                  | Update shipped capabilities in the implementation PR, never advertise them in this docs-only PR.                                                                                                              |

Missing seams have named owners: the **heartbeat builder** owns schedule reconciliation, durable
identities/budgets, publication and notification lifecycle; **Calendar/Tasks/Memory/Sports owners**
(or the builder working at their public boundaries) own bounded read/change contracts. **Ben**
owns product parameters and mockup agreement. If a required source cannot provide a cheap,
authorized summary and grounded evidence, stop and reslice; silently dropping it fails this spec.

## Delivery, privacy and concurrent work

Heartbeat output always targets the owner's Main conversation; no new side-chat routing control.
Persist an assistant message without a fabricated user request or hidden trigger in the transcript.
Keep background message identity distinct from an active reply, preserve both after reconnect,
and never steal focus or overwrite a side-chat draft. A beat may bundle several items into that
single replyable message. Delivery failure cannot trigger source collection or generation again.

Reuse existing notification and device channels to signal the saved Main message once. Keep the
notification normal urgency. Quiet hours defer outward delivery, not Main persistence; no heartbeat
quiet-hours exception in V1, including existing reminder-specific allowances. Revalidate content
expiry, owner permission, heartbeat enabled state and topic suppression at dispatch, including a
summary release. If a bundled item becomes invalid, do not send stale text for it; rebuild the
notification from still-valid saved items without a model call, or cancel it if none remain.
Previously published Main history remains historical; subsequent correction is visibly separate.
No end-of-quiet-hours burst: at most one heartbeat push per rolling hour, with stale releases
collapsed into one current summary rather than replaying every held beat. Releasing notifications
does not create new Main messages.

Privacy requirements are build acceptance obligations, not verified security claims: use
`AccessContext` and `withDataContext`, owner RLS, public module access checks and `VaultContext`
for any vault reads. Admin is not a private-data reader. Queue payloads contain actor/resource IDs,
occurrence/version/idempotency metadata only. Fetch source text at execution under current access.
Never put prompts, source bodies or secrets in jobs, app responses beyond authorized content,
logs or telemetry. Follow credentials through configured adapters before claiming confinement.
Treat source instructions as untrusted; they cannot alter recipients, scope, settings or policy.

## Settings and upgrade contract

Location (approved mockup set 1): **Settings → Alerts & quiet hours → Moss check-ins**, beside
existing alerts.
Show On/Off, Every 30 minutes / Every hour, current timezone, last checked/next check,
quiet/budget-held/degraded/failed status, available/unavailable sources with recovery links, and
muted topics with Remove. Include Calendar, Tasks, Memory and Sports use switches, defaulting on
when authorized unless a saved exclusion applies. They control this heartbeat only and grant no
access. Link existing quiet-hours and Notifications controls rather than copying
schedules/device switches. No file editing, environment variable or developer console is required.

A successful save acknowledges the persisted values; pending/error/conflict states show the old
effective values and preserve the draft. Versioned saves reject stale edits. Turning off takes
immediate effect at publication/dispatch checks, invalidates future work and clears pending push;
turning on performs one fresh check without replaying old items. Frequency changes replace the
next due occurrence without duplicating it. Source connections and grants are managed through
existing surfaces, never enabled by a heartbeat switch.

| Install / saved state                                         | Effective behavior                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| New owner or existing install with no applicable saved choice | On, hourly, no message cap; missing/disconnected sources unavailable, no automatic connection or permission grant |
| Explicit saved heartbeat off/on or cadence                    | Preserve exactly; validate supported values without silently overwriting them                                     |
| Saved legacy proactive master-off                             | Preserve off for the heartbeat; show the saved-off reason and allow explicit in-app enable                        |
| Saved source-specific off                                     | Preserve the matching source exclusion; email-off alone does not disable the heartbeat                            |
| No legacy record, merely an old code default of off           | Default on; absence is not an explicit saved opt-out                                                              |
| Malformed/incompatible saved choice                           | Hold heartbeat, show repair/retry status; preserve the record, never replace it with on defaults                  |

Map legacy Tasks/Calendar off to the matching heartbeat source and Notes off to vault-backed
memory exclusion; Sports has no legacy equivalent. Conversation commitments remain subject to
Memory access and the new Memory use switch.

Ruling 3 settles the upgrade. Ben is the only known install, so the normal additive migration is
enough, and saved explicit choices are preserved as in the table above. Do not infer intent from
timestamps or migrate email-on into permission for other sources. Preserve existing scheduled
reminders, email choice, quiet hours, connector permissions and saved limits.

The implementation must ship additive storage migration, safe defaults, UI controls, worker/API
wiring and upgrade reconciliation together. No newly mandatory environment key may break existing
dev/prod compose. If an operational emergency stop is needed, expose it through existing admin
configuration with a shipped default; it does not replace the owner's off switch.

Enroll new owners and **all existing eligible owners**, including those who never reopen Settings,
through an idempotent, bounded upgrade/provisioning reconciliation. Only owner IDs/version metadata
may be enumerated outside an owner data context; read/write each preference under that owner's
context. No global scan of private preference rows and no runtime RLS bypass. The builder must
identify and cite an approved lifecycle/owner-enumeration entry point before planning this slice;
this inspection has not established one. If unavailable, add the narrow platform seam and prove
it independently, rather than silently making default-on depend on a later login.
Mixed-version startup must not enable work before compatible controls/storage exist. Migration or
queue registration failure is visible and bounded to heartbeat; existing reminders/chat continue.
Rollback holds heartbeat work without deleting saved choices/suppressions; never edit an applied
migration or run a destructive rollback to remove additive data.

## Agreed screens

Ben approved all four mockup sets as drawn on 2026-10-28:
[mockups/moss-heartbeat](mockups/moss-heartbeat/README.md). The build uses `@moss/ui` components
for the primitives the mockups render as markup. The ten flagged choices in the mockup README are
approved as drawn:

- Controls sit in a "Moss check-ins" card in Alerts & quiet hours; status, muted topics and
  scheduled jobs sit in three columns below a one-line summary with a Change button.
- Frequency is the only numeric control (every 30 minutes or every hour); there is no cap control.
- Check-in settings use explicit Save and Discard, unlike the save-on-toggle email switch beside it.
- Thumbs up and down are always visible under every check-in message; nothing asks why.
- Several items in one message render as side-by-side cards.
- Stopping a topic confirms in chat with a Muted pill and Undo; an unclear target gets three
  choice chips. No approval card.
- Notifications keep the existing row layout; a held row shows a "Push waits until" badge, one
  summary push replaces held ones after quiet hours, an expired item rebuilds the push, and a
  cancelled push leaves only the saved Main message. "Bell" in this spec means the Notifications
  page and sidebar unread count.
- Scheduled jobs list each job with a Stop button and inline confirmation; otherwise read-only.
- A legacy proactive-off shows an informational note with a Turn on button.
- Below 920 px the sidebar hides and Settings sections become a scrolling row of links.

The screen sets cover:

1. Alerts & quiet hours extension: on by default, saved off, frequency controls, effective versus
   draft state, saving/conflict/error, old-policy migration explanation and unavailable AI/source.
2. Check-in status, muted-topic and scheduled-job lists within Settings: never checked, silent
   success, useful result, budget hold, degraded source, persistent failure, mute removal, job
   stop and empty lists.
3. Main message and ordinary reply/stop-topic flow: timecard question, supported cross-source
   sports/calendar note, multiple items, ambiguity clarification, saved suppression acknowledgement,
   concurrent live reply and the thumbs rating. Reuse ordinary chat; no task-approval cards.
4. Existing notification/bell and device presentation as affected: quiet-hours hold/release,
   multiple-item summary, expired or disabled cancellation and a deep link to the saved message.

Cover desktop/phone and supported themes, keyboard/focus, loading, empty, error and retry states.

## Required app-map changes in the implementation PR

- Core Settings screen/navigation and owner setting declarations: check-in enable/default,
  frequency, source switches, timezone dependency, muted topics and the scheduled-jobs list with
  Stop; link Alerts & quiet hours.
- Chat feature metadata: read-only cross-source heartbeat, Main destination, quiet normal result,
  reply/stop semantics, thumbs rating and persistent history. Do not imply task or calendar
  actions run.
- Owning source manifests: supported authorized heartbeat reads, bounded horizon, permission/
  connection requirements and incomplete-data behavior; sports next-fixture support when shipped.
- Notification metadata: saved message target, mutes, non-bypassable quiet hours and cancellation.
- Errors/remediations: missing AI configuration, unavailable/revoked source, budget hold, settings
  load/save/conflict, upgrade/reconciliation failure and failed beat, with real recovery paths.

## Failure and recovery rules

| Failure                                     | Required behavior                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| No relevant changes                         | Quiet success, checkpoint advanced, zero generation and zero message                                                        |
| Source missing/stale/partial                | Degraded status; no unsupported or negative cross-source conclusion; retry via existing source policy                       |
| Source failure                              | Preserve its last successful cursor, bounded backoff; other independent evidence can still qualify                          |
| AI unavailable/timeout/malformed output     | No fabricated result; record failure and consume attempt budget; retry only within bounds                                   |
| Off/suppression/revocation while model runs | Publication recheck drops affected items; dispatch recheck blocks queued interruption                                       |
| Worker crash/lease expiry/two workers       | Unique occurrence/finding reservation prevents duplicate publish; reconcile committed result only                           |
| Budget exhausted                            | Visible held outcome; no out-of-band message to announce the hold and no unbounded catch-up                                 |
| Destination or persistence failure          | No alternate recipient; retry safe publication by reserved identity; do not charge a rolled-back message                    |
| Push provider/device failure                | Retry only delivery; saved Main message remains; never rerun the beat                                                       |
| Three consecutive failed eligible beats     | Persistent Settings error with actionable recovery; no repeated failure chat/push loop                                      |
| DST/timezone change/downtime                | One fresh beat; preserve charged ledger entries, do not reset the allowance by changing timezone; no missed-interval replay |

## Verification, live proof and kill gates

Implementation phases need their own complete UI/worker proof; no security, lifecycle or proof
debt may be postponed to a final hardening phase.

**First vertical slice only:** provision/migrate an owner, show the in-app controls, run the actual
queue/pre-check and a bounded four-source read through the authority seam, then publish
one supported message or an inspectable quiet outcome. Include off, suppression, generation
allowance and quiet-hours enforcement before enabling output. Do not ship a default-on publisher
ahead of its controls. Stop after this slice for Ben's usefulness/cost decision before detailing
later expansion.

Required automated behavior checks (deterministic source/clock/model doubles at public boundaries):

- unchanged beats invoke no generation, while a due-window transition can qualify with unchanged
  rows; a failed read never advances a success checkpoint;
- completed/answered, reworded and previously surfaced findings stay suppressed; distinct items
  bundle once; explicit stop survives source/model/restart changes;
- concurrent beats at the daily allowance boundary never exceed it; DST, timezone edits,
  dismissal, retries and quiet-hours release cannot refill or double-charge;
- off/frequency edits invalidate queued versions, including during generation and before push;
- two owners plus an admin cannot inspect/change each other's state, source data or destination;
  revoke a grant during a run and prove no unauthorized publication;
- no hidden trigger appears as user text; live reply and background message both survive reconnect;
- urgent model output and malicious source instructions cannot create a quiet-hours exception,
  new authority, task write or recipient; metadata-only job inspection rejects private content;
- upgrade absent/saved-on/saved-off/legacy source-off/malformed states, users who never open
  Settings, repeated reconciliation, mixed-version start and rollback preserve existing behavior;
- observe security tests fail with the relevant enforcement removed and record that evidence.

The builder must use `.claude/skills/verify-gate/SKILL.md` for every DB-touching command, run the
isolated full foundation gate and separate browser suite, and record exact candidate/exit codes.
Run `pnpm lint`, `pnpm format:check`, `pnpm check:file-size` and `pnpm typecheck` individually
(expected exit **0** each). Frontend work also runs `pnpm check:design-tokens` and
`pnpm check:ui-classes` (expected **0**). Never pipe a verification command. The build plan must
name the concrete isolated gate and browser commands from that skill/current scripts, plus the
executed per-slice e2e test; this spec does not authorize running a database gate now.

Live acceptance runs on an isolated installed dev instance, through the real UI with real saved
source records. Claim a dev port using `devports claim <agent-name>`; release it afterward. Create
an owner, configure available source access and AI normally, inspect default controls, save a due
commitment/follow/calendar through their real paths, and observe a scheduled worker result in Main.
Use disclosed test data, not private production data. Exercise unchanged silence, multiple items,
reply resolution, durable stop, off/cadence, allowance hold, quiet hold/release, disconnect/revoke,
reconnect, thumbs rating and a concurrent live reply. Assert durable message counts/IDs, saved preferences, source grants,
job outcomes and notification timing through bounded DOM/network/database evidence. Never
intercept or rewrite Moss responses to create a passing state; no screenshots for the live gate.

Record a PR comment linking the executable UAT run, exact commit, commands, exit codes, assertions,
provider configuration family, real-data setup/cleanup and limits of any unobservable device push.
A queued notification is not proof of device receipt. If that receipt cannot be observed, leave
that claim unverified and block acceptance of it. Document-only checks are not feature proof.

**Kill gates, owned by Ben:**

- Before planning: unresolved source/lifecycle seams → no build dispatch. Mockups are agreed.
- After the first complete slice: inability to preserve opt-outs, owner isolation, reliable
  suppression or quiet hours → stop publication, fix or cancel; never relax those invariants.
- After the first slice runs on Ben's install: any repeated or suppressed item, thumbs-down
  ratings Ben judges too frequent, or call counts he judges too costly → Ben chooses fix, rescope
  or cancel (rulings 1 and 5; no fixed threshold or trial length). Report calls/tokens and the
  share of beats that skipped generation, so he can judge cost.
- If useful positives require exceeding the generation allowance, or normal silence hides due
  commitments, Ben chooses rescope/cancel or explicitly revises the allowance. Do not continue
  expanding before that ruling. Operational kill must cancel pending heartbeat push
  while retaining settings and history, and must leave requested reminders working.

## Rulings and design ledger

Ben's rulings, 2026-10-25 (settled):

1. **Cadence/cost:** one beat per hour by default, with 30 and 60 minute choices. The model-check
   budget stays bounded, and cost is monitored by Ben rather than gated by a trial.
2. **Attention:** no heartbeat message cap. Several items may share one message. Quiet hours and
   suppression still apply.
3. **Upgrade:** Ben is the only known install, so no special migration beyond the normal one. Saved
   explicit choices are still preserved.
4. **Design:** a Settings mockup is wanted. Ben approved all four mockup sets as drawn on
   2026-10-28, including the ten flagged choices (see "Agreed screens").
5. **Quality:** thumbs up and thumbs down on each check-in is the quality signal. No separate
   evaluation threshold, no seven-owner-day trial.
6. **Information:** the heartbeat may fetch what it needs, such as followed teams and their next
   match, or a major news story.
7. **Recurring jobs by chat (later phase):** the owner tells Moss in conversation "do this every
   hour" (for example big AI news) and Moss creates the scheduled job. No setup screen is
   required. Settings only lists the scheduled jobs that exist, with a way to stop each one.

Decisions that follow from those rulings:

- Generation allowance defaults are 6 attempts per local day, 8,000 input and 800 output tokens,
  60-second timeout, shown as "On hold" when used (ruling 1 keeps it bounded; Ben may revise).
- Heartbeat findings do not draw from the 8/day unsolicited-finding ceiling (ruling 2).
- No owner-day trial or usefulness threshold; ratings are the signal (ruling 5).
- Sports reach is each followed team's next verified fixture, not only today (ruling 6).

Open question for Ben:

1. **News in V1.** Ruling 6 allows the heartbeat to read a major news story, but the approved
   controls show four source switches (Calendar, Tasks, Memory, Sports) and the only news shown
   is a chat-created scheduled job (ruling 7, later phase). V1 ships without a News source. Adding
   one later means a fifth switch and a public News read.

Research note (2026-10-25): Muse has no schedule-based wake-up, only a progress watcher for coding
work that edits one status message and drops duplicate events. Duet is not installed here and
publicly checks accounts every few hours plus a morning brief, with no documented cap, quiet hours
or duplicate guard, and a stated warning that background checks use plan allowance. Neither
supplies a design to copy. Findings are in the coordinator's local notes, not this repo.

Design ledger: prefer a small heartbeat responsibility using existing queue/publication policy over
a second scheduler. A tool-using general agent could gather richer context, but enlarges authority,
cost and retry uncertainty; a bounded read-only structured turn is the chosen design. A purely
deterministic rule engine is cheaper and testable but cannot reliably join remembered commitments
and interests; use it for eligibility/policy and measure the model's marginal usefulness. Reusing
the old card scanner unchanged is smaller but fails default-on Main conversation and memory/sports
requirements. Keep findings and Ben's later rulings here, including rejected options and evidence.

## Out of scope

Timed triggers such as “Liverpool kick off in 30 minutes” are a separate exact-time responsibility:
the heartbeat notices opportunities on its cadence, while an explicitly requested timed reminder
uses the existing scheduler. Both must share finding/coverage identity to avoid duplicate alerts;
turning off heartbeat leaves requested reminders intact. Creating fixture-relative triggers,
automatic reminder proposals, fixture-reschedule handling and precision guarantees are **deferred**;
V1 does not promise a 30-minute kickoff alert from a 30–60-minute opportunistic check.

Also excluded: general watches/actions from the deferred scheduled-task roadmap, autonomous writes,
email scanning, new external messaging channels, new connectors/OAuth, general web/sports crawling,
a new workflow engine, replacement of daily briefings/Today cards, side-chat routing configuration,
and a generalized monitoring-provider platform beyond the narrow required public source seams.
No app-map runtime declarations change until the corresponding product behavior is implemented.
