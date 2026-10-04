# Classifier gate for chat

Status: draft for Ben's review, 2026-10-01. Builds on #2594 (the sorting model, closed) and the System
One provider (#2586, closed). Approved by Ben in discussion on 2026-10-01 with the section 5 rulings
recorded in the plan (`../plans/2026-10-01-classifier-gate-for-chat.md`, "Rulings"), including the
privacy ceiling and private-chat bypass; retention is settled by ruling 16 (kept until the owner
deletes them, 2026-10-02). Build tasks are tracked on the board.

Amended 2026-10-03 (#2984): connected tools are on by default and sorted by Moss, with no per-tool
review. Section 8 holds the amendment; sections 3.2, 3.5, 3.6, 3.10 and 3.12 are edited to match.

## 1. The problem

Every chat message goes to the user's default model, including "turn off the kitchen lights". That is
slow and costs money for work that only needs a tool picked and one or two values filled in. The
sorting model (#2594) already gives Moss a small, fast model for pick-one and yes/no questions, but
chat does not use it.

## 2. Decisions already made

- The gate sits in front of every chat message.
- The model behind it is whatever the user selects in the sorting model setting, renamed "Classifier".
  It can be a local model or an API model. No provider or model name appears in code.
- A message the gate does not handle goes to the user's default model, whichever provider that is.
- The gate must work in YOLO mode, not only when approval prompts are on.
- The first routing question and the area question are one question.

## 3. Design

### 3.1 Where it sits

The gate runs after a message is accepted and before a turn is started on the default model. If it
handles the message, no turn starts. If it declines for any reason, the turn starts exactly as today,
with the original message. The plan must confirm the exact seam in the chat module before work starts.

### 3.2 Quick checks (code, no model)

The gate declines at once when any of these is true.

- The message has an attachment.
- The message is over 2,000 bytes.
- No classifier is set, or the gate is switched off.
- The gate is cooling off after a failure (section 3.9).
- The user has no eligible tool (section 3.5).
- The chat is private. Private chats bypass the gate entirely, with no classifier call and no shadow
  record.

### 3.3 Question 1: which area, or none

One choice question to the classifier. The criteria are one entry per installed module that has at
least one opted-in tool, each with a one-line description, plus two fixed entries.

- `none`: the message needs the default model (open-ended, conversational, writing, reasoning).
- `needs_earlier_conversation`: the message only makes sense with previous turns ("make it brighter",
  "do that again").

The area is the module. Tools already carry a module id, so no new grouping field is needed. A very
large module may later split into sub-areas; version one does not.

The classifier may see anything the default model would see for the same message (Ben, 2026-10-01).
That is the ceiling, and credentials and secrets stay excluded as they are for the default model.
Version one sends only the message and the menu descriptions, to keep calls fast and cheap. Recent
turns, memory and candidate lists (such as device names) may be added within the ceiling.

### 3.4 Question 2: which tool, and its values

A second choice question lists that module's opted-in tools, again with `none`. The classifier then
supplies argument values in one of two ways, depending on what the configured classifier can do.

- **Pick from a list.** Every argument is an enum in the tool's input schema, or the tool supplies a
  short candidate list (for example the names of the user's lights). The classifier chooses a value.
  Every kind of classifier can do this.
- **Extract a typed value.** Free text or a number ("remind me to call mum", "10 minutes") needs a
  classifier that can return extracted fields. System One returns choices, yes/no and scores only, so
  with it a tool that needs free-text arguments is not eligible and the message goes to the default
  model. A classifier kind that can extract fields (a small model with structured output, or a
  function-calling model) makes those tools eligible. The router reports which kind of answer the
  configured classifier can give, and the gate filters the menu to match.

After the pick, code validates the tool name and every value against the tool's input schema. The raw
message is never passed to the tool.

### 3.5 Tools opt in

A tool joins the menu only if it declares so. The default is off, so no existing tool changes
behavior. An opted-in tool declares:

- a one-line description for the classifier
- the candidate values for any argument that is not an enum
- the reply template (section 3.7)

Third-party modules can opt in the same way. First-party tools to opt in first: smart home switches
and scenes, add a task, today's calendar, timers. The exact list belongs in the plan.

Tools from a user's connections work the other way round (section 8). They have no module author to
declare them, so Moss prepares them itself. Every connected tool that is on for ordinary chat is on
for the classifier once the connection's classifier switch is on and the tool is sorted and prepared.
The user only takes tools out.

### 3.6 Safety: the gate inherits the existing rules

The gate runs the chosen tool through the same gateway call path chat uses now. It adds no second set
of rules. That path already provides:

- the per-tool risk level (`read`, `write`, `outbound`, `destructive`). A connected tool's level
  comes from Moss's sorting pass (section 8.2) and sets the gate's confidence bar. Outside YOLO a
  safe group runs without asking, and Sensitive or unsorted tools ask (section 8.3)
- the user's trust setting per tool family and the per-call confirmation override
- YOLO handling. A non-read tool in YOLO mode still goes to an approval card when its family is not
  trusted for auto-run or a per-call override applies, and it is rate limited
- the audit record and the actor's row-level security

The gate adds three constraints on top.

1. **Higher confidence for higher risk.** Each answer carries a confidence. The bar rises with the risk
   level: read 0.90, write 0.95, outbound and destructive 0.98. The numbers are starting points taken
   from the autonomous-os design (0.90 pick, 0.40 lead over the runner-up, 0.95 action fit) and are set
   in shadow mode (section 3.10), not guessed.
2. **A clear lead.** The top choice must lead the runner-up by at least 0.40.
3. **No approval card from the gate in version one.** If the gateway would ask for approval, the gate
   declines and the default model handles the message and shows the usual card.

### 3.7 The reply is written by code

The classifier never writes text. Each opted-in tool declares a short reply template filled from the
tool's result, for example "Kitchen lights off." A tool that cannot be summarized in a template is not
eligible, which keeps open-ended read results (a long calendar, search results) on the default model
until they have a template worth trusting.

### 3.8 When the tool fails

- **Read tool fails:** decline and let the default model handle the original message.
- **Write, outbound or destructive tool fails:** show the failure in code and stop. Passing the message
  to the default model could repeat an action that half-ran (#2175 exists because of repeated actions).

### 3.9 Time and failure limits

- One time budget of 3,000 ms covers both questions, with no retries.
- A timeout, error or malformed answer makes the gate decline that message and switch itself off for
  30 seconds, so a sick classifier never slows chat.
- The gate never blocks a message. Every failure path ends at the default model.

### 3.10 Shadow mode first

The setting has three states: off, shadow, on.

- **Shadow** runs the gate on every message, records what it would have done, and changes nothing.
  The default model answers as today.
- The record holds the module, tool, confidence, the decision, and whether the default model's first
  tool call matched. It is stored in an owner-only table under row-level security. The message text is
  stored there too, because accuracy review needs it. It never goes to logs or job payloads.
  Records are kept indefinitely; the owner can delete their own on request, enforced by row-level
  security with no admin bypass (Ben, ruling 16, 2026-10-02). Account deletion removes them too.
- **Kill gate:** the gate does not go to "on" until shadow data shows its picks agree with the default
  model's at an acceptable rate. The rate and the review window are set by Ben when the data exists.
  Since the 2026-10-03 amendment this is one admin review per classifier selection, recorded once for
  the instance. It is not a per-tool approval (section 8.5).

### 3.11 Settings, privacy and naming

- Rename "Sorting model" to "Classifier" in settings, the app map, the help text and docs.
- Add the gate state (off, shadow, on) beside it, default off.
- The row's help text must say that when the classifier is an API model, each chat message is also sent
  to that provider, in addition to the default model's provider.
- Whether the gate state is per user or admin-wide is open (section 5).

### 3.12 What the user sees

Ben agreed three mockups on 2026-10-01, in `docs/superpowers/mockups/classifier-gate/` (PR 2875).

- **Settings row** (`settings-row.html`). Renamed "Classifier", with an Off / Shadow / On control in
  the app's standard segmented style. Short help line plus brief "?" pop-ups, no long paragraphs. An
  API model shows one line saying eligible chat messages also go to its provider. On stays greyed out
  until shadow results are reviewed.
- **Connection setup.** Superseded on 2026-10-03. The per-tool review in `connection-setup.html` is
  replaced by the connection screen in `docs/superpowers/mockups/integrations-redesign/` (PR 2985),
  described in section 8.6.
- **Model activity log** (`audit-log.html`). An admin-only feed of every model call, grouped by day:
  action, one-line outcome, time, kind (chat answer, classifier, background task), the actual model
  name and a result. It shows the action taken, not the chat text. Filters: kind, model, result, time.

There is no marker on chat replies (Ben, 2026-10-01). The log replaces it as the way to trace a wrong
answer.

## 4. Out of scope for version one

- Replies written by the classifier (greetings, small talk, "what time is it" as free text).
- Conversation history sent to the classifier.
- A phrase-matching stage before the model. It would save one round trip for the most common commands
  and can follow once shadow data shows which phrases dominate.
- An approval card raised by the gate.
- Sub-areas inside a module.

## 5. Open questions for Ben

1. Is the gate state per user or admin-wide? Per user fits "private by default"; admin-wide fits the
   fact that the classifier itself is an admin pick today.
2. Which first-party tools opt in first? A short list of harmless switches and reads is the safe start.
3. When the gateway would ask for approval, version one declines. Do you want the gate to raise the
   card itself in a later version?
4. What agreement rate in shadow mode is enough to turn the gate on?

## 6. Build slices (sketch, for the plan)

The 2026-10-03 amendment's slices are in the plan, "Revision 2".

1. Rename to Classifier, add the gate state, app-map and manifest updates. No behavior change.
2. Tool opt-in declaration, reply templates, and the candidate-list hook in the module SDK.
3. The gate in shadow mode: quick checks, two questions, validation, the decision record.
4. Turn on for the first opted-in tools, with the live-path proof recorded on the PR.
5. The marker on gated replies.

## 7. Verification

- A test that gates a risky tool at a confidence below its bar must be seen failing with the bar
  removed.
- A test that the gate declines on an attachment, an oversize message, a cooling-off gate, and a
  classifier error, and in each case the default model turn starts with the original message.
- Live-path proof through the real UI on a dev instance, in normal mode and in YOLO mode, including a
  tool the YOLO rules would send to an approval card (the gate must decline it).

## 8. Amendment 2026-10-03: connected tools on by default (#2984)

Ben prepared Home Assistant's 29 tools by hand on a live instance and ruled that per-tool review is
too much work for users. This section replaces the per-tool review flow for connected tools. The
agreed screens are in `docs/superpowers/mockups/integrations-redesign/` (PR 2985), whose "Decided"
list records the same answers.

### 8.1 Rulings (Ben, 2026-10-03)

1. No per-tool review, no Prepare button and no per-tool risk choice. Every tool starts on. The user
   only switches tools off.
2. Moss sorts each tool's risk with one cheap model pass. The pass runs even when the classifier is
   off.
3. Risky tools start on, but still ask before they run.
4. A tool row's menu has "Keep out of the classifier". The tool stays on for ordinary chat.
5. Readable tool names. A free rule names a tool at once. The sorting pass replaces that name with a
   model-written one in the same call.
6. The name stays "Classifier".
7. A line on the connection's page says the default chat model, and its provider if hosted, reads
   each tool's name, description and inputs when sorting. There is no one-time notice for sorting.
8. A connection's page hides the settings list so the tools get the full width, with a "Back to
   connections" link.

Ruling 7's line names inputs as well as name and description, because the pass sends input schemas
(section 8.2). The mockup's shorter wording must not ship, since it would understate what is sent.

### 8.2 The sorting pass

- **When.** On connection add, and when discovery finds new or changed tool definitions. Only new and
  changed tools are sent. An unchanged definition is never sorted twice. Never per chat message.
- **Model.** The user's current default chat model, through the same selection preparation already
  uses. Never the classifier. No provider or model name in code.
- **Sent.** For each tool: its raw name, its description and its input schema, with credential
  header parameters and default or example values removed, as preparation does today. Nothing else.
  Never the connection address, sign-in details, headers, secrets, device lists or tool results.
- **Batched.** One call covers many tools, with a bound on tools per call and on output size.
- **Returned per tool.** A group and a readable name. Groups map to risk.

| Group            | Risk          |
| ---------------- | ------------- |
| Looks things up  | `read`        |
| Changes things   | `write`       |
| Sends things out | `outbound`    |
| Sensitive        | `destructive` |

- **Risk rule, in code.** A tool's risk is the higher of the model's group and the tool's own signal
  that raises risk (a destructive hint, a web service's delete method). A read-only hint or a web
  service's read method never lowers the model's group. A tool the model skips or answers invalidly
  is Sensitive.
- **Before sorting finishes** a tool has no group. It works in ordinary chat, asks before it runs
  and is out of the classifier.
- **Readable name.** Code makes one at once from the raw name: split the words, drop a prefix the
  tools share, sentence case. The model's name replaces it after validation as bounded plain text.
  The name is for display only. The raw name stays the tool's identity, shows small underneath and
  stays searchable.
- **Untrusted data.** Tool names, descriptions and model answers are data, never instructions. The
  prompt carries a worked example and the untrusted-data contract, under 150 words.
- **Storage.** On the owner's connection row: group, readable name, definition fingerprint and
  sorted time. Owner-only row-level security with no admin bypass. Deleted with the connection. Job
  payloads carry only the connection ID, the actor and the job kind.
- **On screen.** While the pass runs, tools list A to Z with a "Sorting" note. Afterwards they group by
  what they do. A web-service connection keeps its own sections on screen; its risk still follows
  the rule above.

### 8.3 Safe tools run, risky tools ask

Ben ruled on 2026-10-04 that connected tools Moss sorts as safe run without asking, and risky ones
still ask, outside YOLO (section 8.10).

- **Safe.** A tool sorted Looks things up, Changes things or Sends things out runs without a card in
  ordinary chat, and the gate may run it under that group's bar (section 3.6).
- **Risky.** A tool sorted Sensitive starts on and asks before every run, from ordinary chat and
  from the classifier. The page marks it "Asks first".
- **Fails closed.** A tool with no sort, a failed sort, a stale sort (its definition fingerprint has
  changed) or an unreadable sort record is treated as risky and asks. A tool the model skips or
  answers invalidly is already Sensitive (section 8.2).
- **YOLO.** YOLO mode skips the asking. It is off by default and admin-only. Decisions D1 and D2 of
  `docs/superpowers/specs/2026-06-29-admin-yolo-auto-approval-mode.md` (locked with Ben,
  2026-06-29) auto-run calls that would otherwise ask, destructive ones included. Issue 2419's
  exception covers first-party destructive tools only, and connected tools are external tools.
- **Confidence bar.** The sorted group sets the gate's bar. Sensitive needs 0.98.
- **The gate never raises a card** (section 4). It declines whenever the gateway would ask, so the
  main model handles the message and shows the usual card.
- The user cannot change a tool's group in version one.

#### The gateway change

Today every connected tool asks with YOLO off, because its synthetic manifest carries risk
`outbound` and the gateway's ordinary policy confirms every outbound tool. The change:

- The integrations module marks a connected tool's synthetic manifest as sorted safe only when the
  owner's stored sort for that tool is a safe group and its fingerprint matches the current
  definition. Every other case leaves the mark off.
- The gateway's ordinary policy runs an external tool that carries the mark, unless a per-call
  confirmation override applies. The check sits after the destructive check and before the outbound
  check. A first-party outbound tool never carries the mark and still asks.
- Manifest risk stays `outbound` and execution policy stays as it is. YOLO handling is unchanged.
- The mark is read at call time from the owner's row under owner-only security. A sort record that
  cannot be read gives no mark.
- This changes ordinary chat with the classifier off too, so the slice that ships it carries a
  user-facing release note.

### 8.4 The connection's classifier switch

- "Let the classifier use this connection" stays, one per connection, default off.
- Turning it on shows the one-time notice that ships today: what is sent, who reads it, the cost and
  what is never sent. Moss then prepares every sorted tool that is on, with progress.
- Preparation output is validated and saved directly, with no review step. The model still never
  writes executable template code, never sets risk and never approves a tool.
- Ready reads, for example, "74 of 75 tools can answer quick requests. 6 always ask you before they
  run." A short line under it says YOLO mode skips the asking.
- A changed tool is sorted and prepared again by itself, and its row says "Preparing again". Until
  then it is out of the classifier and still works in ordinary chat. A new tool starts on.
- A failed sort or preparation shows "Try again". No automatic retry repeats the cost.
- A lost connection pauses the classifier for it, which resumes by itself after the next successful
  discovery.

### 8.5 Eligibility and the release record

A connected tool is eligible for the gate when every condition holds. This replaces "opted in by the
user, with a reviewed risk".

- The connection is enabled and its classifier switch is on.
- The tool is on for ordinary chat.
- The tool is not kept out of the classifier.
- Its sort and preparation match its current definition fingerprint.
- Its inputs suit the configured classifier, with current candidates where needed (unchanged).

The built gate has a per-tool release table, written only by an admin in plan task 4.2. The On
setting needs at least one row, and the gate checks every tool against those rows. This amendment
changes both.

- **Connected tools.** The sorting pass and preparation produce the release. The eligibility above
  is the release, stored on the owner's row under owner-only security. No admin writes it or can see
  it.
- **Module tools.** First-party and external module tools are released by their author's
  declaration (section 3.5).
- **Kill gate.** One admin record per classifier selection holds Ben's shadow review (section 3.10).
  Ben ruled on 2026-10-04 that one review per classifier is enough, with no per-tool sign-off.
  That record unlocks On. The gate's effective state is checked when read, so a changed classifier
  selection or a deleted record drops it back to shadow at once. This closes the known gap where a
  stored On outlived its releases.
- **Retired.** The per-tool admin release table is no longer read or written. A later migration
  drops it.

### 8.6 The connection's page

- The settings list is hidden so the tools get the full width, with "Back to connections" at the top.
- Each tool shows its readable name in bold and its raw name small and faint underneath.
- Tools group by what they do once sorted. Sensitive tools show "Asks first", and one short line
  says YOLO mode skips the asking.
- Each tool keeps one switch for ordinary chat. Its menu holds "Keep out of the classifier".
- A side rail holds the classifier switch and its states: off, turning on (the notice), preparing,
  ready, a tool preparing again, could not prepare, and connection lost.
- The Connection block says when the tools were sorted, and that the default chat model (and its
  provider, if hosted) read each tool's name, description and inputs to sort them.
- The rest of the connections redesign (the list page, search, filters, broken-connection rows) is
  that redesign's own work. This amendment needs only the pieces above.

### 8.7 What changes in the built gate

| Part                      | Before                                                 | After                                                                                     |
| ------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Tool opt-in (plan 2b.2)   | Off until the user opts each tool in                   | On by default; a "kept out" choice replaces opt-in                                        |
| Risk (2b.2)               | Chosen by the user; unknown means ineligible           | Set by the sorting pass and the code rule; unsorted means ineligible                      |
| Preparation (2b.3)        | The screen requests drafts; the user saves each tool   | A background job prepares every eligible tool and saves validated output                  |
| Review editor (2b.4)      | Per-tool editor with a diff and approve                | Removed; replaced by section 8.6                                                          |
| Changed tool (2b.2)       | Stale until the user prepares and reviews it again     | Sorted and prepared again by itself                                                       |
| Release record (1.2, 4.2) | Admin rows per tool; On needs one row                  | Connected tools released by sort and preparation; On needs the admin shadow-review record |
| Ordinary-chat approval    | Every connected tool asks outside YOLO                 | Safe groups run; Sensitive, unsorted and stale tools ask; YOLO skips the asking           |
| Notice                    | One-time notice before preparing                       | Kept for the classifier switch; sorting has a page line instead                           |
| Tool names on screen      | Raw names                                              | Readable name, raw name underneath                                                        |
| Live proof (2b.6)         | Prepare, edit and approve a draft; opt in chosen tools | All tools on with no review; sorting calls counted; safe runs and Sensitive asks          |

Stored preparation entries from the old flow convert once. An entry the owner saved with opt-in off
becomes kept out, because that may have been a choice. An owner-reviewed risk is kept only when it is
higher than the sorted group.

### 8.8 Security posture

- Only tool names, descriptions and input schemas reach the sorting and preparation prompts, with
  credential header parameters and default or example values removed. Secrets never do.
- Groups, readable names and prepared text are private owner data. They never reach logs or job
  payloads.
- Code signals can raise a tool's risk, never lower it. A model answer can never lower risk below a
  code signal, and a read-only hint never lowers risk at all.
- Gate execution still goes through the gateway, whose only change is the sorted-safe check in
  section 8.3. Kept-out, ordinary-chat state and the definition fingerprint are checked again at
  dispatch.
- Only a current safe sort lets a connected tool run without asking. No sort, a failed or stale
  sort, or an unreadable record means it asks.
- Tests seen failing with the guard removed: secrets absent from the sorting prompt for a
  connection whose configuration holds a secret; a Sensitive, unsorted or stale tool asking with
  YOLO off; a first-party outbound tool still asking; and a Sensitive tool refused by the gate below
  the 0.98 bar.

### 8.9 Out of scope

- A per-tool risk choice by the user.
- A per-tool "run without asking" setting.
- A gate-raised approval card.

### 8.10 Decided after review (Ben, 2026-10-04)

1. One look at the shadow-review report per classifier selection is enough to unlock On. There is no
   per-tool sign-off (section 8.5). This replaces plan task 4.2's rule that one tool's results must
   not release another.
2. Connected tools Moss sorts as safe run without asking, and risky ones still ask, outside YOLO.
   This needs the gateway change in section 8.3.
