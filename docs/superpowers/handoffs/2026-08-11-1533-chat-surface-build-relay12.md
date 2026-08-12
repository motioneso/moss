# #1533 chat surface build — relay12 handoff

Supersedes relay11. Same worktree/branch: `build/1533-chat-surface-routing`, HEAD `351c34877`.

## State

- Phase 3: DONE. Phase 4 gate: DONE, green at `80f01f537`. Sensitive-tier check: DONE, clean
  (21-file diff vs `origin/main` = 5 production files + 4 tests + branch docs, no
  AccessContext/RLS/persistence/gateway-contract touched).
- Phase 4 live-path proof: **UNBLOCKED, not yet executed.** Ben confirmed #1121 (scriptable
  UAT chat engine) merged to `main` at `8b2a4b357` and directed: proceed with live-path proof;
  if the scriptable engine doesn't actually cover the need, flag back to Coordinator via
  herdr-pane-message (resolve pane fresh by label).
- Draft PR: not opened yet — still gated on live-path evidence.

## #1121 recon done this relay — it DOES cover the need

Confirmed via `git show --stat 8b2a4b357` (already fetched into this worktree's `origin/main`,
no merge/rebase needed — just read objects off it):

- `tests/uat/fixtures/chat-scripts/*.json` — chat-script fixture format. Example
  (`phase1-smoke.json`): `{"version":1,"turns":[{"expectIncludes":["goals"],"calls":[{"tool":
  "goals.list","arguments":{}}],"reply":"..."}]}`. Full contract in
  `tests/uat/fixtures/scripted-provider/script-schema.ts`.
- `tests/uat/fixtures/scripted-provider/bin/claude` + `claude-main.ts` — a fixture binary that
  stands in for the real Claude CLI, deterministically driven by the script.
- `tests/uat/seed/chunks/chat-script.ts` (Task 5) — **this is the key unblock**: when
  `JARVIS_UAT_SEED_CHAT_SCRIPT` is set, it seeds a real, active anthropic provider+model and
  disables persistent chat runtime, so the scripted scenario resolves through the **normal**
  `AiRepository` chain — not a bypass, not a mock of the chat surface itself. Only the CLI
  process backing the provider is swapped for the deterministic fixture.
- `tests/uat/provisioner.ts` (+38/-x) and `tests/uat/run-uat.ts` (+19/-x) — thread
  `uatLevel.chatScript` through provisioning; `provisionForUat` overrides
  `JARVIS_CLI_TOOLS_PREFIX` to the scripted-provider fixture path for the run's duration,
  restored after.
- `packages/chat/src/live/engine-selection.test.ts` (Task 6) — proves the seeded provider keeps
  the bounded-fallback (`claude -p`) engine selected, i.e. compatible with how #1533's surface
  routing actually dispatches sends.
- No existing UAT spec uses `chatScript` yet (only the integration test
  `tests/integration/uat-scripted-claude.test.ts` and the schema/launch-args/session-state unit
  tests exercise it directly) — writing a script targeting job-search would be new usage of an
  existing mechanism, not new product code, consistent with the plan's "Phase 4: no new code,
  evidence only" (a throwaway spec/script used once for evidence and not committed, per relay10
  and prior guidance, is the right shape here — same as originally planned before the block).

## Next (pick up here)

1. Find job-search's exact tool id/schema for the criteria-set call — was mid-lookup at
   `external-modules/job-search/src/worker/registry.ts:76` (`"criteria.set": (ctx) => ...`)
   when this relay hit the context checkpoint. Get the full tool name as registered (likely
   `job-search.criteria.set` per the plan doc's own phrasing) and its argument shape from the
   handler/schema file it delegates to.
2. Write a throwaway chat-script fixture (JSON, `scripted-provider/script-schema.ts` contract)
   with a turn: `expectIncludes` matching a unique criteria phrase you'll type into the drawer,
   `calls: [{tool: "job-search.criteria.set", arguments: {...real shape...}}]`, a `reply`.
3. Write a throwaway Playwright script (scratchpad only, do not commit) that: provisions via
   the UAT harness with `chatScript` set + job-search module installed/enabled (see
   `tests/uat/specs/job-search-board.uat.spec.ts` for the module-setup pattern) → signs in →
   navigates Job Search → Profile → "Change in chat" → types the unique criteria phrase, hits
   Enter → captures network (EventSource URL + POST body, confirm matching `surface=m-...`) →
   screenshots the approval card within 5s → denies/cancels → records action row/request id →
   tears down → then a second pass: no module mounted, ordinary drawer, harmless prompt,
   confirm stream/send stay on `drawer`, one private-chat start/end cycle.
4. If any step reveals the scriptable engine genuinely doesn't reach the chat surface (e.g. the
   fixture CLI can't be invoked from a real browser-driven session, only from
   `tests/integration/*`), STOP and message Coordinator via `herdr agent prompt <name> "..."`
   (re-resolve name/pane fresh — `coordinator-relay3` at `w1:p7H` as of this relay, but it
   moves) rather than spending more budget guessing.
5. Once real evidence exists: write it into the PR description exactly as the spec requires
   (explicit "rendered without reload" statement, exit codes, screenshot/run artifact path,
   matching-surface network quotes, teardown confirmation), then `coordinated-wrap-up` → draft
   PR, do not merge.

## Standing instructions (unchanged)

- Coordinator: re-resolve fresh via `herdr pane list`/`herdr agent list`, use
  `herdr agent prompt <name> "..."` (SendMessage tool fails on herdr-registered names).
- Relay again at next 70% warning or on compaction. Never end turn mid-procedure.
- `scripts/run-gate.sh`, never bare `pnpm verify:foundation`.
- Given the size of "write + debug a Playwright live-path script," consider forking this step
  out (subagent_type: "fork") rather than doing it inline, so browser-automation iteration
  noise doesn't eat the relay's context budget — this is what relay (the session before this
  one) did for the first live-path attempt, and it worked structurally even though that attempt
  hit a real blocker.
