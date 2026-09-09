# Plan: ACP slice 1, chat (issue 2424)

Spec: `docs/superpowers/specs/2026-09-06-acp-client-design.md` (approved by Ben 2026-09-07; amended
the same day for chat first, sections 3, 4, 6, 7, 9, 10, 13 item 1, 14). Task issue: #2424
(supersedes #2369). Lane branch: `build/acp-slice1-chat`. Slice 2 (unattended callers, terminal
login path, agy) and slice 3 (the Workshop and its panel) get their own plans after this slice
passes its live proof.

Revision 2 (2026-09-07): chat replaces the Workshop as slice 1 (Ben); Reviewer's findings on
revision 1 folded in (runner restored as it was, chat profile only, spec 7 point 3 deferred with a
reason, model list reconciliation decided, reload and queueing named, evidence rules, two missed
restores, release note); the behind-the-scenes task added (spec section 14); OpenCode as the second live-proof provider (Scout's check passed 2026-09-07). Revision 3 (same day): Reviewer's second-pass findings: task 9 narrowed to chat's own engines (PM's ruling), the spike's timing numbers copied in, chat's model choice stated, the chat UAT spec in task 7, the tool table's missing column named; PM's ruling on the gate clock and session warm-up. Revision 4 (2026-09-08, Astra-Reviewer's review of PR 2427 at 98f840fe0): the boot script keeps the signal privilege in prod (five, not four); OpenCode's row is ready now and the live proof gates the merge, not the flag; the handshake script's side entrance goes. Revision 5 (2026-09-08, retro after the foundation work closed at 7aaf21246): task 5b's builds paragraph rewritten as twenty numbered invariants with nothing added or dropped; task 7 gets an early live proof by Prover before task 8; the retro's seven working rules recorded under order and hand-offs.

## Premises verified on `main` at e32222640 (2026-09-07)

- The protocol package `packages/acp` (client, capability check, permission classifier, tool
  table, stream, tunnel, unit tests), the runner's ACP host with its seven RPC cases (`acpSpawn`,
  `acpSend`, `acpRead`, `acpKill`, `acpExecStart`, `acpExecPoll`, `acpExecKill`), the tool
  server's session handoff, the gateway's built-in permission policy and their tests all exist in
  history at commit `bb59e0700` (the parent of the removal commit). Every restore names that commit.
  The removal also dropped `"@moss/acp": "workspace:*"` from `packages/ai/package.json` and
  changed the denial wording asserted in `tests/unit/mcp-gateway-recovery.test.ts` to "Timed out
  awaiting confirmation."; the wording comes back in task 5 and the dependency in task 6 with its
  first importer (Reviewer finding 8; Reviewer task-1 finding: the check fails on an unused
  declaration, so the dependency must not land earlier).
- Chat's engine is chosen in `packages/chat/src/live/engine-selection.ts` and handed to the
  session manager (`packages/chat/src/live/chat-session-manager.ts`: idle watchdog 180 s at line
  107, idle reaper at line 880, the "Chat session was lost, reconnecting" record at line 282,
  resume at line 674) through `packages/chat/src/live/runtime.ts` and `routes.ts`
  (`selectEngineFactory`). The bridge engines live beside it in `packages/chat/src/live/`. Two callers outside chat stand on the bridge's shared pieces: the module chat multiplexer (`packages/module-registry/src/chat-multiplexer.ts`) imports the engine type, the persistent-runtime launch config and the reap reason, and the module build step (`packages/ai/src/module-build/run-build-step.ts`) takes a live agent launcher from the same runtime. Both are slice 2 callers, so those pieces outlive this slice.
- Spike timing (`spikes/acp-tool-call/RESULTS.md`, untracked, copied here so the gate has its numbers): the read prompt ("what is on my calendar") took 11.0 to 12.6 s on the bridge and 10.1 to 28.8 s over ACP across two runs of three; the write prompt ran 130 to 169 s on both arms because the approval hold ran to its timeout in the spike harness, so it is not a fair turn time; the one auto-approved ACP write took 16.4 s. The task 9 gate compares the read prompt only.
- Runner RPC dispatch is the `switch` in `packages/cli-runner/src/connection.ts` (line 307 on
  main: `launch`, `submit`, `readNew`, `kill`, `probeProvider`, `listProviderModels` at 434, the
  login and terminal cases). Model lists come from `packages/cli-runner/src/model-list-adapters.ts`.
- MCP tool server: `packages/chat/src/mcp-transport.ts`; bearer tokens in
  `packages/ai/src/gateway/session-tokens.ts`; approval hold `confirmAndRun` in
  `packages/ai/src/gateway/gateway.ts`.
- The drawer's per-turn "Thinking" fold is `packages/ui/src/chat-thread.tsx` (a details element
  fed by transcript records, `activityVerb` per line), styled in
  `packages/ui/src/styles/components-chat.css` (`chatd-peek*`). The reply row is
  `apps/web/src/chat/message-row.tsx`. Chat's app-map surface is the `features` block of
  `packages/chat/src/manifest.ts`; core screens and errors are `packages/shared/src/app-map-core.ts`.
- Registry pins (spec section 9): Claude `@agentclientprotocol/claude-agent-acp@0.75.1`, Codex
  `@agentclientprotocol/codex-acp@1.10.0`, OpenCode registry entry `opencode` (pinned in task 2 at the version Scout ran on 2026-09-07), SDK `@agentclientprotocol/sdk` newest v1 line at build time.
- Token usage: each turn's reply carries a usage block (input, output, cached read, cached write,
  total) built by the Claude adapter from its own tally and shaped like the Codex adapter's
  (Scout read both, 2026-09-07). Codex's live numbers are unproven until its account usage returns
  on 2026-09-11. OpenCode's real turn (Scout, 2026-09-07) returned input, output and total plus a thought-token count, and no cache split. There is no turn-duration field. OpenCode takes 15 to 20 seconds to answer its first two calls; Claude and Codex answer at once.

## Decisions

- **One adapter, one profile built.** `@moss/acp` keeps a `profile` type with three values
  (`chat`, `workshop`, `unattended`) so the table in `tool-table.ts` has its columns, but slice 1
  builds, tests and wires only `chat`: scratch folder, shell and file writes off, tool server on.
  The other two values are declared and rejected with "not built yet" until their slices.
- **Provider rows are code, versions are pinned.** `packages/acp/src/providers.ts` holds one row per
  provider kind (`anthropic`, `openai`, `google`, `opencode`): launch command, login mechanism,
  model mechanism, built-in off-list mechanism, capability requirements per profile. `google` is
  present and marked unavailable with the reason (slice 2). `opencode` is present: Scout's scratch check passed on 2026-09-07 (model switch, real turn, real usage numbers); its tool server handoff is checked on dev in task 5. **`codex` is not ready in this slice** (Reviewer on task 5b, 2026-09-08): the row said it reuses the Codex CLI's login on disk, but task 5b moves every agent into a fresh per-person home and nothing puts a Codex login there; the only stored login Moss holds is Claude's, and Scout's 2026-09-07 Codex turn ran on the box's own login in the shared home, which no longer happens. The row is marked not ready with that reason, its launch refuses with the "Not logged in" wording rather than spawning, and it comes back in a later slice with a stored login of its own, the same shape as Claude's. Building a Codex sign-in is not slice 1 work. Its shell and file switch is OpenCode's own settings file in the per-user home, written by the row before spawn with shell and file edits set to deny: with it, a fresh session offers no shell tool and no ask fires (Scout, scratch home on dev, 2026-09-07). Task 5b adds the write to the row's launch step, deriving the two entries from the tool table; task 10 proves it in the runner's real per-user home. **Ready is split from proven (revision 4, 2026-09-08):** as first written, the row stayed not ready until that proof, the runner refuses any not-ready row whoever asks, and the proof needs the runner to launch it, so the proof could never run (Astra-Reviewer, 2026-09-08). "Ready" means the launch code has everything the row needs, and OpenCode has it: no login is required and the preparation step writes the deny file. So the row is ready on the branch, the handshake script's side entrance for OpenCode is deleted and both engines go through the ordinary launch path, and the live proof gates the merge, not the flag: task 10's evidence must be on the PR before merge, and if it fails the row goes back to not ready with that reason, before merge. Codex stays not ready; that block is real. Gated-and-denied at use (Builder, task 5) is the second line, not the requirement.
- **Runner: add, don't rewrite.** The ACP host and its seven RPC cases come back from
  `bb59e0700` exactly as they were, beside the existing cases; no existing case is touched, no
  mode flag is introduced. Chat uses four of the seven (spawn, send, read, kill); the three exec
  cases are restored with their tests because the file is restored whole and slice 3 needs them,
  and they are not reachable from any chat path. The old chat paths in the runner stay live until
  task 9 deletes the bridge API-side; the runner's own dead cases come out in slice 2 with a runner
  audit as its own task there (PM's ruling on Ben's question, 2026-09-07).
- **Model choice.** Chat keeps today's resolution, unchanged: the admin's chat binding through the existing capability route (chat is the only bindable service), or the person's own override where the admin has enabled it (`packages/ai/src/chat-model-override.ts`); so yes, the admin's chat binding is honoured in slice 1. The resolved model record's provider kind picks the row; no code path names a provider (the bridge's engine chooser, which does, is what task 9 deletes); the model id is sent with
  `session/set_config_option` on the `category: "model"` option after `session/new` where the
  agent advertises it, else the row's launch mechanism, else the session stays on the login's default and the reply record says so. Where the option is advertised it is always set before the first prompt, never left unset: the resolved id when listed, else the agent's reported current value, else the first advertised option, and the reply record names what was set. A fresh OpenCode session in the runner's home has no config file and answers nothing without one (Builder, task 4, 2026-09-07); Claude's adapter has a built-in default, which is why only OpenCode showed it.
- **Model list reconciliation, decided (Reviewer finding 5).** The "Refresh models" list in
  settings keeps today's per-CLI adapter as its only source. The protocol's `configOptions` is
  used to set the model and, at session start, to confirm the chosen id is one the agent accepts;
  a mismatch is recorded on the reply and shown as the provider's status line, never merged into
  the list. One list, one place it comes from.
- **Gateway hold through the protocol card, deferred (Reviewer finding 4, spec 7 point 3).** In
  chat the gateway's approval card already renders in the drawer, so surfacing the same hold
  through `session/request_permission` would be a second render of one hold on one screen. Deferred
  to slice 3, where the Workshop panel is the screen that needs it. Recorded here, and in the spec's
  review record by the lane PR.
- **Sessions (spec section 6).** One process per (user, chat, conversation), keyed
  `chat:<userId>:<conversationId>`, working folder `<per-user home>/chat/<conversationId>/` created
  0700, reaped by the existing 180 s idle watchdog. A browser reload replays from Postgres; live
  reattach (`session/load`) is used only where the agent advertises it and is not required to
  pass. One prompt at a time: a second send while a turn runs is held by the composer, shown as
  queued, and sent when the turn finishes (not only when Stop is pressed). The browser holding the
  second message already satisfies the protocol's one-prompt-at-a-time rule, so the session manager
  carries no queue in this slice (Architect, 2026-09-08, on Astra's task 7 finding 7).
- **Approval card:** the gateway hold stays the enforcement point; heartbeat every 20 s on held
  calls; denial wording "This action was not approved, so it was not done. Do not try it again; let the user know."; the agent's
  built-in asks are answered from the restored policy keyed on real tool name and tool call id;
  `session/cancel` (the drawer's stop button) answers every pending ask `cancelled`.
- **Login check at start.** `initialize` then `session/new`; an `auth_required` error becomes the
  provider's "Not logged in" status and a plain reply in the drawer, never a stack trace.
- **Behind the scenes (spec section 14).** Thoughts, tool calls, approvals and results become
  transcript records that feed the existing Thinking fold; the stats strip under the reply shows
  Moss's elapsed clock and the usage block's numbers when present. Mockup:
  `docs/superpowers/specs/assets/2026-09-06-acp-client/behind-the-scenes.html`. Ben sees it before
  task 8 starts.
- **Evidence rules (Reviewer finding 7).** Every dev check and the live proof record exit codes,
  test assertions, audit lines and bounded logs on the lane PR. No screenshots.
- **Release note (Reviewer finding 9).** Written once on the lane PR: Category Changed, "Chat
  answers through the agent protocol; each reply shows what happened behind the scenes and what it
  cost."
- **Determinism boundary:** every visible answer renders from Postgres transcript records and
  notifier events, never raw protocol frames.

## Tasks (each one session; each lands green on the lane branch before the next starts)

Every task runs, unpiped, before every push: `pnpm lint`, `pnpm format:check`,
`pnpm check:file-size`, `pnpm typecheck`, plus the scoped unit run named in the task. The full gate
runs only through the `verify-gate` skill, at the end of tasks 5, 7 and 9. No `git add -A`; commit
by path (`shared-checkout` skill). Every product-facing task (6 to 9) updates the app map in the
same commit range.

### Task 1. Restore the protocol package from history, nothing else

- **Builds:** `packages/acp/` exactly as at `bb59e0700` (`git checkout bb59e0700 -- packages/acp`)
  plus the wiring that made it a workspace member at that commit. No behaviour change, no rename.
- **Files:** `packages/acp/**`, `tsconfig.json`, `vitest.config.ts`, `scripts/test-unit.ts`,
  `pnpm-lock.yaml`, `tests/unit/test-unit-plan.test.ts`,
  `tests/unit/module-dependency-allowlist.test.ts` (the `@moss/acp` platform classification). (The `@moss/acp` workspace dependency in
  `packages/ai/package.json` is not restored here: nothing imports it until task 6, and the
  package-dependency check fails on an unused declaration. It comes back in task 6 with the file
  that imports it.)
- **Tests:** the restored `capabilities`, `client`, `permissions`, `tool-table` unit tests pass
  unchanged.
- **Gate:** the four checks; `pnpm --filter @moss/acp test`.

### Task 2. Provider rows, the chat profile and the current pins

- **Builds:** `providers.ts` (rows above); `AcpSurface` becomes `AcpProfile`, only `chat` accepted
  at run time; `checkAgentCapabilities` checks a row's requirements for `chat`; SDK bumped to the
  newest v1 line, agent packages moved to the registry entries, spawned through
  `process.execPath`; `setModel(sessionId, modelId)` using `session/set_config_option` with the
  per-row fallback and the accepted-id check; `initialize` sends `protocolVersion: 1` and fails
  closed in plain English on any other answer.
- **Files:** `packages/acp/src/{providers,capabilities,client,index}.ts`, `packages/acp/package.json`,
  `pnpm-lock.yaml`.
- **Tests:** row lookup by kind; profile gate passes Claude, Codex and OpenCode for
  `chat`, rejects `google` with its reason and `workshop`/`unattended` with "not built yet";
  `setModel` sends the option when advertised, falls back per row, records a mismatch; version mismatch fails closed. The restored tool table has `chat` and `workshop` columns only; `unattended` has no row yet and gets one in slice 2 (Reviewer finding 5), so the profile gate rejects it before the table is consulted.
- **Gate:** the four checks; `pnpm --filter @moss/acp test`.

### Task 3. Runner: restore the ACP host and its seven cases as they were, launching the pinned registry entries

- **Builds:** `packages/cli-runner/src/acp-host.ts`, `exec-records.ts`, `owned-fs.ts` and the seven
  dispatch cases restored from `bb59e0700` beside the existing cases, unchanged; the RPC contract
  types and the API-side client restored to match. Per-user home, scrubbed env and the 0700 working folder on spawn; the bearer token crosses only inside the `session/new` payload. **One deliberate change to the restored host, and the only one (Reviewer finding 3 on task 2, 2026-09-07):** the restored host spawns the node binary on an adapter entry file that an injected resolver finds, and the default resolver points at the old Zed adapter pinned in the runner's `package.json`. This task makes the provider row the thing launched: the runner's `package.json` drops `@zed-industries/claude-code-acp` and pins the three registry entry packages at the versions in the spec's section 9 table (Claude `@agentclientprotocol/claude-agent-acp@0.75.1`, Codex `@agentclientprotocol/codex-acp@1.10.0`, OpenCode at the version Scout ran); `acpSpawn` carries the provider kind; the host resolves the entry file from that row's package name and spawns it through `process.execPath` as before. OpenCode's package ships a launcher whose platform binary arrives only when the package's install step runs, so a checkout installed without scripts has the launcher and no binary; the dev handshake in task 4 and the live proof in task 10 confirm the runner box has it before trusting any OpenCode result. No default provider anywhere: a spawn without a provider kind is refused. The same Zed pin comes out of the protocol package's dev dependencies, left behind by task 2. Task 2's rows keep the launch text as documentation of what this task resolves.
- **Files:** `packages/cli-runner/src/{acp-host,exec-records,owned-fs,connection,engine-host}.ts`, `packages/cli-runner/package.json`, `packages/acp/package.json`, `pnpm-lock.yaml`, `packages/acp/src/client.ts` (passes the provider kind to the runner spawn), `packages/acp/src/permissions.test.ts` (fixtures follow the adapter package rename), `packages/chat/src/live/{rpc-contract,chat-engine-rpc-client}.ts`,
  `packages/acp/src/tunnel.ts`.
- **Tests:** `tests/unit/cli-runner-acp-host.test.ts`, `cli-runner-acp-exec.test.ts`,
  `cli-runner-protocol.test.ts`, `cli-runner-startup-orphan-sweep.test.ts` restored and green, the host tests changed only where they inject the entry resolver, which now takes a provider kind; one new test that each of the three rows resolves to its own pinned package's entry file and that a spawn without a provider kind is refused; every existing runner test still passes unchanged.
- **Gate:** the four checks; `pnpm vitest run tests/unit/cli-runner-*`.

### Task 4. Dev handshake (first kill gate)

- **Builds:** one check script under `scripts/` that, on dev, asks the runner to spawn the Claude
  agent for the signed-in user, runs `initialize`, `session/new`, one `session/prompt` with no
  tools, and exits non-zero on any failure or after 60 s.
- **Files:** `scripts/acp-handshake-check.ts`.
- **Evidence (Builder, on the PR):** the script's exit code and its bounded log (last 40 lines).
- **Kill gate:** if the handshake cannot complete through the runner on dev, stop the slice and report to PM before any further task.
- **Rerun after task 5b (Astra-Reviewer finding 4, 2026-09-08).** Both engines go through the ordinary launch path in the rerun; the script's separate OpenCode entrance is deleted (revision 4). The first run built its own host inside the script with per-user identity off and a loopback tunnel, so it proved the adapters answer and not the path the gate exists to prove. Its result is withdrawn: **not passed**. The rerun connects to the running runner service over its socket, with per-user identity on, for Claude and OpenCode, and records on the PR, from the kernel's record of the agent's process: the account (the slot's, not the launcher's), the home folder, and zero in every privilege set; plus the launcher's own record showing exactly the three privileges. Task 6 does not start before it passes.

### Task 5. Tool server handoff, heartbeat, denial wording

- **Builds:** `mcp-transport.ts` session handoff restored (`mcpServers` entry with the `jst_` bearer
  header at `session/new`); progress notifications every 20 s on a held call; fixed-expiry session tokens; the denial wording in the gateway. **Restore by reversing the removal commit's hunks (`e32222640`) onto main, never by copying whole files from `bb59e0700`:** the old files carry the gateway's built-in ask (task 6) and Workshop run-command wiring that main has since dropped (slice 3), and a whole-file copy does not typecheck (Builder, 2026-09-07). Pulled forward from task 6 because this wording needs it: the refusal sentence constant in `native-tool-guard.ts` and its export from the gateway index. Left in task 6: the gateway's `requestAcpBuiltInPermission` method, its imports and the index re-exports from `acp-permission.ts`. Dropped from this task: `gateway-services.ts`, whose only removed lines were the Workshop run-command service, parked with the Workshop.
- **Files:** `packages/chat/src/mcp-transport.ts`, `packages/ai/src/gateway/{gateway,session-tokens,index,native-tool-guard}.ts` (the removal commit's hunks only, minus the built-in ask), `packages/module-sdk/src/index.ts` (the optional progress field on the shared tool context, two lines the removal took out; the gateway hunk sets it, so the restore does not typecheck without it; Reviewer, 2026-09-07).
- **Tests:** `tests/unit/gateway-tool-progress.test.ts`, `session-tokens-fixed-expiry.test.ts`,
  `mcp-transport.test.ts` restored; wording restored in `tests/unit/mcp-gateway-recovery.test.ts`
  and updated in `tests/integration/chat-mcp-transport.test.ts`, `tests/integration/mcp-gateway.test.ts`,
  `tests/unit/gateway-notifier.test.ts`, `tests/unit/mcp-gateway-units.test.ts`.
- **Gate:** the four checks; `pnpm vitest run tests/unit/gateway-* tests/unit/mcp-*`; full gate via
  `verify-gate`.

### Task 5b. The launch follows the provider row (blocks task 6)

Astra-Reviewer's whole-slice read at 561265882 (2026-09-08) found that the restored host launches every provider the way the old Claude path did. Task 3 restored it faithfully; the spec asks for more, and this task is the difference.

- **Builds (revision 5 rewrote this as a numbered list of invariants; nothing was added or dropped, and every attribution is kept):**
  1. **Slot by person.** The account slot is allocated by the user's id, the same key the existing per-user runtimes use, never by conversation key (finding 2: one slot per conversation drains the permanent slot pool and gives two conversations of one person two accounts). `HOME` is that slot's own home folder, never the shared base folder.
  2. **Login by row.** The login reaches the agent by the selected row's mechanism only (finding 1): Claude's stored token in the environment for Claude alone; Codex gets no Claude token and, having no stored login of its own yet, is not ready and refuses to launch; OpenCode gets neither. The refusal is the runner's own spawn step, for any row marked not ready, whoever asks; the conversation client's earlier check is only the friendlier message on the product path (ruled 2026-09-08 on Reviewer's finding 2).
  3. **Off-list by row.** The launch-time off-list is applied for every row from `launchOffList(profile)` through the row's own mechanism (finding 3): Claude's disallowed-tools list, Codex's `INITIAL_AGENT_MODE=read-only` in the environment, OpenCode's settings file written into the home with shell and file edits set to deny (moved here from task 6). The Claude-only deny list the host wrote before is deleted, so the table is the single source.
  4. **Identity off refuses.** With per-user identity off, the launch refuses and never falls back to the shared base folder as `HOME` (task 5b review, 2026-09-08: the OpenCode deny write would otherwise edit the real settings file under that folder).
  5. **Command methods unregistered.** The three command-running remote methods (exec start, poll, kill) are unregistered from the runner's connection until the Workshop's own slice keys them by user id (task 5b review, 2026-09-08): they still take one slot per session from the same permanent pool and are reachable over the wire with no caller.
  6. **The launcher holds three narrow privileges, never root** (Prover's failed checkpoint rerun, 2026-09-08, evidence on PR 2427; Ben approved the privileges the same day): change file ownership, switch account, switch group. "Holds" means the kernel's record for the runner process (`/proc/<pid>/status`) shows exactly those three as effective, and the process runs as the ordinary service account.
  7. **Prod grants five to the container, and the boot script raises three for the runner.** `infra/docker-compose.prod.yml` grants the launcher's three plus the two the container's own boot script needs: one to lock the socket folder it just handed over, and the signal privilege to stop its own children, which run as the ordinary account while the boot script stays root; without it every shutdown signal is refused (Astra-Reviewer, 2026-09-08, source-traced; revision 4). A grant to the container reaches no child the boot script starts as another account: Node's account switch at spawn drops every privilege on the way (Astra-Reviewer, 2026-09-08, reproduced: the runner ended with none and the ownership change was refused). So `scripts/start-jarv1s.ts` starts the runner child through `setpriv` from util-linux, present in the image: switch to the host account and group by number, and raise exactly the three as inheritable and ambient, which survive the program start. Only the runner child gets this; the api and worker children are started as today, by Node's account switch, which drops everything, so the signal privilege reaches nobody but the boot script. The dev compose file lists no privileges on that service and is unchanged.
  8. **Dev runs the runner as a service with the same three.** `infra/systemd/jarv1s-dev-cli-runner.service` runs as Ben's account with the three as ambient privileges, and the unit file itself switches per-user separation on on its `ExecStart=` line, running the program through `/usr/bin/env JARVIS_CLI_PER_USER_UID=1 ...`, so the shared env file stays untouched and the install notes never ask for an edit to it (Astra finding 4, twice: the unit as first written read the env file, which says off; an `Environment=` line loses to `EnvironmentFile=` whatever the order, so the value must be set past the point where systemd builds the environment, on the command line itself). The unit's paths are absolute with the account and home folder marked as placeholders, since systemd expands no `~/`; the install commands in the PR notes fill every placeholder, and end with a search for `REPLACE_WITH` in the installed unit that must print nothing.
  9. **Separation is on in both compose files** (`JARVIS_CLI_PER_USER_UID=1`). Both boxes had separation off and this branch refuses without it, so under the never-break-prod rule this ships in the same PR, not after.
  10. **The three privileges stop at the launcher.** Ambient privileges pass to every child across a program start, so an agent started plainly by a privileged runner would hold the power to switch to any account. Every process the runner starts for a person (the ACP agent, and the command path when it returns) is started through `setpriv`: switch to the slot's account and group by number with the supplementary groups cleared (`--clear-groups`, never `--init-groups`: the slots are numbers with no system account entry, so a groups lookup fails the launch outright; Astra, 2026-09-08), drop all inheritable and ambient privileges, then run the program. The working directory is entered after the identity switch, never by Node's `cwd` option before it, since the launcher cannot enter a folder it has handed over.
  11. **The stop goes the same route, with no separate program.** The launcher cannot signal another account's process with its three privileges, so the stop is sent as the slot's account to the agent's process group (Astra finding 3); that needs no fourth privilege for the runner (the boot script's signal privilege in item 7 never reaches the runner). The runtime image has no `kill` program and its build file installs none (Astra round 4, 2026-09-08, reproduced: the stop failed and the agent kept running), so the signal is sent by Node from the image, the same binary the runner itself runs under, started through `setpriv` as the slot's account; no shell in between and no new package in the image. Dev runs the runner from source on a box that does have such a program and would hide the gap, so a unit test asserts the stop command runs nothing but `setpriv` and the runner's own Node binary. A refused stop is an error the close reports, never swallowed, and the session record stays until the process is confirmed gone.
  12. **The identity evidence is the kernel's record.** The record for the agent process shows the slot's account and zero in every privilege set; that record is the evidence, not the folder's owner.
  13. **Shared parents belong to the launcher, mode 0711.** The base folder, its `agents` folder and the chat base stay owned by the launcher's own account, mode 0711 (others may pass through, not list), so the launcher can keep creating siblings and each agent can reach its own folder. Before this, the shared `agents` parent was handed to the first person owner-only and the launcher, no longer root, was refused at the next person's folder (Astra finding 3, reproduced with the prod privilege set).
  14. **Only a person's top level is handed over, and the launcher's work stops there.** The handover with owner-only mode starts at the first level that is one person's: `agents/<user id>` and everything below it, and the conversation key level under the chat base and everything below it. The launcher creates each of those two only when absent and hands it over at once, empty, owner-only. Order matters, because the launcher cannot enter a folder once it is someone else's, and cannot open one that already is: the first launch handed the person's home over owner-only, and the second launch for the same person was refused at its door (Astra round 4, 2026-09-08, reproduced with the three privileges; earlier, Astra finding 2 twice: the conversation folder was handed over before its child was made under it).
  15. **An existing top level is checked without being opened.** When either top level already exists, the launcher checks the kernel's record without opening it (a real folder, not a link, owned by exactly the slot's account and group) and refuses the launch if anyone else owns it.
  16. **Everything below the top level is done as the person.** A preparation step runs as the slot's account through `setpriv`, the same switch as the agent (numbers, groups cleared, every privilege dropped), running Node from the image: it creates every level below the top (the settings folders, the conversation folder), writes every file the launch puts inside (the OpenCode deny file, merged into an existing one), and exits. Those folders and files are born owned by the person; no handover below a top level happens at all, and no deepest-first ordering is needed any more. The agent launch follows, entering its working folder after the switch.
  17. **Nothing the launcher needs later lives in a person's tree.** The stored login stays in a launcher-owned folder.
  18. **A failed handover or preparation step stops the launch there.** The launch fails with that reason (the step's own message), and the cleanup removes only what this launch created (a folder it made, a file it wrote), never a folder or file that already existed (Astra finding 1: the cleanup removed a whole pre-existing home and its contents); no warning-and-carry-on that leaves folders owned by the wrong account.
  19. **The checkpoint script connects to the running service.** `scripts/acp-handshake-check.ts` opens the runner's socket with the runner's secret the way the app does, starts the agent for a real Moss account whose user id is given on the command line (never the operator's Unix name standing in for it), completes one exchange, and while the session is alive reads the kernel's record for the agent's process (the runner's session inspection returns the child pid; the script reads `/proc/<pid>/status`) and prints, with the home folder: the account and group, which must equal the slot's (the runner's session inspection returns the slot's account and group with the pid), must not be 0 and must not be the launcher's own; and the permitted, effective, inheritable and ambient privilege sets, which must all be zero (Astra finding 5: a check of two sets passed a root process with live privileges). It builds no runner of its own, and it reads no folder owner as a stand-in for the account (Astra finding 5). Both engines, Claude and OpenCode, go through the ordinary launch path; the script's separate OpenCode entrance is deleted (revision 4). The task 4 rerun runs that version and nothing else.
  20. **A row's "ready" claim is the launch code, not the row text.** `providers.ts` says nothing a launch does not do. Ready is split from proven (revision 4): OpenCode's row is ready because the launch code has everything it needs; the live proof in task 10 gates the merge, not the flag, and if it fails the row goes back to not ready with the reason before merge.
- **Files:** `packages/cli-runner/src/acp-host.ts`, `packages/acp/src/providers.ts`, `packages/acp/src/tool-table.ts` if the row mechanism needs a shape change, `scripts/acp-handshake-check.ts`, `scripts/start-jarv1s.ts` (the runner child through `setpriv`), `packages/cli-runner/src/owned-fs.ts` (shared parents, created-only cleanup), a small preparation program in the runner package run as the slot account (its name is the builder's), `infra/docker-compose.prod.yml`, `infra/docker-compose.yml`, `infra/systemd/jarv1s-dev-cli-runner.service`, their tests; the dev service install commands in the PR notes.
- **Tests:** host unit tests: slot keyed by user id, `HOME` is the slot home, Codex and OpenCode environments carry no Claude token, Codex launch refuses as not logged in at the runner's spawn step and in the client, identity off refuses with no file written, the exec methods are absent from the connection's method table, a failed ownership handover fails the launch and leaves nothing it created while a pre-existing folder and its contents survive, the shared parents stay launcher-owned and passable while a second person's folder is created after the first's, a second launch for the same person succeeds after the first with that person's top level already handed over and owner-only (the test either runs with the three privileges or fakes the launcher's refusal at a handed-over folder), a top level owned by another account refuses the launch, the preparation step is started through `setpriv` as the slot and its non-zero exit fails the launch with its message, the stop command runs nothing but `setpriv` and the runner's own Node binary and never a separate `kill` program, the agent's command line goes through `setpriv` dropping all inheritable and ambient privileges (the spawn stand-in asserts the wrapper and its flags), each row's off-list reaches its mechanism from the table, no deny file for the Workshop profile.
- **Gate:** the four checks; `pnpm vitest run packages/cli-runner packages/acp`; then task 4 rerun.

### Task 5c. Client lifecycle: one turn's reply, and close kills the session (before task 7)

- **Builds:** in the protocol client, reply text and tool counts are collected per turn, reset at each `session/prompt`, so a second turn returns only its own answer (finding 5: offline, two prompts returned `answer-1` then `answer-1answer-2`); `close` kills the runner session and stops its polling stream before revoking the bearer (finding 6: zero kill calls after close, and the polling kept the runner's activity timestamp fresh so idle cleanup never fired).
- **Files:** `packages/acp/src/client.ts`, `packages/acp/src/client.test.ts`.
- **Tests:** two-turn reply isolation for text and counts; close issues exactly one kill and the poll loop ends.
- **Gate:** the four checks; `pnpm vitest run packages/acp`.

### Task 6. Approval wiring and the built-in permission policy

- **Builds:** `packages/ai/src/gateway/acp-permission.ts` restored (policy keyed on real tool name, matched by tool call id, zones from spec section 7, audit lines); the gateway's `requestAcpBuiltInPermission` method and the index re-exports restored here, not in task 5 (the refusal wording constant already landed in task 5); agent asks that need a
  person create a gateway pending action and emit the existing `action_request` event, and the ACP
  request is answered from that resolution; every pending ask answered `cancelled` on `session/cancel`; the OpenCode settings-file write lives in task 5b with the other rows' off-lists (moved 2026-09-08). The spec 7 point 3 deferral is written into the spec's review record.
- **Files:** `packages/ai/src/gateway/{acp-permission,gateway,index}.ts`,
  `packages/acp/src/permissions.ts`, `packages/ai/package.json` (the `@moss/acp` workspace dependency, restored here with its first importer), `docs/superpowers/specs/2026-09-06-acp-client-design.md`.
- **Tests:** `tests/unit/acp-builtin-permission.test.ts` restored and extended for the cancel case.
- **App map:** `app-map-core.ts` gains the "not approved, ask the user" error and remediation.
- **Gate:** the four checks; `pnpm vitest run tests/unit/acp-* tests/unit/gateway-*`.

### Task 7. Chat answers through the protocol

- **Builds:** an ACP chat engine behind the session manager for the `chat` profile, chosen by
  `engine-selection.ts` for every conversation (no setting); session key and folder as decided;
  history replayed from Postgres into the prompt; the model option is set before the first prompt on every session that advertises it (Decisions, model choice), so no provider is ever prompted unset; the stop button sends `session/cancel`; a second
  send during a turn is held by the composer, which says so, and sent when the turn finishes; stop reasons surface as typed events; an
  `auth_required` answer becomes the provider's "Not logged in" status and the drawer reply "The
  <provider> sign-in has expired; an admin can log it in again under Settings, Assistant & AI";
  reply persisted through the existing transcript path; the session is started when the conversation is opened in the drawer, not on the first send, so no first prompt pays the session start (PM, 2026-09-07).
- **Files:** `packages/chat/src/live/{engine-selection,runtime,chat-session-manager}.ts`, a new `packages/chat/src/live/acp-chat-engine.ts`, `packages/chat/src/manifest.ts`, `tests/uat/specs/2424-acp-chat-lunch.uat.spec.ts` (the live-proof script task 10 runs; modelled on `tests/uat/specs/chat-drawer-private.uat.spec.ts`).
- **Tests:** engine unit tests (login failure text, replay shape, stop reason mapping, cancel
  answers pending asks, warm start on open, model always set before the first prompt including the `default` binding); composer test that a queued message sends when the turn finishes, not only on Stop.
- **App map:** chat manifest `features`: answers through the agent protocol, the sign-in expired
  message, queued sends.
- **Gate:** the four checks; `pnpm vitest run packages/chat`; full gate via `verify-gate`.
- **Early live proof (revision 5, retro of 2026-09-08; Prover, not Builder).** Task 8 does not start until this is on the PR. On dev, signed in as a real Moss account, chat answers one plain question through the new path on the instance default provider (Claude), and the behind-the-scenes evidence names the new path, not the old bridge. Prover writes the click-by-click script before the builder starts this task and hands it to PM; the script's wording goes into this bullet verbatim, as Prover's, when it arrives. Prover reads no diff for this: the builder's handoff names the running dev address, the account to sign in as and the engine the row is set to, and Prover executes the list and reports what it saw. A failure here is a small change sent back, not a large one at the top of the stack. **Telling the paths apart (Architect, 2026-09-08, on Prover's question):** at task 7 a plain answer looks the same from either path by design; the visible difference (the fold showing the tool call, the stats strip) is task 8. So task 7's proof uses two signs. On screen: a second send during a turn is queued and the composer says so, which the old bridge never did. In the log: the new engine writes exactly one line at session open naming the conversation id and the provider kind, and the builder's handoff quotes that line word for word so Prover searches for it, never guesses it. The shell refusal is the third check and is visible on screen: the reply says the request was refused and no approval card appears.
- **Prover's task 7 script (Prover's wording, 2026-09-08; blanks marked "builder supplies" come in the handoff, everything else is fixed).** Before Prover starts, the builder's handoff gives: (1) the dev instance address, running, with the branch's code on it; (2) the account to sign in as, and its password; (3) which engine the conversation's row is set to (expected: Claude); (4) the exact log line the new path writes at session open, quoted word for word, and where to find it.
  - Setup. 1. Sign in at the address given. Screenshot the signed-in screen. 2. Open a new chat conversation. Note the conversation's name or id shown on screen. 3. Start watching the log from now, not from the beginning.
  - Check 1, the new path answered (deciding proof). 4. Send: `Hello, please introduce yourself in one sentence.` 5. Wait for a complete answer. Screenshot the answer. 6. Search the log for the quoted session-open line. Record: the matching line in full, with the conversation name and provider it names, and confirm they match step 2 and item 3 above. No match, or a different provider, is a fail.
  - Check 2, queued send (supporting). 7. Send a slower message: `Count from one to twenty, one number per line, slowly.` 8. While it is still answering, send a second message: `And then say done.` 9. Screenshot the composer immediately. Record whether it says the message is queued, and the exact words it uses. 10. Wait. Record whether both answers arrive, in order.
  - Check 3, shell refused (the point of the slice). 11. Send: `Run the command "whoami" in a shell and tell me the output.` 12. Screenshot the whole reply. 13. Record: does the reply say it cannot run shell commands, and does no approval card or permission prompt appear anywhere on screen. An approval card appearing is a fail even if the command is then denied. 14. Screenshot the conversation once more after the reply settles, to show no card appeared late.
  - What Prover posts to the PR: every screenshot, the quoted log line in full, the exact wording of the queued-send notice, the exact wording of the refusal, and a plain pass or fail per check. Any check Prover could not run is named as not run, not as passed. The log line decides; the queued-send notice supports (Prover's caution: it proves the new path only if the old bridge never queued, which is read from code, not watched).

### Task 8. Behind the scenes: the fold and the stats strip

Starts only after Ben has seen the mockup (posted in the room 2026-09-07).

- **Builds:** transcript records for thought, tool call (real name, summarised arguments), result
  (capped), approved / not approved / refused lines, written as the protocol updates arrive so the
  open fold is the live view; the reply record stores elapsed ms and the usage block; the stats
  strip (`chatd-stats`, one new primitive in `components-chat.css`) under the reply: elapsed, then
  input, output, cached-read tokens with flat icons and word tooltips, each number shown only when the agent sent it (OpenCode sends no cache split, so it shows two); a thought-token count, when sent, is stored with the block and not shown.
- **Files:** `packages/shared/src/chat-api.ts`, `packages/chat/src/live/acp-chat-engine.ts`,
  `packages/ui/src/chat-thread.tsx`, `packages/ui/src/styles/components-chat.css`,
  `apps/web/src/chat/message-row.tsx`, `packages/chat/src/manifest.ts`.
- **Tests:** record mapping unit tests (each update kind to its line; usage absent shows time
  alone); a web test that the fold lists the lines in order and the strip renders the numbers
  given.
- **App map:** chat manifest `features`: the fold and the strip.
- **Design gate:** the invented-class audit from the `design-system` skill run on `apps/web/src/chat`
  and `packages/ui/src`, output on the PR.
- **Gate:** the four checks; `pnpm vitest run packages/chat packages/ui apps/web`.

### Task 9. Delete chat's half of the bridge, settings wording, second gate

- **Measure first:** the spike's read prompt run three times through the ACP engine on dev, wall-clock per turn recorded on the PR next to the bridge's 11.0 to 12.6 s from the Premises. The gate passes when the ACP median is within the bridge's slowest run plus 20 percent (15.1 s). If not, stop and report to PM before deleting anything.
- **Builds (narrowed, PM 2026-09-07 on Reviewer's finding 1):** only what chat alone used goes: the engine choice in `engine-selection.ts` and its provider-naming rules, `claude-print-chat-engine`, `gemini-print-chat-engine`, `codex-exec-session`, the tmux REPL chat engine implementation (`cli-chat-engine-impl` and its launch commands) and `claude-permission-hook`. What stays, named so nobody deletes it early: the persistent runtimes (`claude-persistent-runtime`, `codex-persistent-runtime`, `persistent-runtime-*`), the engine type and launch config in `cli-chat-engine.ts`, and `cli-structured-adapter.ts`, because module chat, module builds and the unattended callers still stand on them; slice 2 moves those callers and deletes the rest, so the bridge is gone with no fallback by the end of slice 2. Builder confirms before deleting each file that nothing outside `packages/chat/src/live/` imports it. No fallback
  setting. Settings: each provider card's "Not logged in" state driven by the adapter's initialize
  check; a provider whose row cannot honour a model choice says so beside its list; OpenCode card.
- **Files:** `packages/chat/src/live/**` (deletions), `packages/chat/src/routes.ts`,
  `apps/web/src/settings/settings-ai-admin-pane.tsx`, `packages/shared/src/app-map-core.ts`,
  the tests of the deleted engines.
- **Tests:** deleted engines' tests removed; a test that chat's engine selection has one path; module chat and module build tests still green untouched; settings
  web test for the login state and the model-choice note.
- **App map:** `aiproviders` entry: login-check wording, model-choice note, OpenCode.
- **Gate:** the four checks; `pnpm vitest run packages/chat apps/web`; full gate via `verify-gate`.

### Task 10. Live proof and slice exit (Prover, not Builder)

- **Proof:** on dev, "add lunch with Sam on Thursday at noon" in the drawer, the approval card
  answered by a person, one event in the calendar, the fold open showing the tool call and the
  approval, the stats strip present; once on the instance default provider (Claude) and once on
  OpenCode on Muse Spark 1.3 free. Codex is not ready in this slice (no stored login of its own) and records no turn; the PR shows its row marked not ready with the reason. The first real turn on each provider records its usage block on the PR (real numbers or zeros). On OpenCode the proof also shows, in the runner's real per-user home, that the deny file is present at session start and a shell request in chat gets no shell tool and no approval card; the row is already marked ready on the branch, and that evidence is what lets the PR merge with it so; without it the row goes back to not ready with the reason before merge (revision 4; Scout's scratch-home result, 2026-09-07, is not that evidence). OpenCode's first two calls take 15 to 20 seconds; that is expected, not a hang.
- **Evidence:** `tests/uat/specs/2424-acp-chat-lunch.uat.spec.ts` (added by Builder in task 7,
  run by Prover) exit code and assertions, the audit lines, the bounded engine log. No screenshots.
- **Kill gate (slice exit):** the attended write finishes in under 30 s on dev on the instance default provider (Claude), the clock running from the person's approval click to the event in the calendar and the reply in the drawer (PM, 2026-09-07); the time from send to the approval card is recorded beside it. Session start is not on the clock and is paid at drawer open (task 7), which is where OpenCode's 15 to 20 s go. OpenCode's time is recorded beside it and is not held to the 30 s bar in this slice. If Claude does not make it, the slice stops here and PM reassesses before slice 2.

## Order and hand-offs

**Working rules from the retro of 2026-09-08 (revision 5; PM's rulings, adopted by Ben's team).** They bind tasks 6 to 10.

1. **Review per task, not per slice.** The reviewer reads each task's commit range and posts findings before the next task starts. Nine defects on one whole-slice pass was the cost of not doing this.
2. **Every handoff opens with the same five lines:** the head commit, the plan revision it was built against, the tasks done, the open findings, and the evidence so far (checks by name for that head, and what was not run). Nobody reconstructs this from chat or commit history again.
3. **Privilege work gets a throwaway run first.** Anything touching accounts, privileges or folder ownership is tried once with the real privilege set, in a scratch run, before the task text is written. Every one of the nine task 5b defects was invisible to tests running as the launcher's own account.
4. **Builders stay silent during gates and check runs**, then report once when the run settles, red or green, with the checks named for the head. No minute-by-minute commentary.
5. **One task per assignment.** PM hands a builder one task; a list of items comes back partly done.
6. **Prover proves early.** The task 7 early live proof (above) runs before task 8, so the first click through the real screen is on a small change, not on the whole stack at task 10.
7. **Status words stay separate:** implemented, reviewed, checks green, live proven. A report that uses one never implies the next.

1 → 2 → 3 → 4 → 5 → 5b → 4 rerun (first kill gate, on the running service) → 5c → 6 → 7 → 8 → 9 (second gate) → 10. Task 5 may run in parallel with 3 and 4 if two builders are available; both land on the same lane branch and PR. Reviewer reviews each task's commit range before the next task starts.

**Stacked pull requests from task 6 onward (Ben, 2026-09-08, on PM's recommendation; nothing already open changes).** Tasks 1 to 5c stay as they are on PR 2427. From task 6 on, each task is its own pull request on its own branch, stacked on the one below it: task 6 branches from the slice branch and targets it; task 7 branches from task 6's branch and targets it; and so on. Each layer is reviewed and merged downward in order, so a merge of task 7 carries task 6 with it; a builder may start the next layer on top of an open one without waiting for a clean tree. Check names and results are reported per layer, for that layer's head. The live proof (task 10) happens once, at the top of the stack, on the slice branch after every layer has merged into it, before the slice branch goes to main. The layers and what each stands on: task 6 (approval wiring) on the slice branch, no chat engine needed; task 7 (chat through the protocol) on task 6, since its asks and cancels go through task 6's pending actions; task 8 (the fold and the stats strip) on task 7, since it writes records from the engine task 7 creates and edits that engine file, so a task 7 review fix underneath is the one place a rebase can conflict; task 9 (the deletion and the settings wording) on task 8, since it removes the old chat path only once task 7 is the sole path and its measure gate runs against that engine; task 10 is not a layer, it is Prover's proof on the assembled slice branch. Task 9 touches different files from task 8, so if two builders are free it may be built at the same time as task 8 by branching from task 7 and rebasing onto task 8 when task 8 merges; that is the one place the stack forks, and the rebase is the second builder's job.

## Out of scope for this slice

The Workshop, its profile, its service key and its panel (slice 3); unattended callers, moving module chat and module builds off the bridge and the deletion of the persistent runtimes, the engine type and the structured adapter, the terminal-type login path, agy (slice 2); the runner audit
(slice 2); the gateway hold through the protocol card (slice 3); user-level model override; ACP
`terminal/*`.
