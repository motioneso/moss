# Chat runner

From `~/Jarv1s`, run `moss-runner <private-config.json>`. The runner configuration now uses an
`accounts` map keyed by the signed-in user's id. Move the former top-level `agent` configuration
under `accounts[account]`; the old single-account configuration is no longer accepted.

```json
{
  "root": "/private/moss-runner",
  "gateway_bin": "/path/to/moss-tool-gateway",
  "confine_bin": "/path/to/moss-confine",
  "accounts": {
    "signed-in-user-id": {
      "kind": "claude",
      "program": "/path/to/claude",
      "sign_in_home": "/private/that-users-agent-sign-in",
      "person_home": false,
      "model": null
    }
  }
}
```

Each account needs a separate sign-in folder. Account ids accept lowercase letters, digits,
hyphens and underscores, up to 64 characters. Keep the runner root outside the sign-in folder
and shared system folders. `person_home: true` explicitly permits the person's own home, with
the existing warning that confinement then provides no boundary.

The server includes the account's current tool definitions in each chat op. Turns for one
account run sequentially; Claude receives MCP `notifications/tools/list_changed` while
retaining the agent session. Codex changes take effect at a fresh conversation, as described below.

For the part 2a live measurement only, build both the runner and `moss-shell` with
`--features live-proof` in debug mode. Only that opt-in build accepts
`MOSS_CHAT_TEST_TOOLS_FILE` as the server's offered-list fixture and executes runner-local
`proof_*` challenge tools. Default builds omit those hooks; release builds omit them even
when the feature is selected. The measurement must use the real server, drawer and agent,
record the CLI versions, and compare the tool's actual challenge with the displayed response.

Before any Cargo command set `CARGO_HOME` and a task-owned `CARGO_TARGET_DIR`. Run the
database-backed host checks through `scripts/run-gate.sh` and the `verify-gate` skill.

Module tools now execute through the server: the chat op includes a fresh server-generated
`turn_id`; module calls emit `tool_call` with `call_id: "<turn_id>:<sequence>"`, the offered wire
`name` and `arguments`. The server replies with `tool_result` carrying that same id, `ok` and
`text`. The runner waits up to 300 seconds, and a closed socket fails pending calls. Built-ins
still run in the runner. The server selects the module from its offered snapshot, reverses the
wire name (`_` back to `.`), and calls the validated host API with the signed-in account context.
Approval-required tools remain unavailable until the later approval-card parts.

Agent permission asks become approval records (pending, approved, used, declined, timed out,
voided). `POST /api/chat/approvals/{id}` with `{"decision":"approve"|"reject"}` answers one as
its owner (404 for another account or an unknown id, 409 once closed, expired or voided). Records
expire after 10 minutes, the runner refuses an unanswered ask after 11, and every open record is
voided when its turn ends. Module-tool approvals are refused until part 3b adds cards.

Claude adopts changed lists in the retained session. Codex retains its starting list: send
`fresh_conversation: true` in a chat op to explicitly end the previous conversation and start a
new one with the current list. `POST /api/chat/messages` accepts the same optional
`fresh_conversation` boolean and clears that account's displayed history. It returns 202 with the
thread and runs the turn in the background, or returns 409 while the account already has a turn
running. The drawer polls `GET /api/chat/thread` (`running`, `approvals`) every 1.5 seconds. A
turn holds one runner socket and ends after 15 minutes, or after 300 seconds with no activity
and no pending approval. The regular chat drawer does not request a
reset; adding a module never silently discards its conversation.
A removed tool is still refused by the server's current offered list. Manifest installation
requires every `mcp__moss__`-prefixed name to fit the measured 110-byte limit.

Run `test:rust-chat-bridge` through `scripts/run-gate.sh` for host, agent, shell and Scratchpad
checks. The `test:rust-chat-bridge-live` gate additionally builds the real UI/server/package and
holds a disposable installed server for the task browser. Supply `MOSS_CHAT_BRIDGE_PROOF`,
`MOSS_CHAT_BRIDGE_RUNNER` (an isolated runner root outside `/tmp`), and `MOSS_SCRATCHPAD_HOST`
(the LAN or tailnet host). The fixture's `bridge.json` identifies its server and test accounts;
write `finished` in the proof folder after exercising the real drawer. Proof files and disposable
account data belong outside the repository.
