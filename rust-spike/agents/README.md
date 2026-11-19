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
account run sequentially; a changed list sends MCP `notifications/tools/list_changed` while
retaining the agent session. Module execution is the following bridge slice.

For the part 2a live measurement only, build both the runner and `moss-shell` with
`--features live-proof` in debug mode. Only that opt-in build accepts
`MOSS_CHAT_TEST_TOOLS_FILE` as the server's offered-list fixture and executes runner-local
`proof_*` challenge tools. Default builds omit those hooks; release builds omit them even
when the feature is selected. The measurement must use the real server, drawer and agent,
record the CLI versions, and compare the tool's actual challenge with the displayed response.

Before any Cargo command set `CARGO_HOME` and a task-owned `CARGO_TARGET_DIR`. Run the
database-backed host checks through `scripts/run-gate.sh` and the `verify-gate` skill.
