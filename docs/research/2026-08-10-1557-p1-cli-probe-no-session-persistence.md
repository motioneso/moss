# #1557 Phase-1 P1.0 probe — `--no-session-persistence` × persistent stream-JSON stdin

**Date:** 2026-08-10 · **Environment:** dev box only, no prod contact · **CLI:** `claude` 2.1.227

**Question (named in the plan, uncitable from the tree):** does `--no-session-persistence`
coexist with a persistent `--input-format stream-json` stdin child fed multiple sequential user
frames on one process, and does it leave any resumable provider transcript behind? The Phase-0
spike proved the `--session-id` leg only; this is the other leg.

## Method

One `claude` child launched with:

```
claude --print --input-format stream-json --output-format stream-json \
  --include-partial-messages --verbose --no-session-persistence
```

Piped stdin via a named FIFO kept open across all three frames (no `--session-id`, no MCP config —
this probe isolates the flag-interaction question only; MCP admission is P1.4's concern). Launched
from a fresh, never-before-used working directory so `~/.claude/projects/<sanitized-cwd>/` state
before/after is unambiguous. Three frames sent sequentially, each awaited via its `result` event
before the next was written. Then stdin closed, process observed for graceful exit, then the
project directory inspected for any resumable transcript.

## Result: CONFIRMED — coexists cleanly

| Check | Result |
| --- | --- |
| Same PID for all 3 turns | **PASS** — pid `1740938` throughout |
| 3 terminal `result` events on that one process | **PASS** — count 3 |
| Same `session_id` across all 3 turns (in-memory only) | **PASS** — `17be6b27-8f79-4458-a050-621c853d179b` |
| `system/init` events | 3 (one per turn — matches the Phase-0 spike's known stream-framing finding, not a lifecycle signal) |
| Graceful exit on stdin close | **PASS** — exit 0, no `SIGTERM`/`SIGKILL` needed |
| Resumable transcript on disk after close | **NONE** — `~/.claude/projects/<sanitized-cwd>/` contains only an empty `memory/` dir, no session `.jsonl`; `grep -rl <session_id> ~/.claude/projects` finds no CLI-written transcript file for this session anywhere |

## Decision

**Adopt `--no-session-persistence` as the phase-1 launch posture** (spec's preferred posture).
Consequence for the plan's P1.3/P1.6 fork:

- No resumable provider transcript is ever written, so the persistent adapter does **not** need a
  `purgeTranscripts` implementation to satisfy the incognito guard
  (`chat-session-manager.ts:246-251`) — incognito is satisfied structurally, by the flag, not by a
  purge-on-terminate code path.
- The fallback posture (fresh `--session-id` per launch + purge-on-every-termination-path) described
  in the plan as the contingency is **not needed** for phase 1.
- Test cases from the plan's "Incognito posture" row: assert **no provider transcript exists**
  after N turns + reap (the first branch), not the `purgeTranscripts`-ran branch.

## Scope note

This probe intentionally omits MCP config and `--session-id`/`--permission-mode`/persona flags —
those are orthogonal to the flag-coexistence question and are exercised by P1.3 (launch shape) and
P1.4 (fail-closed admission) against the real transport. No chat content, prompts, or credentials
are recorded above — only counts, PIDs, and a session UUID that was never persisted to disk.
