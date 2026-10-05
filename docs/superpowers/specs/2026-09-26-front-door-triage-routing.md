# Front-door triage: route each chat message with a System One model before the chat model

Status: draft for Ben's review, 2026-09-26. Builds on the System One provider spec (PR #2585, task #2586) and the sorting-model spec (#2594), which notes "a `sorting` capability arrives with the Jev slice". This spec proposes the triage capability and the front-door pipeline step, and is a candidate for that Jev slice. No code until approved and a GitHub task issue exists.

## 1. The problem

Every chat message goes to a full chat model, even ones that need no language understanding at all: "turn off the living room lights", "add milk to the grocery list", "snooze this until tomorrow". That costs a multi-second round trip and a full LLM call for a decision a small model could make in under half a second. It also asks the chat model to do two jobs at once: understand the person, and parse a machine intent out of prose.

TypeSafe's Jev answers typed questions (choice, score, yes/no) with calibrated probabilities in roughly 70 to 500 ms, with no free text to parse. Moss already has the System One provider kind and the `generateChoices` router function from the focus-judgment work. Nothing routes chat traffic through it yet.

## 2. What exists today

- `AI_MODEL_CAPABILITIES` (`packages/module-sdk/src/ai-capabilities.ts`): `chat`, `tool-use`, `json`, `vision`, `summarization`, `transcription`, `web-search`. Tiers: `reasoning`, `interactive`, `economy`.
- `generateChoices` (`packages/ai/src/structured/generate-choices.ts`): the caller supplies a state, named choice questions, and a service key; the router resolves the bound model. A `system-one` provider takes the bespoke `POST {base}/v1/systemone` path; any other provider returns `not_supported` and the caller falls back to its prompt-based path. The focus-judgment spec proves the pattern: one call answers two questions (alignment and activity) at once.
- Service bindings (`packages/ai/src/repository.ts`, `resolveModelForService`): admin pins, per-module keys, capability defaults. The sorting spec adds a reserved `sorting` key and reserves a future capability for the Jev slice.
- `ModuleAssistantActionFamilyManifest` (`packages/module-sdk/src/index.ts:81`): assistant action families declare `defaultTier` (`ask_each_time` | `always_confirm`) and `allowedTiers`. The permission-tier vocabulary for acting already exists.
- The chat pipeline (composer and chat drawer) resolves the `chat` capability and sends the message to the chat model. No step inspects the message first.

## 3. Design

**A. A `triage` capability.** Added to `AiModelCapability` and `AI_MODEL_CAPABILITIES`, alongside the existing entries. It is provider-agnostic like every other capability: the person binds any model to the `triage` service key, and `generateChoices` decides the request shape. A System One model answers natively; anything else takes the prompt-based fallback. When nothing is bound, or the call fails, the pipeline behaves exactly as today (section 5).

**B. The front door.** Before the chat pipeline resolves the `chat` capability, it calls `generateChoices` with the message as state and two questions in one call:

- `route`: a `choice` over the fast intents declared by the person's enabled modules, plus a `chat` option.
- `chat_tier`: a `choice` over `economy`, `interactive`, `reasoning`, consulted only when `route` is `chat`. This is the "which type of model" decision: simple questions take the cheap tier, hard ones take the reasoning tier, without the person thinking about it.

**C. Fast intents in the module manifest.** A module declares each fast intent with: an id, a plain-English description (used to build the `route` criteria), its slot questions (`choice`/`noul`/`score` with fixed options), the existing tool or action that executes it, and a policy drawn from the action-tier vocabulary. The triage answer space is exactly the declared intents, so the model cannot invent a capability; prompt injection can only misroute among intents the person already enabled. Blast radius is the manifest.

**D. Slot filling.** When `route` picks an intent at or above the confirm band, a second `generateChoices` call answers that intent's slot questions ("turn off the living room lights" becomes `action: off`, `room: living room`). Slots with open values (dates, names) are not Jev questions: the intent declares a deterministic parser for them, and if parsing fails the message falls through to chat. The rule of thumb: Jev decides, deterministic code executes, the chat model talks.

**E. Confidence bands.** Per intent, with defaults the person can change in Settings:

- At or above the auto-act threshold (default 0.9): execute through the module's existing permissioned handler.
- In the confirm band (default 0.6 to 0.9): one-tap confirmation in the chat drawer ("Turn off the living room lights?"), then execute.
- Below 0.6, or `route` is `chat`: today's chat path, using the tier from `chat_tier`.
- Intents whose policy is `always_confirm`, or whose action family tier forbids it, never auto-act at any confidence. Destructive actions (delete, send, pay) are confirm-only or chat-only by policy, never by threshold.

**F. First slice.** The capability, the front-door step, the manifest declaration, and one module's intents end to end. Suggested first module: quick capture ("add milk to groceries", "remind me at 5pm") or device control if a smart-home module exists by then. Small blast radius, and the latency win is immediately visible.

**G. Observability.** Every triage decision is logged with the route, the confidence, and the band outcome, and Settings shows recent decisions. The person sees what was auto-acted and why, and can tune thresholds per intent. This keeps the "see and control what the assistant does with the data" commitment.

**H. App map.** The triage binding row in Settings and the threshold controls are new surfaces; their app-map entries ship in the same PR, per the truthfulness rule.

## 4. Data boundary and consent

Triage sees every chat message, which is broader than focus judgment's window titles. The message text leaves Moss for the bound triage provider (a third party when it is System One). The Settings row where the triage model is bound must say so in plain words, and the person must be able to leave triage unbound, in which case chat works exactly as today. The request carries no credential other than the provider key and no user identifier. Secrets never enter the triage state: slot values and message text are the person's own content, and nothing on the secrets list is sent.

## 5. Failure behaviour

Fail open to today's behavior, never fail into action. A timeout, transport error, invalid answer, unbound triage key, or provider error sends the message down the chat path as if triage did not exist. An answer is invalid unless the probabilities cover exactly the allowed choices, sum to about 1, and the chosen choice has the highest probability (same validation as the System One provider spec). A `route` answer below the confirm band is not a failure; it is chat. Auto-act never fires on a failure path. Errors log a category only.

## 6. Tests

- Contract test: the triage request body matches a fixture taken from a real accepted System One request (fails if a field is renamed or dropped).
- Answer validation: each rule in section 5 rejected on its own, each observed failing with the check removed.
- Routing rule: a `system-one` model takes the bespoke path, any other bound model takes the prompt fallback, both return the same shape.
- Band behavior: auto-act at and above threshold, confirm inside the band, chat below it; `always_confirm` intents never auto-act at any confidence.
- Manifest validation: an intent with an undeclared slot question, or a slot question with no fixed options and no parser, fails closed at registration.
- Deterministic parser fallback: an unparseable date falls through to chat, never to a guessed slot value.
- Live proof: a real command of the "turn off the lights" class through the dev instance against the real UI, recorded on the PR (live-path gate).

## 7. Decisions (defaults taken unless Ben chooses otherwise)

1. **Capability name.** `triage` (this spec), `route`, or `front-door`. Recommended: `triage`, matching the pipeline step's name.
2. **Thresholds.** Auto-act at 0.9, confirm band 0.6 to 0.9. Recommended: yes, per intent, tunable in Settings, with the correction data able to tune them later as the focus spec does.
3. **Tier routing in slice 1.** Whether `chat_tier` ships in the first slice or arrives later. Recommended: yes, it is one more choice question in the same call, nearly free.
4. **Confirm UX.** One-tap inline confirmation in the chat drawer versus a blocking dialog. Recommended: inline in the drawer, dismissible, with the executed result shown in place.
5. **First intents.** Which module provides the slice-1 intents. Recommended: quick capture (tasks and reminders), smallest new surface.

## 8. Not in this spec

Open entity extraction beyond fixed choices and declared parsers; the voice path; triaging proactive events (a later use of the same capability); multi-turn slot clarification beyond a single confirmation; any non-System-One bespoke provider; batching or caching triage answers.
