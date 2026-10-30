# Chat steering - keep typing while Moss works

- Issue - #3848.
- Date - 2026-10-29.
- Status - draft for Ben's approval. No code in this change.
- Mockups - `docs/superpowers/mockups/chat-steering/`, design only.

## What Ben asked for

Ben's words, 2026-10-29. Today the user can send one message and queue only one behind it, and that is not good. He wants to keep sending messages as if chatting with a human. While Moss is thinking and working, a small listener notices a new message and steers the running turn, inserting the message into Moss's thinking. A sub-model call for the listener is possible but not required. If true mid-turn insertion is not possible yet, the fallback is to cancel the running turn and resend both messages together.

## What the code does today

Verified in this worktree on 2026-10-29.

- The composer allows one queued message. In `send()` in `apps/web/src/chat/composer.tsx`, a send while a turn runs hands one text to `onQueue` and clears the box. A second send overwrites the same single slot. Attachments cannot queue at all, because the later send cannot replay them.
- The drawer holds that one slot as `queuedSendText` in `apps/web/src/chat/chat-drawer.tsx`. When the running turn ends, an effect sends the queued text as a new turn at once. Clicking the Next chip before then pulls the text back into the box. The chip can also discard it.
- While a turn runs, the send button becomes Stop. The text box stays open for typing.
- The server takes one turn at a time. `submitTurn` in `packages/chat/src/live/chat-session-manager.ts` throws `ChatTurnInFlightError` when a turn is already running for that person and surface, and the route answers 409. The turn runs inside the `POST /api/chat/turn` request, which stays open until the reply is done.
- The ACP engine takes one prompt at a time. `submit()` in `packages/chat/src/live/acp-chat-engine.ts` throws "ACP chat turn is busy" while a prompt is running. `MossAcpClient.prompt()` in `packages/acp/src/client.ts` sends one `session/prompt` and resets its text and tool counts each time.
- Stop is a clean cancel today. `stopSessionTurn` aborts the turn controller and calls `engine.interrupt()`. The ACP interrupt sends `session/cancel` and settles every waiting approval as cancelled, so a waiting tool does not run. A stopped turn saves nothing. The user message and any partial reply are discarded, and the screen shows "Stopped by user."
- A completed turn saves at the end. `recordTurn` writes one user text and one reply. The live-turn record in `packages/chat/src/live/live-turn-record.ts` holds the question while the turn runs, and settles as interrupted or discarded if the turn never saves.
- Chat turns run in the API process over HTTP and SSE. No pg-boss job carries a chat turn, and none is needed for steering.

## What the ACP protocol gives us

Verified against the pinned SDK (`@agentclientprotocol/sdk` 1.4.0) schema and the protocol docs, and against the two pinned adapter packages.

- Standard ACP has no steering method. The schema defines `session/prompt` and `session/cancel` and nothing that injects a message into a running turn. `session/cancel` ends the turn and the agent answers the prompt with the `cancelled` stop reason.
- Both pinned adapters offer steering as an extension outside the standard. Claude's adapter (`@agentclientprotocol/claude-agent-acp` 0.75.1) and Codex's adapter (`@agentclientprotocol/codex-acp` 1.10.0) each advertise `steering.supported` set to true in the top-level `_meta` of the initialize answer, and each answers a `_session/steering` request.
- Claude's adapter injects the message into the running turn. It pre-empts the current piece of writing at once, or lands between tool calls. While an approval or a question waits for the user, it delivers the message after that wait settles instead, so the card on screen is never hidden by a steer. When no turn is running, a client can ask for a `promptRequired` answer and nothing starts.
- Codex's adapter passes the message to the running Codex turn, and lines up several steers for one session so they land one at a time in order. It rejects an image steer on a text-only model. It does not take the `promptRequired` option, and a steer sent while no turn runs starts a new turn instead, which Moss must not let happen by accident.
- Claude's adapter also queues a second `session/prompt` behind a running one. Moss does not use that today, because the manager refuses a second turn before the prompt is ever sent.
- The pinned OpenCode agent (1.18.29) is not known to advertise steering, and the Google agent is not offered for chat at all today. The rule for every provider is the same. Steering counts as supported only when the initialize answer advertises it. Anything else is a provider that cannot steer.
- Moss's client cannot call the extension yet. `ClientSideConnection` in the pinned SDK exposes `extMethod`, but `MossAcpClient` never reads the initialize `_meta` and has no steer call.
- Claude Code and Codex themselves set the model for this feature. In both products a message typed while the agent works can go into the running turn and change what it does next, without cancelling the turn or losing tool work already done. Moss is bringing chat up to that behaviour.

## Recommendation

Build true mid-turn steering first, on the extension both main adapters already ship. Keep cancel-and-resend as the automatic fallback for a provider that cannot steer. Keep queueing as the user's own choice, not the only choice.

| Option                          | What the user gets                                                                         | Cost and risk                                                                                                                                        | Verdict                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| True mid-turn steering          | The message joins the running turn. Work done so far stands. One reply answers everything. | Moss must call one extension method and handle its race answers. Works only where the adapter advertises it.                                         | Build this. It is what Ben asked for, and both main adapters already support it.                            |
| Cancel and resend both together | The message always lands, on any provider.                                                 | The running turn dies. Tool work already done stays done and cannot be undone, and the new turn may try some of it again. The partial reply is lost. | Fallback only, where steering is not advertised. Never present it to the user as steering.                  |
| Queue as today                  | Nothing changes.                                                                           | Still one message only, still a separate later turn. The running turn never hears the user.                                                          | Keep as an explicit user choice (the hold-for-next-turn action in the mockups). It stops being the default. |

No sub-model listener. A steer is one small request on a path Moss already owns, from the composer to the server to the ACP client. A model call in that path would add seconds, cost, and a second place where message text travels, and it would decide nothing. The listener Ben pictured is a plain server endpoint plus the turn the manager already tracks.

## The design

### The steer path

1. The user types and sends while a turn runs. The composer sends the text to a new route, `POST /api/chat/turn/steer`, with the surface. The text travels in the request body only, the same as a normal turn.
2. The route resolves the person from their session, the same as every chat route. It hands the text to `ChatSessionManager.steerTurn` for that person and surface.
3. The manager finds the running turn it already tracks. It stamps the message with the next sequence number for that session, shows it in the transcript at once over the live stream as a user message tied to the running turn, and stores it with the live-turn record (see Persistence).
4. The ACP engine passes the text to `MossAcpClient.steer()`. The client sends `_session/steering` through `extMethod`, with the session id, the text as one text block, and the `promptRequired` idle option where the adapter takes it.
5. The running turn hears the message at its next step and answers everything in one reply. The turn then saves and ends through the normal path.

One steer per call, in the order the server receives them. There is no batching and no waiting window. Fast matters more than tidy here, and the adapters already line up several steers in order.

Every screen state on this path comes from a server record, never from model output. The transcript shows a steered message because the server accepted and stored it. The held, warning, and not-delivered states read the manager's state for that turn. The model decides only the reply text, as today.

### Who can steer

The client records steering support per session at open, from the initialize answer. Support is never guessed from the provider name.

| Provider route                                                      | Agent Moss launches   | Steering             | Path                                                                                                                                                                                  |
| ------------------------------------------------------------------- | --------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic, sign-in or API key                                       | Claude adapter 0.75.1 | Advertised           | Steer into the running turn.                                                                                                                                                          |
| OpenAI (Codex), sign-in                                             | Codex adapter 1.10.0  | Advertised           | Steer into the running turn.                                                                                                                                                          |
| OpenAI-compatible, API key                                          | OpenCode 1.18.29      | Not advertised       | Cancel and resend.                                                                                                                                                                    |
| OpenCode, sign-in                                                   | OpenCode 1.18.29      | Not advertised       | Cancel and resend.                                                                                                                                                                    |
| Google                                                              | Not offered for chat  | Not offered          | Nothing to build. The chat readiness gate keeps it out.                                                                                                                               |
| Non-ACP engines (persistent Claude runtime, one-shot print engines) | No ACP session        | No extension to call | Cancel and resend. Steering reaches these only if a later spec gives them an injection path. Slice 1 confirms which engine serves each chat route before this table is coded against. |

### Tool calls in flight

A steer never stops a tool call that has already started. That is the fastest safe rule, and it is also the honest one, because Moss cannot take back a call that already reached a service.

- A tool call still running when the steer lands runs to its end. Its result stays in the transcript and the model sees it. The steered message takes effect at the model's next step, after that result.
- This covers the hard cases Ben named. If a lock command has already been sent, the door locks. A steer saying "do not lock" arrives too late for that call, and the reply must work from the locked state. The same holds for a message already sent by a send tool. Steering changes what happens next. It never promises an undo.
- A tool call the model has not started yet is fair game. The model hears the steer first and can change its plan, skip the call, or change its arguments.
- Stop stays the only hard cancel. Stop keeps today's behaviour on every path.

### Approvals waiting for an answer

- A steer never answers, cancels, or hides an approval card. The card stays on screen until the person decides, exactly as today.
- While a card waits, the steered message waits behind it. Claude's adapter already holds the message until the wait settles. Moss holds it the same way on every other path, by keeping the steer in the manager's ordered line for that turn until no approval is waiting.
- Once the person approves or rejects, the turn continues and the model hears the steer at its next step, alongside the tool result or the refusal.
- Stop while a card waits keeps today's behaviour. The approval settles as cancelled and the tool does not run.

### Cancel-and-resend fallback

Used only where steering is not advertised, or where the extension refuses (Failure behaviour).

1. The manager cancels the running turn through the normal Stop path. Waiting approvals settle as cancelled.
2. It waits for the cancel to confirm. It never resends into a turn that might still be alive.
3. It starts one new turn whose prompt is the original message and the steered messages together, in order, separated as separate paragraphs. Each message still saves as its own user message (see Persistence).
4. The new turn works in the same session, so the model can see the work the cancelled turn already did, including tool results. The spec accepts that the model may repeat a step the cancelled turn already finished. Moss never replays a tool call itself.
5. The partial reply from the cancelled turn is discarded, as a stopped turn discards it today.

### Ordering and persistence

- The server assigns each message in a turn a sequence number as it accepts it. The original message is first. Steered messages follow in arrival order. Transcript order is sequence order, live and after a reload.
- A steered message appears in the transcript as soon as the server accepts it, in place, after whatever the turn has already shown. It does not wait for the reply.
- Each steered message saves as its own user message, tied to the running turn's turn id, with a mark that it arrived mid-turn. The build adds that mark to the message record; the mockups show no badge for it, because the message's place in the transcript already says it.
- Storage happens at acceptance, not at the end of the turn. The live-turn record gains a way to hold every message of the turn, so a crash or a restart mid-turn settles as an interrupted turn holding the original message and every steered message in order, with the interrupted note, the same as a single question settles today.
- When the turn completes, the saved history is the original message, the steered messages in order, then one reply. Nothing is merged into one block of text in storage, even where the fallback prompt joins them for the model.
- A user Stop discards the whole unsaved turn, steered messages included, as it discards the original message today.
- Private chat keeps its rule. Steered messages in a private chat persist nowhere, and the private transcript cleanup is unchanged.
- Attachments cannot steer. A send with files staged while a turn runs holds as a next-turn message with its files, as the composer already refuses to queue attachments today. The files stay staged and visible.

### Limits

- No hard cap on how many messages a user can steer into one turn, and no hard cap beyond the per-message size the normal turn already enforces. Ben's rule is warn instead.
- The composer warns quietly once a turn holds five or more steered messages that the model has not reached yet. The warning never blocks sending. The mockups show the warning state.
- The per-turn prompt timeout is unchanged. A long-running steered turn that hits it ends the same way a long turn ends today.

### Jobs, payloads, secrets

- The steer path uses no pg-boss job. The running turn lives in the API process, and a steer must reach it in well under a second. A job would add a queue wait and a second store for no gain.
- If any later slice moves part of this path through a job, the payload carries only the actor id, session or thread id, turn id, message id, and job kind. Never message text, never prompts, never credentials. That is the standing metadata-only rule.
- Steer text travels only where turn text already travels. The composer to the route, the route to the manager, the manager to the engine, the engine to the agent over the runner socket. It is never logged. Logs and timing records for a steer carry ids and counts only, never text.
- No token, key, or session secret is added to any steer request, response, or error. Errors on this path are classified into fixed kinds before they reach the screen, the same as ACP prompt failures are classified today.

## Failure behaviour

- No turn running when a steer arrives. The route answers with a fixed "no turn running" refusal. The composer then sends the text as a normal new turn. Nothing is lost and nothing sends twice, because the refusal means nothing was accepted.
- The turn ends in the gap. Claude's adapter answers `promptRequired` and nothing started, so Moss sends the message as the next normal turn. Codex's adapter cannot give that answer, so Moss only calls steer while its own turn lock says a turn is running, and treats a `startedNewTurn` answer as a defect to surface in the slice 1 proof, not as success (see Kill gate).
- The extension is missing. A method-not-found answer marks the session as cannot-steer for its lifetime, and that message and every later one in the turn take the cancel-and-resend path. The screen never shows a protocol error.
- The steer answer is uncertain. A transport failure after the request went out may or may not have landed. Moss never resubmits on its own. The message stays on screen marked as not delivered, with a Retry action. Retry is the user's call, because only the user can accept the small chance the model hears it twice.
- Cancel-and-resend fails partway. If the cancel confirms but the resend fails, the messages stay saved as an interrupted turn, and the composer puts the text back so the user can send again. No message disappears into a failed resend.
- The user changes chat, model, or privacy mid-turn. Today's transitions stop the running turn first. Steered messages belong to that turn and go with it. The composer keeps the user's typed text as a draft for the new chat, as it does today.
- The provider refuses a steer kind. Codex rejects an image steer on a text-only model. Moss sends text only on this path, so the refusal cannot arise from steering. Attachment sends stay on the next-turn path above.

## Composer states

Design-only mockups live in `docs/superpowers/mockups/chat-steering/`. They use the Park Press system. Bone paper ground, warm white surface, forest accent, Archivo for the panel title, hairline rules instead of boxes, no text under 11px. Screens carry product words only, no notes about the design.

Five states, one file each. The build names the `@moss/ui` pieces each state uses before it builds them.

1. `01-working-typing.html` - Moss is working. The user is typing a follow-up. Send is live while work runs, and Stop sits beside it as its own button. Today Stop replaces Send, which is what makes typing feel pointless.
2. `02-steered-landed.html` - The follow-up sits in the transcript in place, under the work it interrupted. The box is clear and Moss is still working.
3. `03-many-waiting.html` - Several messages steered into one turn. The quiet warning line shows. Sending still works.
4. `04-cannot-steer.html` - The provider cannot steer. The message shows as held, then goes by cancel-and-resend. The screen says it is sending as a new message, in those words only.
5. `05-not-delivered.html` - A steer did not land. The message stays visible with Retry.

Behaviour rules behind the frames.

- Enter sends. While a turn runs, Enter steers. There is no mode to learn and no modifier key.
- Stop is always available while a turn runs, whether the box is empty or not.
- Holding a message for the next turn stays possible. The mockups keep today's Next treatment for that choice, corrected from one slot to a list. A held message can be pulled back into the box or discarded, as today's chip allows.
- The drawer keeps steering state per surface, as it keeps the queued message per surface today. Switching surface never carries a steer into another chat.

## App map declarations to update

In the same change as the build, not after it.

- `packages/chat/src/manifest.ts` - the chat module's `features` list gains one feature for mid-turn steering. It covers sending while Moss works, the in-place transcript position, the cannot-steer fallback, and the not-delivered state with Retry, plus its errors and their remedies in the manifest's error style.
- `packages/shared/src/app-map-core.ts` - the chat entry gains the same behaviour in user words. It says the user can keep typing while Moss works, that the message joins the running reply where the provider allows it, and that it otherwise sends as a new message after stopping the current one.
- No navigation or settings declaration changes. Steering adds no screen and no setting.

## Tests

- ACP client, `packages/acp/src/client.test.ts` - steering support is read from the initialize answer and never assumed. A steer sends the right session id and one text block. An adapter that does not advertise never receives a steer call.
- ACP engine, `packages/chat/src/live/acp-chat-engine.test.ts` - a steer during a running prompt reaches the client. A steer with no running prompt never reaches the client.
- Manager and turn, at the `chat-session-manager` and `chat-session-turn` level - steers land in arrival order under one turn id. A steer before the engine exists waits and lands. A steer after the turn ends becomes a new turn. Stop discards steers with the turn.
- Route, `packages/chat/src/live-routes.test.ts` - the steer route refuses when no turn runs, refuses another person's session, and never echoes text into errors or logs.
- Persistence - a completed steered turn saves the original message, the steered messages in order, and one reply. A turn killed mid-way settles interrupted with every message in order. A private chat saves none of them.
- Fallback - a cannot-steer session cancels, waits, and resends both messages together, once. A failed resend leaves the messages saved as interrupted and the text back in the composer.
- Composer, beside `tests/unit/chat-composer-voice.test.tsx` - Enter steers while a turn runs. Several sends in a row all land. Attachments hold for the next turn. The warning shows at five waiting and never blocks. Retry shows only after a not-delivered answer.
- Live path, per the standing gate - a real dev instance, a real sign-in, and the real screen. On Claude, a steered correction changes the running reply with no second turn. On Codex, the same. On OpenCode, the same message goes by cancel-and-resend and the user sees the cannot-steer state. Record the proof on the build PR.

## Kill gate

Slice 1 is a proof, and it can kill this design. If a steered message does not change the running turn's reply on either advertised adapter, on the live path and on the pinned versions, then true steering does not exist for Moss today. The work stops there and the later slices are not built. Nobody builds the composer states on top of cancel-and-resend and calls it steering. Ben makes the call on whether the fallback alone is worth building. The narrower version of the same gate applies per provider. A provider whose injection cannot be proved drops to the fallback, and the app map says so. Slice 1 ships alone and Ben sees its proof before slice 2 starts.

## Slices

Each slice is one session of work. Each lands with its tests.

1. Proof and client. Prove injection live on the Claude and Codex adapters on the pinned versions, including the turn-ended-in-the-gap race on each. Then give `MossAcpClient` a steer call that reads support from the initialize answer. No screen change. This slice carries the kill gate.
2. Server path. The steer route, `steerTurn` on the manager, the engine steer, sequence numbers, and storage of steered messages with the live-turn record and the completed turn. The composer still queues as today, so nothing user-facing changes until slice 4.
3. Fallback. Cancel-and-resend for cannot-steer sessions, the method-not-found mark, the uncertain-answer rule, and the failed-resend recovery.
4. Composer. The five states from the mockups, the hold-for-next-turn list, the warning, Retry, and the app-map declarations above.
5. Live proof and hardening. The live-path proof on Claude, Codex, and OpenCode recorded on the PR. Ordering and reload cases through the real screen at desktop and phone width. Any provider that fails drops to the fallback in this slice, with the app map corrected in the same change.

## Out of scope

- Steering on non-ACP engines beyond the fallback. Their injection paths, if any, need their own spec.
- Steering a background job, a scheduled turn, or a voice turn. This spec covers typed chat turns on the chat surfaces the composer serves.
- Editing or deleting a steered message after it lands. Pulling a held next-turn message back into the box stays, as today.
- Any change to what Stop does, to approval cards, or to how tools ask.
