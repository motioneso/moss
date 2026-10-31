# Front door: the decision model answers simple messages first

- **Status:** draft for Ben's review, 2026-10-31. No task issue yet; one is opened on approval.
- **Builds on:** classifier gate for chat (`2026-10-01-classifier-gate-for-chat.md`, #2864, amended
  by #2984), decision model presets (`2026-10-05-decision-model-presets-design.md`, #3057), tool-call
  discipline (`2026-09-01-integration-tool-call-discipline.md`, #2175), Moss acts through its own app
  (`2026-10-05-moss-acts-through-app-design.md`, #3065), and the Phase 0 plan that lets the gate go
  straight to On (`../plans/2026-10-11-moss-extensions-phase0-decision-model-on.md`).

## 1. Summary for Ben

**What you asked for.** The small, fast decision model sits at the front. "Turn off the lights"
goes to it, it runs the tool and answers in a few words. Anything it is not sure about goes to the
thinking model, as chat works today.

**What already exists.** Most of this is built. The classifier gate already sits in front of every
chat turn, asks the decision model which area and which tool, checks the answer against
confidence bars, runs the tool through the normal safety path, and posts a reply. If it declines for
any reason, the thinking model answers. It has three switch positions (Off, Watch only, On). On the
production instance it has run in Watch only since 2026-10-04, and its On position is being freed
from the review step by the Phase 0 plan.

**What is actually new.** Three things.

1. **The reply.** Today code fills in a fixed sentence per tool ("Kitchen lights off."). You want
   the decision model to write the short reply. Jev and Clef cannot write sentences. They only pick
   from lists, answer yes or no, and give scores. So model-written replies only work if you connect
   a decision model that can write text. Plan: keep the fixed sentence as the safe default, and add
   a model-written reply as an option that is checked against the real tool result before it is
   shown. It falls back to the fixed sentence if the check fails.
2. **Reach.** The gate only offers tools that are prepared for it, and it cannot fill in free-text
   values with a pick-only model. The 2026-10-11 trial showed it never offered the Home Assistant
   lights. The front door must widen what it can handle without loosening safety.
3. **A visible record.** Activity history must say, for each message, which model handled it and
   how long that took. The pieces exist, but a handled turn does not yet name the deciding model on
   its own line.

**What stays the same.** Deleting things and sending things outside Moss still ask first. One
setting turns the whole front door off. Private chats never go through it.

**What I need from you.** The answers in section 14. The big one is whether model-written replies
are worth building at all, given that fixed sentences are faster and cannot make things up.

## 2. Ground truth from the current tree

Each row is something the design relies on, with where it lives.

| Fact                                                                                                                                                                                                                                            | Where                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A chat turn starts in the chat session manager, which calls `tryPreModelTurn` before launching the thinking model; a returned turn skips the model entirely                                                                                     | `packages/chat/src/live/chat-session-turn.ts` (call near line 206)                                        |
| `tryPreModelTurn` runs reminder, agreement and scheduled-read recognizers first, then hands over to `tryGatedTurn`                                                                                                                              | `packages/chat/src/live/pre-model-turn.ts`                                                                |
| `tryGatedTurn` reads the gate mode; anything but `on` returns no result. Private chats bypass it. Any gate error is a decline                                                                                                                   | `packages/chat/src/live/classifier-gate-lifecycle.ts`                                                     |
| Gate mode is an admin, instance-wide runtime setting `chat.classifier_gate_mode` with values off, shadow, on                                                                                                                                    | `classifier-gate-mode.ts`, `packages/shared/src/chat-api.ts`                                              |
| The gate asks the area question, then the tool question, then up to two argument questions, and checks each answer                                                                                                                              | `classifier-gate.ts`, `classifier-gate-arguments.ts`                                                      |
| Confidence bars: read 0.90; write, outbound, destructive 0.95; minimum lead over the runner-up 0.40; version `v2`                                                                                                                               | `classifier-gate-arguments.ts` (line 213 for the version)                                                 |
| Limits: 2,000 byte message cap, 3,000 ms floor deadline, 30 s cool-off after a failure. The deadline then follows the model's measured speed, up to 30 s                                                                                        | `classifier-gate.ts` (`GATE_LIMITS`), `classifier-gate-speed.ts`                                          |
| Decline reasons are a closed list (attachment, oversize, low confidence, low lead, invalid arguments, timeout, gateway declined, read failed and others)                                                                                        | `GateDeclineReason` in `classifier-gate.ts`                                                               |
| A handled turn carries origin `classifier_gate` and records no provider, model or usage on the message                                                                                                                                          | `ChatClassifierGateOriginV1` in `packages/shared/src/chat-api.ts`                                         |
| The reply is a code template filled from the tool result; a missing placeholder returns null and the gate treats it as failure                                                                                                                  | `renderReplyTemplate` in `classifier-gate-arguments.ts`                                                   |
| The classifier is whatever the admin picks in Settings. Two capabilities: `choice_only` (the System One kind, which covers Jev, Clef and compatible services) and `typed_extraction` (every other provider kind). No model name appears in code | `packages/ai/src/structured/classifier.ts`                                                                |
| Choice-only models cannot return typed values, so tools needing free-text arguments are ineligible for them                                                                                                                                     | same file, `extractClassifierValues`                                                                      |
| Tool risk is `read`, `write`, `outbound`, `destructive`. A connected tool's risk comes from Moss's sorting pass, and a sorted tool never reads below what the sort says                                                                         | `classifier-gate-wiring.ts` (`gateRisk`)                                                                  |
| If the gateway would ask for approval, the gate declines and the thinking model shows the card. The gate raises no card                                                                                                                         | gate spec section 3.6, item 3                                                                             |
| A failed write, outbound or destructive tool shows the failure and stops. It never replays on the thinking model                                                                                                                                | gate spec section 3.8; `GATE_STORAGE_FAILURE_MESSAGE` in the lifecycle file                               |
| Each classifier question writes a check line to activity history with a model name field. The endpoint is owner-scoped, with ownerless lines for admins                                                                                         | `packages/shared/src/ai-activity-lines-api.ts` (`ActivityLineDto.modelName`), `packages/ai/src/routes.ts` |
| Shadow records compare the gate's pick with the thinking model's first tool call and are kept until the owner deletes them                                                                                                                      | `classifier-gate-shadow.ts`                                                                               |
| The 2026-10-11 trial: 163 records, about 0.2 s per question with Jev, 108 of them `none`. The gate never offered lights because preparation dropped the target arguments                                                                        | Hindsight and memory note on the classifier production trial                                              |
| Rulings: no model pre-chosen or recommended in code or plan; no second extraction model; lights and switches run without asking when the offered device list excludes locks, doors and garage; no shadow review before turning On               | same note; Phase 0 plan                                                                                   |

## 3. The idea in one picture

    message
      |
      v
    quick checks (code): private chat, attachment, size, off, cooling off
      |
      v
    FRONT DOOR (decision model)  -- verdict: handle / ask / escalate
      |            |                  |
    handle        ask               escalate
      |            |                  |
    run tool    show approval      thinking model
    through     card, then run     answers as today,
    gateway     on approval        with the original
      |            |               message
      v            v
    reply (fixed sentence, or checked model-worded one)

The front door is the existing classifier gate, extended. It is not a second component. One
setting, one code path, one record.

## 4. Routing contract

The front door returns exactly one verdict per message. It never returns free text to the user
except through the reply step in section 6.

| Verdict  | Meaning                                                                                                                                          | What happens                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| handle   | One eligible tool, every argument filled and validated, confidence and lead above the bar for the tool's risk, and the gateway needs no approval | The tool runs through the normal gateway path, the reply is posted, and no thinking-model turn starts                                 |
| ask      | The tool is clear and filled, but the gateway requires a human yes (destructive, outbound without owner allowance, Sensitive or unsorted tool)   | An approval card is raised. On approval the tool runs and the reply is posted. On denial a fixed "Okay, I did not do that." is posted |
| escalate | Anything else                                                                                                                                    | The thinking model gets the original message exactly as today. Nothing the front door computed is added to its prompt                 |

Rules.

1. `ask` is new. Today the gate declines in this case and the thinking model shows the card. The
   early builds keep that behaviour (map `ask` to `escalate`) and the real card raise ships in
   slice 4 behind its own live proof. See open question 3.
2. Escalating is always safe and never an error. Every failure path ends in `escalate`.
3. The front door never sees the thinking model's reply and never edits the original message.
4. A verdict, its confidence, its lead and its reason code are written to the existing decision
   record (the shadow table) for every message in every mode that runs the gate, so Moss can read
   them to tune the decision model.

## 5. What counts as simple, and how confidence is measured

**Simple means all of these.**

- One action, one tool, one target. Compound requests ("turn off the lights and remind me at 6")
  escalate.
- The tool is on for the classifier (connected tools are on by default and sorted by Moss; built-in
  tools opt in through their declaration).
- Every argument is an enum, picked from a candidate list the system supplies, or, for a
  text-capable decision model only, a typed value that passes the tool's input schema.
- The message needs no earlier conversation (the existing `needs_earlier_conversation` choice).
- No attachment, 2,000 bytes or less, not a private chat.

**Confidence is the decision model's own scores, and nothing else.** The existing bars stay. Reads
need 0.90, write, outbound and destructive need 0.95, and every question needs a 0.40 lead over the
runner-up. The weakest number across all questions is the one that counts, as today.

For a text-capable decision model the scores come from the same choice question (the adapter asks it
to pick and score the options). These scores are less calibrated than a purpose-built decision
model's. So a new text-capable model may start under a stricter rule: its pick must agree across two
independent asks before it counts as `handle` (open question 6). Code never lowers a bar. A bar
changes only through a new `THRESHOLD_VERSION` and a recorded ruling.

**Widening reach without loosening safety.** The 2026-10-11 trial exposed the blockers.

- Preparation keeps a candidate-list argument (for example device names) from a live list, and marks
  other optional arguments as deliberately blank. The gate accepts "filled or deliberately blank".
- For on/off style tools the offered list excludes locks, doors and the garage. A lock-capable
  target is never offered. This is the ruling of 2026-10-11 and it is the safety control, so the
  filter is code, tested, and applied when the list is built, not left to the model.
- Free-text values go to the thinking model when the decision model is choice-only. No second
  extraction model (ruling, 2026-10-11).

## 6. The reply

The reply has two sources, and the order is fixed.

1. **Record sentence, always built first.** The tool's declared template filled from the validated
   tool result. Every piece of UI feedback renders from this. It exists for every handled turn.
2. **Model-worded reply, optional, text-capable models only.** The decision model is asked to
   reword the record sentence in at most 20 words, given only the tool name, the validated result
   and the record sentence. A boundary check accepts the wording only if it is within the length
   cap, contains every value that appears in the record sentence (names, numbers, states), contains
   no URL and no instruction, and adds no value that is not in the result. If any check fails, the
   record sentence is shown. There is no retry.

Determinism boundary. The record decides what happened. The model has exactly two jobs.

1. Pick the area, tool and argument values from offered lists (and typed values if capable).
2. Reword the record sentence.

Prompt guidance for each job stays under 150 words. If it grows past that, the design is wrong.

Choice-only models (Jev, Clef and compatible services) never get job 2. They always show the record
sentence. This is a limit of what those services return, not a preference.

## 7. Failure behavior

Every row ends at a safe place. Rows marked "stops" never fall through to the thinking model,
because the action may have half run.

| Event                                                                        | Result                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| No decision model, gate off, cooling off, private chat, attachment, oversize | escalate, no call made                                                   |
| The shared deadline passes (measured per model, 3 s floor)                   | escalate, and the gate cools off for 30 s                                |
| Provider error, malformed answer, unknown option, unusable scores            | escalate, and the gate cools off for 30 s                                |
| Answer below the bar or the lead, or the runner-up too close                 | escalate                                                                 |
| Argument fails the tool's input schema, or is not in the offered list        | escalate                                                                 |
| A read tool fails                                                            | escalate with the original message                                       |
| A write, outbound or destructive tool fails or cannot be confirmed           | stops: fixed failure sentence, no thinking-model turn                    |
| A handled turn cannot be saved after a non-read action ran                   | stops: the existing "That action ran, but its result could not be saved" |
| The user presses Stop during the attempt                                     | the turn stops, no fallback                                              |
| A model-worded reply fails its check                                         | the record sentence is shown and the failure is counted in the record    |

The front door never blocks a message past its time limit and never retries a model call.

## 8. Destructive and external-send actions keep asking

The front door adds no safety rules and removes none. It calls the same gateway path chat uses,
which already provides the risk level, the owner's trust setting per tool family, the per-call
override, the rate limit and the audit record, all under the actor's row-level security. On top of
that:

- Destructive, outbound-not-allowed-by-owner, Sensitive and unsorted tools never reach `handle`.
  They reach `ask` or `escalate`. A test must be seen failing with this rule removed.
- A tool's risk can only go up from what the sort pass says (`gateRisk`), never down.
- The raw message is never passed to a tool. Only validated argument values are.
- Yolo mode does not change the front door. A non-read tool whose family is not trusted still gets
  its card.
- A message that carries outside content (an attachment or module control) escalates.
- Secrets never reach the decision model. It may see what the thinking model would see for the same
  message and no more. A hosted decision model also receives each eligible message, and the
  settings row already says so.

## 9. Cost and latency targets, and the kill gate

Targets are for handled turns, measured from message accepted to reply stored, on real turns.

| Measure                                                                   | Target                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Handled turn, median, fast pick-only model                                | at most 1.5 s                                                                                    |
| Handled turn, 90th percentile                                             | at most 3 s                                                                                      |
| Added delay on an escalated turn                                          | median at most 0.5 s, 90th percentile at most 1.5 s                                              |
| Wrong action rate (handled, then the user undoes it or says it was wrong) | zero on write, outbound and destructive; at most 2 percent on read                               |
| Escalation share                                                          | reported only, no target; it measures reach                                                      |
| Cost per handled turn                                                     | below one tenth of the same turn on the thinking model, from the usage the activity lines record |

**Kill gate, end of slice 3.** The front door runs for at least two weeks on real traffic from the
instance, first Watch only, then On. It continues past slice 3 only if all of these hold.

1. Added delay on escalated turns meets its target.
2. At least 15 percent of real turns are handled, otherwise the added delay is not repaid.
3. The cost target is met on handled turns.
4. Zero wrong actions in write, outbound or destructive, checked by reading the record in full.
5. The median handled turn is at least three times faster than the median thinking-model turn.

Ben makes the call from a report Moss produces from the record (percentages, medians, counts, and a
list of every handled write). If it fails, model-worded replies (slice 5) are never built and the
gate keeps its present behavior. The 15 percent and three-times figures are my starting numbers
and are open question 5.

## 10. What the user sees

This uses screens that exist. Anything new is listed as TO BE AGREED and is not designed here.

**Existing, edited.**

- The Settings row "Classifier" keeps its Off, Watch only and On control. Its help line gains one
  sentence saying the decision model answers simple messages itself. That control is the single
  switch that turns the front door off. There is no second setting.
- Activity history already lists each decision check with its model name. This spec requires one
  line per handled turn that names the deciding model, the tool, the time taken and, if used, the
  model that worded the reply, so every message traces to what handled it. The line uses the
  existing activity-line fields; no new endpoint.

**TO BE AGREED with Ben (not designed here).**

- A marker on a chat reply showing the decision model handled it. The 2026-10-01 ruling was "no
  marker on chat replies". Whether to reverse that is open question 4.
- A short "how is the decision model doing" view of handled share, speed and misses. Moss can state
  this from the record in chat today, so a screen is optional.
- The approval card wording for `ask` turns, if it differs from the existing card.

## 11. App map entries to update

All in the same PR as the behavior, per the development standards.

- `packages/shared/src/app-map-core.ts`: the Classifier row text (what On does, that private chats
  and attachments skip it, the verdicts in user terms, the failure outcomes, the single off switch)
  and the activity history text (handled-turn lines).
- `packages/ai/src/manifest.ts`: feature `ai.classifier_gate_setting`, with its errors and
  remediations (for example, a model that cannot word replies, so fixed sentences are used).
- `packages/chat/src/manifest.ts`: the chat feature entry for handled turns and the
  stop-without-fallback case.
- Remove any statements that review is required, if any survive Phase 0.

## 12. Tests and live proof

**Behaviour tests, each with why it fails against a broken build.**

1. Bar: a write tool at confidence 0.94 escalates. Fails if the bar is removed or lowered.
2. Lead: a pick 0.39 ahead of the runner-up escalates. Fails if the lead check is removed.
3. Risk floor: a tool sorted destructive never reaches `handle`, even at confidence 1.0. Fails if
   `gateRisk` is bypassed.
4. Candidate filter: a device list built for an on/off tool holds no lock, door or garage target.
   Fails if the filter is dropped.
5. Failure table: one test per row of section 7. Each escalate row asserts the thinking model
   receives the original message. Each stops row asserts it does not.
6. Reply check: a model-worded reply that drops a value, adds a number, exceeds 20 words or holds a
   URL is rejected and the record sentence is shown. Fails if the check is removed.
7. Choice-only: job 2 is never sent to a choice-only model.
8. No names: the code paths contain no provider or model name.
9. Yolo: with yolo on and an untrusted non-read tool, the card still appears or the turn escalates.
10. Wired, not just defined: through the real chat route with a stand-in decision service, a handled
    turn skips the engine launch and the activity line names the model.

**Live proof (Live-Path Gate).** On a dev instance with real data: sign in, choose a decision model
in Settings, set On, and send "turn off the kitchen lights" through the chat UI. Assert the light
state changed through the real integration, the reply posted, no thinking-model turn started, and
the activity line names the decision model. Repeat in yolo mode. Send a message the gate cannot do
and assert it escalates and the thinking model answers. Send a destructive request and assert a
card appears. No screenshots and no rewritten network responses. Any test stand-in for a
third-party service is disclosed on the PR. The decision model follows the standing rule for test
models (subscription-backed or the cheapest available).

**Measurement run.** A script reads the record and activity lines and produces the section 9
numbers for the kill gate. It runs unpiped with its exit code checked.

## 13. Slice breakdown

Slices are session-sized and share a worktree and PR where they touch the same files.

| Slice | Content                                                                                                                                        | Ends with                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1     | Reach: candidate-list argument preparation, "filled or deliberately blank", lock/door/garage filter, report that ignores tool-list loading     | Tests 3 and 4; the gate offers lights in a dry run  |
| 2     | Record and visibility: handled-turn activity line naming the model and time, verdict and reason in the decision record, the measurement script | Test 10; the section 9 numbers can be produced      |
| 3     | Run Watch only, then On, for two weeks on real traffic                                                                                         | Kill gate review by Ben                             |
| 4     | `ask` verdict: the gate raises the approval card and runs on approval                                                                          | Tests 3 and 9; live proof of an approval round trip |
| 5     | Model-worded reply for text-capable decision models, with the boundary check                                                                   | Tests 6 and 7; a second review on cost and speed    |
| 6     | Moss helps the user choose and test a decision model in chat (existing ruling)                                                                 | App-map entries and live proof                      |

Slices 4 to 6 are planned in detail only after the kill gate passes.

## 14. Open questions for Ben

1. **Model-written replies.** Jev and Clef cannot write sentences. Do you want slice 5 at all, or
   are fixed sentences per tool enough? I lean toward building slices 1 to 3 and deciding on slice 5
   from the numbers.
2. **A text-capable decision model.** If a user connects one, may it pick tools with free-text
   values? The 2026-10-11 ruling excluded a second extraction model, not the user's own capable
   model. I lean yes.
3. **Raising the approval card from the front door.** Today the gate declines and the thinking model
   shows the card. Doing it in the front door skips the thinking-model round trip for destructive
   requests but adds a path to prove. Build it (slice 4) or keep declining?
4. **A marker on replies.** You ruled no marker on 2026-10-01. With the front door answering more
   turns, is activity history alone still enough to show who answered?
5. **Kill-gate numbers.** Are 15 percent handled, three times faster, and one tenth of the cost the
   right bars? They are my starting guesses.
6. **Agreement rule for text-capable models.** Should a new text-capable decision model need two
   matching asks before it can handle anything (slower, safer), or the same bars as Jev?
7. **Scope.** The current gate runs on every chat surface except private chats. Keep that, or limit
   the front door to Main chat at first?
8. **Where the switch lives.** It is admin-wide today because the model is an admin pick. Should a
   person be able to turn the front door off for themselves only?

## 15. Rulings ledger

Facts and decisions carried in, so nobody re-derives them.

- 2026-10-01: no marker on chat replies; the activity log is the trace (reopened as question 4).
- 2026-10-03: connected tools are on by default, sorted by Moss, with no per-tool review (#2984).
- 2026-10-04: the Sensitive bar was lowered to 0.95 after System One never cleared 0.98 in 12 tries
  (#3043).
- 2026-10-11: the decision model is the user's choice, never recommended in code or plan, and Moss
  helps set it up. No second extraction model. Lights and switches run without asking when the
  device list is filtered. The shadow review step is removed and the log is kept for tuning.
- 2026-10-11 finding: Jev and Clef are `choice_only` and cannot return typed values or sentences.
- Rejected idea, recorded: passing the decision model's text straight to the user. It would put
  model output in place of the record, against the determinism boundary.
