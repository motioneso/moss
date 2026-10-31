# Front door: the decision model answers simple messages first

- **Status:** draft for Ben's review, 2026-10-31. No task issue yet; one is opened on approval.
- **Builds on:** classifier gate for chat (`2026-10-01-classifier-gate-for-chat.md`, #2864, amended
  by #2984), decision model presets (`2026-10-05-decision-model-presets-design.md`, #3057), tool-call
  discipline (`2026-09-01-integration-tool-call-discipline.md`, #2175), Moss acts through its own app
  (`2026-10-05-moss-acts-through-app-design.md`, #3065), and the Phase 0 plan that lets the gate go
  straight to On (`../plans/2026-10-11-moss-extensions-phase0-decision-model-on.md`).

## 1. Summary for Ben

**What you asked for.** The small, fast decision model answers first. For "turn off the lights" it
runs the action and replies in a word or two. If it is not sure, the thinking model takes over, the
way chat works today.

**Most of this already exists.** Moss already has a gate in front of every chat message. It asks the
decision model which tool fits, checks how sure the model is, runs the tool with the normal safety
rules, and posts a reply. If anything looks doubtful, the thinking model answers instead. It has
three positions (Off, Watch only, On). Production has been in Watch only since 2026-10-04, and
another plan is removing the review step that blocked On. So this spec extends that gate and does
not add a second one.

**What you decided on 2026-10-31, and what changes.**

1. **Replies are fixed for now.** The reply is a set sentence per tool, or just "Done." The decision
   model never writes text you read. Model-written replies are a possible later step and not part
   of the first build.
2. **Main chat comes first.** After that, news sorting and sports sorting are the next targets. They
   are not chat, so they reuse the decision model and the confidence rules but need their own
   entry points. Section 13 says what each needs.
3. **No marker on replies.** Activity history is the only place that shows who handled a message.
   Each handled message gets one line naming the deciding model and how long it took.
4. **The admin turns it on, and each person can turn it off for themselves.** That personal switch
   belongs to the person alone. Nobody else, including an admin, can see or change it.

**What stays the same.** Deleting things and sending things outside Moss still hand over to the
thinking model, which asks first. The two-week trial with a kill gate stays, and you make the call
from real numbers. A new decision model that can write text must give the same answer twice before
it acts.

**The first build also widens what it can handle.** The October trial showed it never offered the
Home Assistant lights. Slice 1 fixes that, with lock, door and garage targets kept out of the list.

**Still open.** Two questions in section 14.

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
    run tool    recorded, then     thinking model
    through     handed over like   answers as today,
    gateway     escalate           with the original
      |                            message
      v
    fixed reply (set sentence, or "Done.")

The front door is the existing classifier gate, extended. It is not a second component. One
setting, one code path, one record.

## 4. Routing contract

The front door returns exactly one verdict per message. It never returns free text to the user
except through the reply step in section 6.

| Verdict  | Meaning                                                                                                                                                                       | What happens                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| handle   | One eligible tool, every argument filled and validated, confidence and lead above the bar for the tool's risk, and the gateway needs no approval                              | The tool runs through the normal gateway path, the reply is posted, and no thinking-model turn starts                 |
| ask      | Recorded only, then escalated. The tool is clear and filled, but the gateway requires a human yes (destructive, outbound without owner allowance, Sensitive or unsorted tool) | Treated as escalate: the thinking model answers and shows the usual approval card                                     |
| escalate | Anything else                                                                                                                                                                 | The thinking model gets the original message exactly as today. Nothing the front door computed is added to its prompt |

Rules.

1. `ask` stays mapped to `escalate`. When the gateway would need approval, the front door declines
   and the thinking model shows the usual card, as the gate does today (default, Ben did not
   object, 2026-10-31). Raising the card from the front door is not planned.
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
model's. So a new text-capable model starts under a stricter rule: its pick must agree across two
independent asks before it counts as `handle` (a default; Ben did not object on 2026-10-31). Code never lowers a bar. A bar
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

For now every handled turn shows a fixed reply, built by code. Ben ruled on 2026-10-31 that a plain
"Done." is fine.

- If the tool declares a reply sentence, the front door fills it from the validated tool result
  (for example "Kitchen lights off."). A missing value makes the fill fail and counts as a failure.
- If the tool declares none, the reply is "Done.".
- A failed action shows the fixed failure sentence from section 7.

Determinism boundary. The record decides what happened and the reply renders from the record. The
decision model has one job, which is to pick the area, tool and argument values from offered lists
(and typed values if it is text-capable). It never writes text the user sees. Its prompt guidance
stays under 150 words.

Model-written replies are not part of slices 1 to 4. They stay a possible later option (R4). If
built, they would need a boundary check that rejects any wording that drops or adds a value from the
tool result, and fixed replies would remain the fallback.

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
list of every handled write). If it fails, rollout steps R1 to R4 are not started and the gate
keeps its present behavior. The 15 percent and three-times figures are my starting numbers
and are open question 2.

## 10. What the user sees

This uses screens that exist. Anything new is listed as TO BE AGREED and is not designed here.

**Existing, edited.**

- The Settings row "Classifier" keeps its Off, Watch only and On control, which only the admin can
  change. Turning it On makes the front door available to everyone on the instance. Its help line
  gains one sentence saying the decision model answers simple messages itself.
- A per-account switch lets any signed-in user turn the front door off for themselves. It is a
  plain off-only switch on the user's own settings page. It changes nothing for anyone else.
- Activity history already lists each decision check with its model name. This spec requires one
  line per handled turn that names the deciding model, the tool and the time taken, so every message
  traces to what handled it. The line uses the existing activity-line fields; no new endpoint.
  Activity history is the only trace. There is no marker on chat replies (ruled 2026-10-01 and
  again 2026-10-31).

**Access and privacy rule for the per-account switch.** The switch belongs to one account. It is
stored in that user's own settings under row-level security, readable and writable only by that
user. An admin cannot read it, set it or clear it, and the admin gate setting cannot override it.
When it is off, the gate makes no decision-model call for that account and writes no decision
record, the same as a private chat. Account deletion removes it. This keeps the "no admin
private-data bypass" invariant intact.

**TO BE AGREED with Ben (not designed here).**

- Where the per-account switch sits on the user's settings page, and its wording.
- A short "how is the decision model doing" view of handled share, speed and misses. Moss can state
  this from the record in chat today, so a screen is optional.

## 11. App map entries to update

All in the same PR as the behavior, per the development standards.

- `packages/shared/src/app-map-core.ts`: the Classifier row text (what On does, that private chats
  and attachments skip it, the verdicts in user terms, the failure outcomes, the single off switch)
  and the activity history text (handled-turn lines).
- `packages/shared/src/app-map-core.ts`: also a Settings entry for the per-account switch (where it
  is, that it is off-only, that it affects only the signed-in account, and that the admin turning
  the front door on does not override it).
- `packages/ai/src/manifest.ts`: feature `ai.classifier_gate_setting`, with its errors and
  remediations.
- `packages/chat/src/manifest.ts`: the chat feature entry for handled turns, the Main-chat-only
  scope, the per-account switch and the stop-without-fallback case.
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
6. Fixed reply: every handled turn shows the record sentence, or the plain fixed "Done." when the
   tool declares no sentence. Fails if a path lets model text reach the user.
7. Main chat only: a turn from any other surface escalates without a model call in the first
   rollout. Fails if the surface check is removed.
8. No names: the code paths contain no provider or model name.
9. Yolo: with yolo on and an untrusted non-read tool, the card still appears or the turn escalates.
10. Wired, not just defined: through the real chat route with a stand-in decision service, a handled
    turn skips the engine launch and the activity line names the model.
11. Account off switch: a user with the switch off gets no decision-model call, no decision record
    and no handled turn, while another user on the same instance is handled. Fails if the check is
    missing or reads the wrong user.
12. Switch privacy: another user, and an admin, cannot read or change a person's switch through any
    route, and the admin gate setting cannot overwrite it. Fails against a broken row-level security
    policy.

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

Slices are session-sized and share a worktree and PR where they touch the same files. The first
rollout is Main chat only.

| Slice | Content                                                                                                                                        | Ends with                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1     | Reach: candidate-list argument preparation, "filled or deliberately blank", lock/door/garage filter, report that ignores tool-list loading     | Tests 3 and 4; the gate offers lights in a dry run |
| 2     | Record and visibility: handled-turn activity line naming the model and time, verdict and reason in the decision record, the measurement script | Test 10; the section 9 numbers can be produced     |
| 3     | The per-account off switch: setting, check in the gate, app map, privacy tests                                                                 | Tests 11 and 12                                    |
| 4     | Run Watch only, then On, in Main chat for two weeks on real traffic                                                                            | Kill gate review by Ben                            |

Rollout after the kill gate passes. Each step is planned in detail only after the one before it
is judged.

| Step | Target                                                          | What it needs                                                                                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | Other chat surfaces (side drawer, voice)                        | The same gate, a per-surface check that each surface hands the turn over the same way, and the same activity line                                                                                                                                                                                 |
| R2   | News sorting                                                    | Not a chat turn, so it cannot use the chat entry point. It reuses the decision model, the confidence bars, the escalate-on-doubt rule and the activity line. It needs a declared set of choices per item (for example which topic, or keep or hide), its own record and its own kill-gate numbers |
| R3   | Sports sorting                                                  | The same needs as news sorting, with its own choices (for example which league or team a story belongs to). It shares the news step's code and differs in the choice lists                                                                                                                        |
| R4   | Optional model-written replies for text-capable decision models | A separate decision from Ben, a boundary check against the real tool result, and fixed replies kept as the fallback. Built only if the numbers show fixed replies are a problem                                                                                                                   |

R2 and R3 are not chat. The shared piece is the question-and-bars engine, not the chat lifecycle.
Their details belong in their own specs.

## 14. Open questions for Ben

Ben's answers of 2026-10-31 are in section 15. Two points are still open.

1. **A text-capable decision model.** If a user connects one, may it pick tools with free-text
   values? The 2026-10-11 ruling excluded a second extraction model, not the user's own capable
   model. I lean yes, under the two-matching-answers rule in section 5.
2. **Kill-gate numbers.** Are 15 percent handled, three times faster, and one tenth of the cost the
   right bars? They are my starting guesses and stay as defaults until Ben changes them.

## 15. Rulings ledger

Facts and decisions carried in, so nobody re-derives them.

- 2026-10-01 and 2026-10-31: no marker on chat replies; activity history is the only trace.
- 2026-10-03: connected tools are on by default, sorted by Moss, with no per-tool review (#2984).
- 2026-10-04: the Sensitive bar was lowered to 0.95 after System One never cleared 0.98 in 12 tries
  (#3043).
- 2026-10-11: the decision model is the user's choice, never recommended in code or plan, and Moss
  helps set it up. No second extraction model. Lights and switches run without asking when the
  device list is filtered. The shadow review step is removed and the log is kept for tuning.
- 2026-10-11 finding: Jev and Clef are `choice_only` and cannot return typed values or sentences.
- Rejected idea, recorded: passing the decision model's text straight to the user. It would put
  model output in place of the record, against the determinism boundary.
- 2026-10-31 (Ben): fixed responses only for now, even a plain "Done" is fine. Model-written replies
  are dropped from the first slices and kept only as a possible later option.
- 2026-10-31 (Ben): Main chat first. News sorting and sports sorting are the next targets.
- 2026-10-31 (Ben): the admin turns the front door on. Any user may turn it off for their own
  account only.
- 2026-10-31 (defaults, Ben did not object): destructive and outbound actions still decline to the
  thinking model, the kill gate stays, and a new text-capable decision model needs two matching
  answers.
