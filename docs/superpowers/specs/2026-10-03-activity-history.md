# One activity history that says what Moss did

- **Date:** 2026-10-03
- **Status:** Draft for Ben's review. Design only; nothing is built.
- **Mockup:** [`assets/2026-10-03-activity-history/index.html`](assets/2026-10-03-activity-history/index.html)
  (open with `#detail` for the dialog, `#all` to tick every model)
- **Replaces:** the admin-only Model activity settings page (plan 3.6a, #2889)

## 1. Problem

The Model activity page shows lines such as "choices - Structured call - Answered - qwen3:4b".
Ben's verdict: "Just saying structured call and answered doesn't tell me anything. I don't know
how to tell if Jev is doing the job correctly." Jev is the small classifier model that guesses,
before the chat model starts, which single tool a chat message needs.

The causes, verified on main:

- `recordModelActivity` (`packages/ai/src/model-activity.ts`) receives only kind, action label,
  outcome, model name and a fixed result word (`completed`, `failed`, `stopped`). It has no
  owner, no duration, no tokens and no turn link.
- The classifier writer records action `choices` and result `completed`. The decision, tool,
  confidence and agreement live in the owner-only shadow table
  (`packages/chat/sql/0251_chat_classifier_shadow_records.sql`, 7-day expiry), which the page
  cannot read.
- The page (`settings-model-activity-pane.tsx`) does not even render the stored `result`.
- The tool actions a chat answer ran live on a separate page, Activity
  (`settings-activity-pane.tsx`, action audit log, owner-only). The two pages never meet.

## 2. Rulings carried by this spec

Ben, 2026-10-03.

1. **Muse-style history.** Each line has a title saying what Moss did, a sub-line with the
   result, and small text with time, model and duration. Lines group by day. Clicking a line
   opens a **modal dialog** over the page: close button top right, status badge and title at the
   top, steps on the left, the selected step's detail (timing, tokens, failure reason in plain
   English) on the right.
2. **Every kind of model call** gets a real line: chat answers, the classifier, structured calls,
   embeddings, transcription, provider checks, background tasks, module builds (table in §4).
3. **One personal page.** Everything moves into the existing per-user Activity page. Each person
   sees what each model did for them, beside the tool actions already listed there. The
   admin-wide Model activity page is retired.
4. **Owner-only storage throughout.** Activity rows carry an owner and row security limits them
   to that owner. No admin sees another person's lines.
5. **Quoted words expire after 30 days.** The bare line stays.
6. **Lines come from recorded facts,** never from an extra model call that summarises.
7. **Filters:** keep the module filter and time range; add a model checklist (so embeddings can
   be unticked); remember the last choice in the browser; show a Reset filters button in the
   filter bar whenever a filter differs from the default. **No result filter.** Lines still carry
   their "Did not work" and "Jev disagreed" badges.
8. **Layout:** use the horizontal space, no big side gutters; no button or text crowds its
   neighbour.
9. **Old lines are deleted.** Lines recorded before this ships have no owner. The migration
   deletes them; they do not become System lines.
10. **Jev's numbers live in the shadow report, not on Activity.** The Activity page has no Jev
    rail. Jev's agreement numbers move to a shadow report reached from the chat gate's Shadow
    mode in Settings, AI (§11).

## 3. The page

### 3.1 Line anatomy

| Part     | Source                                            | Example                                                                                                                        |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Time     | Bare line, own left column                        | 09:41                                                                                                                          |
| Title    | Fixed per action code (§4)                        | Answered a chat message                                                                                                        |
| Quote    | Owner detail, first 140 chars                     | "Turn on the kitchen light and tell me what's on..."                                                                           |
| Sub-line | Template over recorded facts (§4)                 | Turned on the kitchen light, read 3 events, weather did not answer. Jev picked Home Assistant first and the chat model agreed. |
| Meta     | Bare line columns                                 | Claude Sonnet 4.6 - 6.2s - 5 steps                                                                                             |
| Badge    | Outcome or flag, right-aligned, only when notable | Did not work / 1 step failed / Jev disagreed / System                                                                          |

- The time sits in its own narrow left column so the eye can run down it; the meta keeps model,
  duration and step count. On a phone the badge drops under the meta instead of sitting at the
  far right.
- Successful lines carry no badge. A badge appears only for a failure, a partial failure, a Jev
  disagreement, or a System line.
- After 30 days the quote and sub-line facts that quote content are gone. The line keeps its
  title, a content-free sub-line from the bare columns (for example "Used 3 tools, 1 failed"),
  and meta.
- Tool actions that ran outside chat (routines, schedules, proactive actions) stay as their own
  lines with "no model" in the meta.

### 3.2 Grouping

- A **chat answer is one line.** Its steps are, in order: the Jev check, each tool action the
  turn ran (the existing action audit rows for that turn), and the chat model's answer.
- **Standalone model calls** (sorting, briefing, embeddings, transcription, module builds,
  provider checks) are their own lines. A multi-call job (a module build) is one line whose
  steps are its model calls.
- A tool action with a turn link never shows as a separate line; it shows inside its chat
  answer.

### 3.3 Detail dialog

Built on the `Dialog` primitive with a layout-only size class.

- **Head:** status badge(s), title, meta (time, model, total duration, tokens in and out,
  surface), the quoted words, and a Close button top right. Escape and a scrim click also
  close.
- **Left column, steps:** number, title, result line, small meta (model or module, approval
  mode, duration). The first failed step is selected on open; otherwise the first step. The steps
  are a list box: the selected step takes focus and the up and down arrow keys move the
  selection.
- **Right column, selected step:**
  - eyebrow "Step 4 of 5 - tool action" and the step title
  - "Why it did not work" panel when the step failed, written from a failure code (§5.4)
  - facts table: started, took (with the time limit when one applied), asked for, returned,
    approval, model, tokens in and out, Jev confidence and runner-up for a Jev step
  - expiry note: "Moss deletes the quoted words and step details on 2 November. The line itself
    stays."
- After expiry the dialog still opens and shows the bare facts per step (titles, durations,
  outcomes, failure reasons, tokens).

## 4. Line per call kind

Writers verified from the brief and code on main. Examples are made up. "Bare" is what the line
shows after the 30-day expiry.

| Writer (where it records)                        | Action code             | Title                                                            | Sub-line, with owner detail                                                               | Sub-line, bare                         |
| ------------------------------------------------ | ----------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| Chat turn, API-key provider (`http-api` adapter) | `chat.answer`           | Answered a chat message                                          | Turned on the kitchen light, read 3 events. Jev picked Home Assistant; chat model agreed. | Used 2 tools. Jev agreed.              |
| Chat turn, CLI provider (chat multiplexer)       | `chat.answer`           | Answered a chat message                                          | Same as above                                                                             | Same as above                          |
| Classifier (`generate-choices`, today `choices`) | `chat.tool_check`       | Step: Jev guessed which tool to use                              | Would use Home Assistant: turn on light, 92% sure. Chat model agreed.                     | Picked a tool, 92% sure. Chat agreed.  |
| Structured call, CLI (`cli-structured-adapter`)  | `structured.<service>`  | From the service's manifest title, e.g. Sorted new email         | Filed 12 emails: 3 to Needs you, 9 to Later.                                              | Finished. / Did not work: wrong shape. |
| Structured call, API key (`http-api` adapter)    | `structured.<service>`  | Same                                                             | Same                                                                                      | Same                                   |
| Embeddings (`packages/memory`)                   | `embed.<source>`        | Indexed notes for search                                         | Embedded 24 passages from 3 notes: "Garden plan", "Boiler service", "Trip ideas".         | Embedded 24 passages.                  |
| Transcription                                    | `transcribe.voice_note` | Transcribed a voice note                                         | 38 seconds of audio, 41 words. Quote: first words of the transcript.                      | 38 seconds of audio.                   |
| Background task (worker), per user               | `task.<job>`            | e.g. Prepared the morning briefing                               | Briefing ready: 5 sections, 2 meetings flagged, 1 parcel arriving.                        | Finished.                              |
| Module build                                     | `module.build`          | Built a module draft                                             | None; a System line, always bare                                                          | Draft written. 6 model calls.          |
| Provider check (chat multiplexer probes)         | `probe.reachable`       | Checked that a model is reachable                                | Claude Sonnet 4.6 answered. (No owner detail; always bare.)                               | Answered. / Did not answer in 30s.     |
| Tool action outside chat (action audit log)      | existing tool name      | Existing plain action sentence, e.g. Turned something on at home | Hallway light on, from your 'Leaving home' routine.                                       | Done, from a routine.                  |

Rules for the table:

- Titles are a fixed vocabulary in code, not stored text. Structured-call titles come from the
  calling module's manifest (§9) so a module names its own work; an unknown service falls back
  to "Ran a structured task".
- Sub-lines are templates filled from recorded facts. No model call writes them (ruling 6).
- The build plan must re-verify the writer list with a call-site search; the list above comes
  from the brief and two file reads.

## 5. Storage and privacy

### 5.1 Bare line: extend the model activity log

New migration in `packages/ai/sql/` (next free global number at build time; 0254 is the latest
known). Never edit 0254.

`app.moss_model_activity_log` gains:

| Column          | Type         | Notes                                                                                              |
| --------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `owner_user_id` | uuid null    | FK `app.users` on delete cascade. Null means a System line (§5.5)                                  |
| `action_code`   | text null    | Fixed vocabulary from §4, CHECK length                                                             |
| `turn_id`       | text null    | Links chat steps; same value the shadow table and audit rows carry (§5.3)                          |
| `parent_id`     | uuid null    | Self-FK; a step's line id when the call is a step of a bigger line                                 |
| `duration_ms`   | integer null |                                                                                                    |
| `input_tokens`  | integer null | Null when the provider does not report                                                             |
| `output_tokens` | integer null |                                                                                                    |
| `failure_code`  | text null    | Allow-listed vocabulary (§5.4), never a raw error message                                          |
| `fact_counts`   | jsonb null   | Small numbers only: `{"tools":3,"tools_failed":1,"jev_agreed":true,"confidence":0.92}`. CHECK size |

Row security changes in the same migration:

- Drop the admin read policy. New SELECT policy:
  `app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id()`,
  plus `owner_user_id IS NULL AND app.current_actor_is_admin()` for System lines.
- INSERT `WITH CHECK` becomes owner-or-null: a writer may insert a row for the current actor, or
  an ownerless row. It may not insert a row owned by someone else.
- Still append-only: no UPDATE, no DELETE. Bare lines are kept forever (existing ruling 14,
  2026-10-01) from this release on.
- **Existing rows are deleted** (ruling 9). The migration runs
  `DELETE FROM app.moss_model_activity_log` before it adds the new columns and policies, so no
  pre-release row survives to be read as a System line. The detail table is created after the
  delete, so nothing cascades.

`fact_counts` holds numbers and booleans only, so the bare sub-line and the shadow report (§11)
survive expiry without keeping words. A JSON schema in code and a size CHECK in SQL keep text out.

### 5.2 Owner detail: new table

`app.moss_activity_detail`, same migration:

| Column          | Type                 | Notes                                                         |
| --------------- | -------------------- | ------------------------------------------------------------- |
| `activity_id`   | uuid PK              | FK to `moss_model_activity_log(id)` on delete cascade         |
| `owner_user_id` | uuid not null        | FK `app.users` on delete cascade; must equal the line's owner |
| `quote`         | text null            | The user's words, CHECK at most 2000 bytes                    |
| `result_line`   | text null            | Filled template, CHECK at most 500                            |
| `steps`         | jsonb not null       | Array of `{title, result, asked_for, returned}`, CHECK size   |
| `created_at`    | timestamptz          |                                                               |
| `expires_at`    | timestamptz not null | `created_at + interval '30 days'`                             |

- FORCE row security. SELECT, INSERT and UPDATE are owner-only with the same expression as 0251. No admin policy, no share policy.
- UPDATE exists so a later fact can land (the chat model's first tool call settles after the
  Jev check is recorded). Owner-only, and it may not change `owner_user_id` or `expires_at`.
- Reads also filter `expires_at > now()`, so a row the purge has not reached yet never shows.
- Ownerless lines never get a detail row.

### 5.3 Linking a chat answer to its steps

- Chat picks the answer line's id when the turn starts, so step lines can point at it, and
  writes the line itself when the turn ends. The bare table stays append-only, and the
  parent-id foreign key is deferred to the end of the transaction or dropped in favour of a
  plain uuid column; the build plan picks one.
- The Jev check and each model call in the turn write lines with `parent_id` set to it.
- Tool actions stay in the action audit log. That log already carries `request_id` and
  `chat_session_id` but no turn id; the build adds a nullable `turn_id` column there too
  (new migration in `packages/ai/sql/`), so the list query joins audit rows to their turn.
- The build plan must confirm the chat turn id is one value across the shadow record, the
  audit row and the activity line. If it is not, that is the first task.

### 5.4 Failure reasons

Raw provider errors can carry response bodies, so they are never stored. The writer maps the
error to a code, and the page maps the code to a sentence:

| Code            | Sentence                                                              |
| --------------- | --------------------------------------------------------------------- |
| `timeout`       | The {service} did not answer within {limit}, so Moss stopped waiting. |
| `rate_limited`  | {Provider} asked Moss to slow down. Moss will try again later.        |
| `auth_failed`   | {Provider} refused the sign-in. Check the account in Settings, AI.    |
| `bad_shape`     | The model's answer was not in the shape Moss asked for.               |
| `provider_down` | {Provider} was unreachable.                                           |
| `cancelled`     | You stopped it.                                                       |
| `tool_denied`   | You declined this action.                                             |
| `unknown`       | Something went wrong that Moss could not name.                        |

### 5.5 System lines

Provider checks, module builds, instance-wide jobs and anything else with no acting user are
written with `owner_user_id` null. They appear on admins' Activity pages with a "System" badge,
so they do not vanish when the admin page goes. Non-admins never see them. The module filter
gains a "System" option that shows only these lines. Ben agreed the label and placement on
2026-10-03.

### 5.6 Expiry job

- Function `app.purge_expired_moss_activity_detail()`: SECURITY DEFINER, no arguments, deletes
  detail rows with `expires_at <= now()`. EXECUTE granted to `jarvis_worker_runtime` only,
  following the 0251 purge function.
- A daily pg-boss schedule calls it. The payload is empty apart from job kind and idempotency
  key; no ids of private content, no text.

### 5.7 Retention summary

| Data                              | Kept                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Bare activity line                | Forever (ruling 14)                                                                                                 |
| Owner detail (quotes, step words) | 30 days                                                                                                             |
| Classifier shadow record          | 7 days (unchanged; the detail copies what the line needs at write time)                                             |
| Action audit row (tool actions)   | The page says 90 days. A purge function exists in 0127 and #2682 changed it; the build plan must confirm the cutoff |

### 5.8 Invariants checked

- **Private by default:** every row has an owner and owner-only row security; admins get only
  ownerless lines.
- **No admin bypass:** no policy grants admins another person's rows.
- **Secrets never escape:** no raw error text; `asked_for` and `returned` in steps are built from
  a tool's declared display fields only, and credential-typed fields are never copied.
- **Metadata-only job payloads:** the purge job carries nothing private. Recording happens in
  the calling process, not through a job.
- **Module isolation:** chat, memory and modules record through a public function in
  `@moss/ai`. No module reads another's tables; the shadow table is not read by the page.
- **Provider-agnostic:** the model name shown is whatever the router resolved; nothing is
  hardcoded.

## 6. Recording API

`recordModelActivity` gains optional fields, all fire-and-forget as today:

- `id` (caller-chosen, so a later fact can attach), `ownerUserId`, `actionCode`, `turnId`,
  `parentId`, `durationMs`, `inputTokens`, `outputTokens`, `failureCode`, `factCounts`
- `detail`: `{ quote, resultLine, steps }`, written only when `ownerUserId` is set, inside the
  owner's data context so the owner-only insert check passes
- `attachModelActivityFacts(id, facts)`: an owner-only update of the detail row, used by chat
  when Jev agreement settles. The agreement flag for the bare line goes on the chat answer's
  line, which is written when the turn ends, after agreement is known

`withModelActivityRecording` measures duration itself. The existing allow-listed result words
stay as the fallback when a writer passes nothing new.

## 7. Filters

### 7.1 The bar

Left to right: time range (Today, 7 days, 30 days, 90 days), module select, Models button, a
hidden-count note, then Reset filters at the right. The bar wraps with an 8px gap both ways.
There is no result filter (ruling 7).

### 7.2 Model checklist

- The Models button reads "Models: all" or "Models: 6 of 7" (the count includes "No model") and
  opens a checklist of models in
  the loaded range, each with a count, plus "No model (tool only)". Tick all and Done sit at the
  bottom.
- No primitive does this today (`Menu` closes on each pick). The build adds a checklist
  primitive to `packages/ui/src/` and its styles to `packages/ui/src/styles/`; the mockup's
  `.jds-checklist` classes are the proposed names.
- When unticked models hide lines, the bar says so: "9 entries hidden by the model filter".
- On a phone the checklist opens as a sheet from the bottom of the screen, with 44px rows.

### 7.3 Remembered filters and reset

- The filter state saves to the browser's local storage under a key that includes the user id,
  so two accounts on one browser do not share filters.
- The checklist saves the **unticked** models, so a model added later shows by default.
- On load the saved state is restored; unknown values are dropped.
- Reset filters shows whenever any filter differs from the default (30 days, all modules, all
  models). It restores the default and clears the saved state.

## 8. Layout

- The list takes the full content width. There is no side rail (ruling 10).
- The dialog is up to 1120px wide, with a 300-400px step column. On a phone (640px and
  narrower) it fills the screen and the selected step's detail opens directly below that step.
- On a phone every filter control and the dialog's Close button is at least 44px tall. The time
  range buttons take their own row.
- Spacing follows the minimum-gap table in `docs/design-system.md`: 4px between lines in one
  text block, 8px between buttons, 12px between a control and text.

## 9. App map

Same PR as the build:

- `packages/shared/src/app-map-core.ts`, entry `activity`: rewrite the description to cover
  model calls, the detail dialog, the model checklist, remembered filters, Reset
  filters, the 30-day expiry of quoted words, and System lines for admins.
- Remove the entry `modelactivity` and its settings section.
- Add the shadow report (§11) under Settings, AI, with its path from the chat gate.
- Each module manifest that calls structured models declares the title for its service in its
  `features` metadata, so the line title and the app map agree.

## 10. Out of scope

- Activity for other people, shares, or a household view.
- Exporting the history.
- Replaying or retrying a step from the dialog.
- Cost in money (tokens only).
- Backfilling owners or detail onto lines written before the build; those lines are deleted
  (ruling 9).

## 11. Follow-on: the shadow report

Ruling 10 moves Jev's numbers off the Activity page. They answer "is Jev doing the job" where
the decision is made: the chat gate setting under Settings, AI, Classifier.

- **Entry.** While the gate is in Shadow, the amber Shadow badge on the Classifier row becomes a
  link, and the line "On opens after shadow review" gains a "See shadow results" link. Both open
  the report. Clicking the Shadow option in the gate's switch still only changes the mode.
- **Numbers,** counted from the viewer's own activity lines (bare columns, §5.1) over a chosen
  range of 7, 30 or 90 days: chat messages checked, picked a tool, chat model agreed (x of y),
  missed a tool the chat used, typical time.
- **Disagreements.** A link lists the lines where Jev and the chat model disagreed; each opens
  the same detail dialog as Activity (§3.3).
- **Whose lines.** The gate is an admin setting, but row security is owner-only (ruling 4), so
  the report counts only the viewing admin's own chat messages. It does not show anyone else's.
- The report gets its own mockup before it is built. It is not part of the Activity build.
