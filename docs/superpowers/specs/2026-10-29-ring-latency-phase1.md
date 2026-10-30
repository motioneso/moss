# Ring latency, phase 1 - where the seconds go

- Issue - #3842, phase 1 only. Measure, change no behaviour.
- Date - 2026-10-29.
- Code - metadata-only stage timing in the chat turn. No caps, no refusals, no model change.
- Live run - moss-proof copy on port 5181, signed in to Claude, Haiku as the chat model.
- Spoken test - offline text-to-speech said "turn off the lights". The audio went through the real voice enablement and voice recording routes.
- Result - the proof copy has no speech-to-text model set up, so transcription stopped at once. The same words then ran through the real chat route three times to measure the rest of the path.
- Not measured - ring to phone to server on real hardware. Ben does one press on prod after deploy, and the new timing line gives the same table there.

## What the new timing records

- One line per admitted voice turn, in the server log.
- Line name - `ring_stage_timing`.
- Fields - turn id, stage offsets in milliseconds, total, whether approval was asked, tool count.
- Stages - chat turn admitted, session ready, first model token, tool chosen, approval, tool finished, reply.
- No transcript, no message text, no tool name, no arguments, no reply text.
- Earlier stages already sit on saved rows. Button release is the saved capture time, upload received is the recording row creation time, transcript ready is the voice request creation time, and chat turn admitted is its dispatch time.
- Typed chat turns record nothing new. Their timing already sits on the saved message.

## Stage table from the proof run

Times are seconds. The chat rows are whole-request times from the proof copy on 2026-10-29.

| Stage                     | Measured                                 | Source                                                                |
| ------------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| Button release            | not measurable here                      | phone time, saved as capture time on the voice row                    |
| Recording fetched         | not measurable here                      | no phone in this run                                                  |
| Upload received           | 0.09                                     | voice recording post to the proof copy                                |
| Transcript ready          | failed at once, 0.09                     | recording row shows `transcription_unavailable`                       |
| Chat turn admitted        | about 0.15 in PR #3709                   | durable queue wakeup, measured there                                  |
| Session ready             | about 5.3 of the first turn              | first turn total minus the model time below                           |
| First model token         | inside the model time                    | the engine gives no separate first-token time                         |
| Tool chosen               | inside the model time                    | first turn used 2 tools                                               |
| Approval asked or skipped | no card in these runs                    | tool count came from the activity log, cards are a separate row below |
| Tool finished             | inside the model time                    | no separate gateway time is saved on this path                        |
| Reply, first turn         | 24.23 total, 18.88 model                 | chat route plus saved message timing                                  |
| Reply, warm turns         | 3.23 and 4.59 total, 3.00 and 4.45 model | chat route plus saved message timing                                  |

- Older proof with local speech-to-text turned on for the run gives the missing stage. Pickup to transcript took 1.25 to 2.04 seconds across the samples in `docs/evidence/vocci/2026-10-25-server-latency.md`.
- That older run also gives upload return to first tool at 3.4 to 23.0 seconds. The wide range came from session start and one 15 second delayed retry, both since fixed or still possible when a turn is deferred.
- The new log line splits session ready, first token, tool, approval and reply on every future voice turn, including Ben's prod press. Today's saved rows cannot split those.

## Ranked causes, biggest first

| Rank | Wait                                        | Size seen                                        | Cheapest fix to propose                                                                                                 |
| ---- | ------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 1    | Main model turn                             | 3.0 to 4.5 warm, 18.9 cold with tools            | Let the classifier gate handle simple commands so the main model never starts. See the gate section below.              |
| 2    | Cold session start                          | about 5 seconds on top of the model time         | Keep one warm session for the main chat surface, or start it when the ring connects. Measure first with the new line.   |
| 3    | Approval card for Home Assistant on and off | a human wait, not seconds of compute             | Stop asking for on and off. Ben ruled this on 2026-10-29. The approval row below gives today's state.                   |
| 4    | Speech-to-text                              | 1.3 to 2.0 where set up, fails at once where not | Set up a transcription model on every install that offers the ring, and show the missing setup on the voice screen.     |
| 5    | Classifier questions, if the gate is on     | about 5 to 7 per question, up to 4 questions     | Use a fast hosted classifier model, not a sign-in command-line model. The gate already adapts its time limit per model. |
| 6    | Upload and queue pickup                     | under 0.2 combined                               | No fix. PR #3709 already cut this to about 150 ms.                                                                      |

## The approval step today

This row belongs in the timing table for every Home Assistant command.

- A Home Assistant on or off tool found through a connection gets sorted by what it does.
- The sorting pass can put it in Changes things, which maps to write, or in Sensitive, which maps to destructive. The prompt tells the sorter that Sensitive means deletes, pays, unlocks, controls security or cannot be undone.
- A destructive hint from the server, or a DELETE method, raises the tool to destructive in code. The hint never lowers anything.
- In ordinary chat the gateway runs a tool without asking only when its current sort is Looks things up or Changes things, or Sends things out with the owner's send choice.
- A Sensitive tool always asks outside YOLO mode. Its card wait is human time and sits between tool chosen and tool finished.
- A tool with no current sort, a failed sort or a stale sort also asks.
- So a light switch sorted Sensitive asks today, and the same switch sorted Changes things runs. The sort decides, not the action itself.
- Ben's rule for phase 2 - Home Assistant commands must not ask. Only deleting something or sending something externally asks.

## Locking and unlocking today

- There is no lock-specific rule anywhere in sorting, the gateway, or any setting.
- Both locking and unlocking land in the same tool, usually sorted Sensitive because the sorting prompt names unlocks as sensitive.
- Sensitive maps to destructive, and destructive always asks in the gateway and needs the highest classifier confidence bar, 0.95.
- So today both lock and unlock ask, every time, outside YOLO mode.
- No per-user setting for unlocking exists. The only per-tool choice stored today is send without asking, and it only counts for Sends things out tools.
- Ben's rule for phase 2 - locking never asks. Unlocking asks or not by a per-user setting. Neither exists yet.

## Would the classifier gate skip the main model

Short answer - yes for this command shape, no on today's settings.

- The gate picks an area, then one tool, then its values, then runs that one tool through the same gateway. A handled turn never launches the main model session.
- That is the whole saving in rank 1 above. Warm, it turns a 3 to 4.5 second model turn into the classifier calls plus one tool call.
- The gate is off by default on the proof copy. No mode is saved, no shadow rows exist, and the shadow report for 7 days shows zero checked.
- Shadow mode on prod only watches. It never runs a tool.

What is missing for it to work, from the classifier gate plan tasks 4.2 and 4.3 plus today's code:

- One shadow review record for the chosen classifier. The table exists and is empty on the proof copy. Nobody has written the review step that creates a row, so On has no reviewed classifier to check against.
- The saved On value is read as-is today. The plan wants a changed classifier or a deleted review to drop On back to shadow at once. That check is not in the mode reader.
- Shadow evidence at a rate Ben accepts. The proof copy has none, and no rate or window has been chosen.
- Filled values for the light tool. A turn-off tool needs a target, such as which light or area. The gate can only fill that from a fixed choice list or from typed extraction. No Home Assistant device list is fed to it today, so a name argument stays unfilled. This is the scan gap below.
- Live proof through the real screen, task 4.3. Not done.
- Approval still applies. A gate-handled Sensitive tool that the gateway would card is declined back to the main model today, which then shows the card. Ben's no-ask rule removes that block for on and off, lock, and most Home Assistant actions.

## Scanning Home Assistant when a user adds it

What exists today:

- Adding a connection lists the server's tools once. For Home Assistant that means tool names, descriptions, input schemas and hints. It does not list devices, areas or services.
- A sorting pass then groups each tool and writes a readable name. It runs on connection add and when discovery changes.
- A preparation pass drafts a one-line description and a reply wording per tool from the tool definition alone.
- Device names can reach the classifier only as candidates. A candidate source must name a listing tool on the same connection, someone must set that mapping, a setup refresh must call the listing tool once, and the result sits in a memory cache for five minutes.
- The gate reads only that cache. It never calls a listing tool during a message.

What is missing for Ben's rule that Moss scans Home Assistant itself:

- No scan of devices, areas or services happens when a connection is added. Nothing asks Home Assistant what lights exist.
- No stored device or area list exists to build classifier choices from. The five minute memory cache is the only store, and it starts empty.
- Nobody fills tool arguments by hand in the shipped flow, but nobody fills them automatically either. A light tool whose target is a free-text name has no list to pick from, so the gate declines it.
- The candidate mapping is set by hand per tool. Ben's rule wants Moss to work it out from the scan, for example by matching a turn-on tool to the device list the same connection exposes.
- A scan would also let the sort use real facts, such as this tool locks a door, instead of guessing from a tool name.

## Limits of this phase

- The proof copy could not transcribe, so the spoken run stopped before chat. The chat numbers come from the same words sent through the real chat route on the same copy, same model, minutes later.
- No Home Assistant connection exists on the proof copy, so no real light tool ran. The approval and lock rows come from reading the sorting and gateway code, not from a live card.
- The first chat turn may have paid a cold start that a ring user with an open chat would not. Warm turns are the fair comparison for a press while chat is open.
- Root typecheck in this worktree fails on missing packages that predate this change. The new timing tests pass, and the touched files pass lint and formatting checks.
