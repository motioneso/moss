# Classifier gate for chat

Status: draft for Ben's review, 2026-10-01. Builds on #2594 (the sorting model, closed) and the System
One provider (#2586, closed). Approved by Ben in discussion on 2026-10-01 with the section 5 rulings
recorded in the plan (`../plans/2026-10-01-classifier-gate-for-chat.md`, "Rulings"). Candidate privacy
(3.3 against 3.4) and shadow retention are still open. No build issue exists yet.

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
- The user has no tool that opted in (section 3.5).

### 3.3 Question 1: which area, or none

One choice question to the classifier. The criteria are one entry per installed module that has at
least one opted-in tool, each with a one-line description, plus two fixed entries.

- `none`: the message needs the default model (open-ended, conversational, writing, reasoning).
- `needs_earlier_conversation`: the message only makes sense with previous turns ("make it brighter",
  "do that again").

The area is the module. Tools already carry a module id, so no new grouping field is needed. A very
large module may later split into sub-areas; version one does not.

The classifier sees only the one message and the area descriptions. It never sees chat history,
memory, or any stored data.

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

### 3.6 Safety: the gate inherits the existing rules

The gate runs the chosen tool through the same gateway call path chat uses now. It adds no second set
of rules. That path already provides:

- the per-tool risk level (`read`, `write`, `outbound`, `destructive`)
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
- **Kill gate:** the gate does not go to "on" for any tool until shadow data shows its picks agree with
  the default model's at an acceptable rate. The rate and the review window are set by Ben when the
  data exists.

### 3.11 Settings, privacy and naming

- Rename "Sorting model" to "Classifier" in settings, the app map, the help text and docs.
- Add the gate state (off, shadow, on) beside it, default off.
- The row's help text must say that when the classifier is an API model, each chat message is also sent
  to that provider, in addition to the default model's provider.
- Whether the gate state is per user or admin-wide is open (section 5).

### 3.12 What the user sees

A reply from the gate appears as a normal chat message with a small marker that it was answered without
the default model, so a wrong answer can be traced. The marker, and the Classifier settings row, need
mockups agreed with Ben before that part is built (Design System Guardrails).

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
