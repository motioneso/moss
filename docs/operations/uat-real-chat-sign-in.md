# Real-model installed test runs: choosing Codex or Claude

Installed test runs (`pnpm test:uat <spec>`) that need a real chat model sign in to one command-line
tool. The setting `JARVIS_UAT_REAL_CHAT_PROVIDER` picks which.

| Setting          | How the stack signs in                                                                                                                                                  | Needs a person    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| unset or `codex` | The provisioner copies the host's own Codex login into the stack (`tests/uat/real-chat-env.ts`). No host login means no real model, and real-model specs refuse to run. | No                |
| `claude`         | Nothing is copied in. The spec starts Moss's own Claude sign-in and waits for someone to approve its one-time link (`tests/uat/claude-signin-handoff.ts`).              | Yes, once per run |

Both paths then bind the account's cheapest chat model (the "economy" tier). For Claude that is a
Haiku model. Neither path uses API keys.

## Running with Claude

```sh
JARVIS_UAT_REAL_CHAT_PROVIDER=claude \
JARVIS_UAT_CLAIMED_WEB_PORT=<port from devports claim> \
MOSS_UAT_CAPTURE_OFF=1 \
pnpm test:uat <spec file name>
```

1. When the spec reaches sign-in it prints the paths of two files, both under
   `~/.cache/moss-uat-claude-signin/` (or `JARVIS_UAT_CLAUDE_SIGNIN_DIR`), named after the stack:
   `<stack>.link` and `<stack>.code`.
2. Open the link in `<stack>.link` in a browser signed in to Claude and approve it. The page shows a
   code.
3. Write that code into `<stack>.code` in one go, for example `printf %s '<code>' > <stack>.code`.
   The run reads it once, deletes it, hands it to Moss, and carries on when Moss reports Claude
   ready. An empty file is left alone until the code arrives.

The link lasts 10 minutes, so the run waits 10 minutes for the code by default
(`JARVIS_UAT_CLAUDE_SIGNIN_WAIT_MS` changes it). The wait is added to the spec's own time limit.
If nobody answers in time the run cancels the sign-in and fails; rerun for a fresh link.

## Rules

- Never copy the box's own Claude login, or the moss-proof instance's, into a stack. The box's
  login shares one refresh token with every agent here, so a refresh on one side can sign the
  other out.
- The sign-in mints a long-lived Claude token inside the stack. Teardown deletes it from the stack's
  volume before the volume itself is removed. Deleting it does not revoke it at Anthropic; revoke
  old tokens from the Claude account settings if needed.
- The code is sign-in material. The run never logs it, and nothing else should either.
- `MOSS_UAT_CAPTURE_OFF=1` is required, and the run refuses Claude without it. The code reaches
  Moss as a page request, and a trace kept from a failed test would record that request.
- CI never sets the setting, so CI stays on the credential-free default.
