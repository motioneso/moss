# #3361 live proof: safe-tools spec under the Claude sign-in

Two installed runs of `2984-safe-tools-run.uat.spec.ts` on 2026-10-10, each on a fresh stack:

```sh
JARVIS_UAT_REAL_CHAT_PROVIDER=claude JARVIS_UAT_CLAIMED_WEB_PORT=<claimed> \
MOSS_UAT_CAPTURE_OFF=1 pnpm test:uat 2984-safe-tools-run.uat.spec.ts
```

Run 2 was on the branch after merging `integration/scheduled-proactive` (38 new commits).

## Result

Both runs failed at the same assertion, for a product reason tracked in #3338.

| Step                                                                    | Run 1       | Run 2       |
| ----------------------------------------------------------------------- | ----------- | ----------- |
| Moss's own Claude sign-in, link approved by Ben, code handed back       | passed      | passed      |
| Economy-tier chat model bound (the setup fails closed otherwise)        | passed      | passed      |
| Worker sorts every connected tool with the real model                   | passed      | passed      |
| Conversations, then New side chat; list cleared and empty; message sent | passed      | passed      |
| Model calls the exact tool named in the prompt                          | passed      | passed      |
| Light tool runs with no approval card                                   | failed      | failed      |
| Sensitive reset tool asks (desktop and phone)                           | not reached | not reached |

Tool sorts from the real model (both runs):

```
set_light_state    write        asks first: false
list_devices       read         asks first: false
unlock_door        destructive  asks first: true
get_hub_status     read         asks first: false
factory_reset_hub  destructive  asks first: true
```

## Why the light tool asked

The card read "Moss read something from outside your account before asking this." for
`uat-smart-hub.set_light_state` in a brand-new side chat with no earlier tool calls.

During run 2 the conversation provenance table was polled while the stack was up. Every chat
thread was marked tainted at launch with `first_admission_path = outside_agent_launch`.

`chat-session-launch.ts` records that path for any engine with
`admitsOutsideContentWithoutPermission`, which only the ACP engine sets (#3065). Claude chats run
on the ACP engine, so every write in a Claude chat asks first. #3338 tracks exactly this. Until it
is fixed, the 2984 "safe tool runs with no card" step cannot pass under Claude; it needs the Codex
path.

## Sign-in hygiene

- The sign-in code went from the approver's reply into the run's code file without being printed
  or logged; captures were off for both runs.
- Teardown removed each stack's volumes, including the minted Claude token. Removal does not revoke
  it; the two tokens minted on 2026-10-10 can be revoked from the Claude account settings.
