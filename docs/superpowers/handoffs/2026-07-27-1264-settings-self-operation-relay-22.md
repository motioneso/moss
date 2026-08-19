# Relay 22 handoff — #1310 (PR #1276), item 9 live-path proof

Read `docs/superpowers/handoffs/2026-07-27-1264-settings-self-operation-relay-21.md` first for full background if needed — this doc only covers what changed since then. Full debug narrative saved to agentmemory: `memory_smart_search("live-path UAT 1310 claude-print-chat-engine")`, project `jarv1s`.

## State as of end of relay 22

- **Gate: GREEN.** `/tmp/cb-vf-relay21.log` → `### FINAL verify:foundation rc=0`. Task done, do not rerun unless code changes again.
- **Item 9 (live-path UAT): IN PROGRESS, not yet proven pass or fail.** Key finding: the original "DOM never flipped in 60s" failure is very likely a **test-timeout problem, not a #1310 regression**. The chat engine (`packages/chat/src/live/claude-print-chat-engine.ts` `submit()`) spawns a real nested `claude -p --mcp-config ... --allowedTools mcp__jarvis__* --model claude-sonnet-4-6 "<prompt>"` subprocess per turn — a full cold-start CLI invocation. Observed real-world latency for one full turn (spawn → MCP tool round-trip → DB write): **~150s**. My live-proof Playwright script (`.../scratchpad/live-uat-1310.spec.ts`) used a 60s `expect()` timeout — too short.
- Also controlled for and ruled out (probably) as primary cause: dev API launched via `nohup ... &` from inside an agent's own Claude Code bash session leaks `CLAUDECODE`/`CLAUDE_CODE_SESSION_ID`/`ANTHROPIC_BASE_URL` into the nested `claude -p` child's env. Relaunched with those stripped — same slow-but-alive behavior, so this wasn't the (sole) cause, but keep doing it anyway for hygiene:
  ```bash
  env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_CHILD_SESSION \
    -u CLAUDE_PID -u CLAUDE_CODE_EXECPATH -u CLAUDE_EFFORT -u CLAUDE_PLUGIN_DATA \
    -u CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS -u ANTHROPIC_BASE_URL -u AI_AGENT \
    nohup pnpm --filter @jarv1s/api dev > /tmp/dev-api-relayNN-clean.log 2>&1 & disown
  ```
- **Last live instance state:** clean-env api pid `1337883` on :3000 (log `/tmp/dev-api-relay23-clean.log`), web still the relay22 instance on :5173 (unchanged, not contaminated the same way). A second live-proof run was mid-flight when this relay ended: nested `claude -p` subprocess (pid `1340440`, session `5902fa58-8b3c-4b2a-bc61-1d0581dd9453`, prompt "Switch my theme to light mode.") was **still running** at handoff time. DB row `app.preferences` key=`themes.color-mode` was still stale (`revision=1`, `"dark"`, `updated_at 2026-07-27 18:26:49`) as of last check — check again first, don't assume.

## Next step (do this first)

1. Check if pid `1340440` finished: `kill -0 1340440 2>/dev/null && echo running || echo exited`.
2. Check DB: `docker exec jarv1s-postgres psql -U postgres -d jarv1s -c "SELECT value_json, revision, updated_at FROM app.preferences WHERE key = 'themes.color-mode';"`
   - If `value_json` is now `"light"` and `revision` bumped → the write landed. Then rerun the Playwright script with the `expect()` timeout raised from 60000 to ~200000 (`scratchpad/live-uat-1310.spec.ts` line 41-43, and bump `live-uat.config.ts` `expect.timeout` / test `timeout` too) to confirm the **DOM also flips with no reload** — that's the actual #1310 claim. If DOM flips → item 9 is PROVEN; post the DOM assertion and bounded logs in a `gh pr comment` on #1276 with the timing caveat (turns take ~2-3 min, not seconds), then move to item 10 wrap-up.
   - If DB is still stale after the subprocess exits → real bug, pursue Coordinator's hypothesis #1 branch B (chat routing / tool selection never fired) — check the nested claude process's own transcript under `~/.jarvis/chat/<userId>/` for what it actually did.
   - If DB updated but DOM still doesn't flip even minutes later → pursue Coordinator's hypothesis #2: `resolveQueryKeyToken` (fails closed since `a05fad65`) — print the actual runtime `affectsQueryKeys` token from the settings tool's `action_result` and diff against the resolver's token table. **Do not widen the resolver to a permissive fallback** — fix the emitter or register the token deliberately.
3. Scratch files reusable as-is: `/tmp/claude-1000/.../scratchpad/live-uat-1310.spec.ts`, `live-uat.config.ts` (just bump the timeouts).
4. Coordinator is at herdr pane labeled "Coordinator" — re-resolve via `herdr pane list` fresh (do not reuse a remembered pane id). Send progress via the `herdr-pane-message` skill. Report the ~150s-per-turn latency finding explicitly — it changes what "no reload" proof timing should look like in the PR write-up.

## Task #4 (item 10, still pending, unchanged from relay 21)

`coordinated-wrap-up`: push, update PR #1276 body (exit criteria status, mocked-SSE-e2e gap statement, external-module `affectsQueryKeys` validation limitation, live-proof link, the news/sports manifest `as const` credential-type heads-up for lane #1265/PR #1273's rebase — commit `1146a76e`), report to Coordinator. **Do not merge.**
