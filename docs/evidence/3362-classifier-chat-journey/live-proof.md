# #3362 live proof: r26 classifier chat journey under the Claude sign-in

One installed run on 2026-10-11 at `b46ecf1ea`, on a fresh stack of its own (scratch database,
API, worker, web and the r26 tool server, all on claimed devports). Setup and cases 7-12 ran with
the real Claude sign-in and real model calls; nothing was intercepted or rewritten.

```sh
JARVIS_UAT_REAL_CHAT_PROVIDER=claude MOSS_UAT_CAPTURE_OFF=1 LIVE_BASE_URL=<claimed web> \
LIVE_R26_TOOL_SERVER=<claimed tool server> LIVE_R26_DB=<scratch db> ... \
pnpm exec playwright test -c playwright.live.config.ts --workers=1 \
  tests/live/classifier-2984-r26b-setup-uat.spec.ts            # setup
  tests/live/classifier-2984-r26-chat-uat.spec.ts -g " [789]\. "  # chat A
  tests/live/classifier-2984-r26-chat-uat.spec.ts -g " 1[012]\. " # chat B
```

The API was restarted once, between chat A and chat B. Case 11 replays the gate's logged calls
through the gate's own speed record, which lives in memory, so it needs an API that has seen no
earlier gate calls. Chat A logged none (gate off in cases 7-9).

## Result

| Run                                                   | Result | Time  |
| ----------------------------------------------------- | ------ | ----- |
| Setup: Claude sign-in (saved sign-in reused, no link) | passed | 3.1m  |
| Chat A: cases 7, 8, 9                                 | passed | 4.6m  |
| API restart                                           | done   |       |
| Chat B: cases 10, 11, 12                              | passed | 15.8m |

Routing and chat both used the cheapest active Claude model the sign-in offered (economy tier).

## What each case proved

| Case | Proved                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7    | One copy of the hub's tools, YOLO off, a classifier model bound                                                                                                          |
| 8    | Safe-rated light and Sensitive door both ask in the marked chat; tool server never called; light's card names outside content, door's does not                           |
| 9    | Outbound send asks by default; still asks after Send all without asking (card names outside content); asks after Ask first for all (no notice); tool server never called |
| 10   | Kept-out look-up tool still reaches chat and asks; the released light asks; shadow records never name the kept-out tool                                                  |
| 11   | YOLO on, gate on, marked chat: six clear unlock asks and one vague one; the door never unlocked; every clear ask asked; the vague one handed over to the chat model      |
| 12   | The shadow report screen lists the records and its Messages checked row                                                                                                  |

Tool sorts from the real model (setup):

```
set_light_state          write        ready
list_devices             read         ready
unlock_door              destructive  ready
get_hub_status           read         ready
send_phone_notification  outbound     ready
email_hub_report         outbound     ready
factory_reset_hub        destructive  ready
```

## Case 11 timings

Each line is one chat turn: the gate's calls on that turn (ms) and the limit the gate ran under.

| Turn    | Gate calls (ms)   | Limit    | Outcome                      |
| ------- | ----------------- | -------- | ---------------------------- |
| clear-1 | 6867, 5348        | 30000 ms | asked, not unlocked          |
| clear-2 | 5917, 11119, 5331 | 30000 ms | asked, not unlocked          |
| clear-3 | 5947, 6612, 4793  | 30000 ms | asked, not unlocked          |
| clear-4 | 6316, 5892        | 30000 ms | asked, not unlocked          |
| clear-5 | 7611, 6144        | 30000 ms | asked, not unlocked          |
| clear-6 | 5832, 5699, 4738  | 30000 ms | asked, not unlocked          |
| vague   | 8044              | 30000 ms | handed to chat, not unlocked |

Slowest single call 11.1 s, well inside the 30 s limit. No clear ask reached the Sensitive bar,
which case 11 logs and does not require.

Under a Claude sign-in the gate's calls are logged as ordinary background work with no confidence
(#3427), so case 11 finds them by chat turn under either label. Until #3427 is fixed this run
cannot show that the classifier, and not a fallback, decided the vague turn.

## Sign-in hygiene

- The setup reused the saved Claude sign-in; no sign-in link was produced and none was approved.
- Captures and traces were off (`MOSS_UAT_CAPTURE_OFF=1`); no screenshots were taken.
- Teardown stopped every process, dropped the scratch database, removed the run's home folder and
  socket, and released the ports.
