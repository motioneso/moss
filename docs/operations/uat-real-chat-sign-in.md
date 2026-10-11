# Real-model installed test runs: choosing Codex or Claude

Installed test runs (`pnpm test:uat <spec>`) that need a real chat model sign in to one command-line
tool. The setting `JARVIS_UAT_REAL_CHAT_PROVIDER` picks which.

| Setting          | How the stack signs in                                                                                                                                                  | Needs a person    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| unset or `codex` | The provisioner copies the host's own Codex login into the stack (`tests/uat/real-chat-env.ts`). No host login means no real model, and real-model specs refuse to run. | No                |
| `claude`         | The box's own Claude login is never copied. The first run waits for someone to approve Moss's one-time Claude link; later runs reuse the token that approval minted.    | Yes, once per box |

Both paths then bind the account's cheapest chat model (the "economy" tier). For Claude that is a
Haiku model. Neither path uses API keys.

## Running with Claude

```sh
JARVIS_UAT_REAL_CHAT_PROVIDER=claude \
JARVIS_UAT_CLAIMED_WEB_PORT=<port from devports claim> \
MOSS_UAT_CAPTURE_OFF=1 \
pnpm test:uat <spec file name>
```

If a saved sign-in exists (see below), the run hands it to Moss and carries on with no link. The
steps below apply to the first run on a box, and to any run after Moss refuses the saved sign-in.

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

## The saved sign-in

An approved sign-in makes Claude mint a long-lived token inside the stack. When the stack is torn
down, the run saves that token to `claude-setup-token` in the same folder before deleting it from
the stack. The file is mode 600 in a mode 700 folder. Every later run on the box puts the saved
token into its new stack and lets Moss check it with a real Claude call.

- Moss accepts it: no link, no person needed.
- Moss refuses it (revoked or expired): the run deletes `claude-setup-token`, then asks for a link
  as above. The new sign-in is saved at teardown.

To stop reusing it, revoke the token from the Claude account settings, then delete the file:

```sh
rm ~/.cache/moss-uat-claude-signin/claude-setup-token
```

Deleting the file alone does not revoke the token at Anthropic. Revoking alone is also fine: the
next run sees the refusal and deletes the file itself.

## Telling the person about the link

Nothing announces the link beyond that log line. An agent running the spec must watch for the link
file and send the link to the person approving it, then write the code they return into the code
file. On the shared build box that message goes through `needs-ben`, and the link appears only in
that message.

## Codex-only specs

These real-chat specs check Codex internals and skip when Claude is selected:

- `tools-volume-adapter.uat.spec.ts` looks for the Codex chat adapter's processes.
- `3065-app-actions-real.uat.spec.ts` expects the approval card to carry Codex's name for a file
  read. With `MOSS_APP_ACTIONS_REQUIRE_REAL_PROOF=1` it fails instead of skipping.

## Rules

- Never copy the box's own Claude login, or the moss-proof instance's, into a stack. The box's
  login shares one refresh token with every agent here, so a refresh on one side can sign the
  other out.
- The sign-in mints a long-lived Claude token inside the stack. Teardown saves it to the box's
  sign-in folder, then deletes it from the stack's volume before the volume itself is removed.
  The token reaches a new stack over standard input, never in a command line, log line or trace.
- The code and the saved token are sign-in material. The run never logs either, and nothing else
  should either. Never print, copy or commit `claude-setup-token`.
- `MOSS_UAT_CAPTURE_OFF=1` is required, and the run refuses Claude without it. The code reaches
  Moss as a page request, and a trace kept from a failed test would record that request.
- CI never sets the setting, so CI stays on the credential-free default.
