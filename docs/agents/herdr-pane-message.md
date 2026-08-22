---
name: herdr-pane-message
description: Use when Codex needs to send a message, instruction, question, or finding to another agent session in the same Herdr workspace.
---

# Send a Message to Another Herdr Pane (Codex)

Herdr is a terminal workspace manager with a JSON CLI. Use the agent API for agent-to-agent
prompts; use the pane API for ordinary shells and low-level terminal control.

## Steps

**1. Resolve the target by unique agent name.**

```bash
herdr agent list
herdr pane list        # use when the target is unnamed or pane context is needed
```

- Prefer a unique registered agent `name`; it follows the live agent if its pane moves.
- If using a pane ID, use the current opaque ID from the latest response; do not derive it from
  sidebar order or assume an old ID identifies the same occupant.
- Never message the focused pane running this agent.
- Skip unlabeled panes under `~/.jarvis/chat/*`; those are chat-engine sessions, not coordinating
  agents.

**2. Submit through the agent API.** It sends text plus encoded Enter atomically and honors
bracketed-paste mode:

```bash
herdr agent prompt <agent-name-or-pane-id> "<your message>"
```

When the caller needs the first settled lifecycle state, add `--wait` and a bounded timeout:

```bash
herdr agent prompt <agent-name-or-pane-id> "<your message>" --wait --timeout 120000
```

The default settled states are `idle`, `done`, and `blocked`. If the target is already `blocked`,
inspect it and use `herdr agent send-keys` for a deliberate UI response; `agent prompt` refuses to
inject input into an approval/question dialog. There is no `herdr agent send` command.

**3. Use the pane API only for raw terminal work.** For an ordinary shell command:

```bash
herdr pane run <pane_id> "<command>"
```

`pane run` also submits atomically. Use `pane send-text` only when Enter must not be sent, and
`pane send-keys` only for intentional low-level key input.

**4. Verify delivery.**

```bash
herdr agent get <agent-name-or-pane-id>
herdr agent read <agent-name-or-pane-id> --source recent-unwrapped --lines 30
```

For raw pane sends, use `herdr pane read <pane_id> --source visible --lines 12`. A busy agent
showing a queued prompt is success; do not resend.

## Requesting a reply

Name yourself and ask the target to reply via this skill to your current agent name. If you have
no registered name, ask it to re-resolve your pane from a fresh `herdr pane list` response.

## Quick reference

| Need                   | Command                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| Resolve agents         | `herdr agent list`                                                       |
| Resolve panes          | `herdr pane list`                                                        |
| Send to an agent       | `herdr agent prompt <name-or-pane-id> "<text>" [--wait]`                 |
| Run a raw-pane command | `herdr pane run <pane_id> "<command>"`                                   |
| Read an agent          | `herdr agent read <name-or-pane-id> --source recent-unwrapped --lines N` |
| Send intentional keys  | `herdr agent send-keys <name-or-pane-id> <key> [key ...]`                |

> Scope: spawning a new agent is separate (`herdr agent start`). This guide covers messaging
> existing agents.
