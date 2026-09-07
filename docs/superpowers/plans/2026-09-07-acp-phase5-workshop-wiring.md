# Plan: ACP phase 5 — Workshop wiring, settings, map, proof (issue 2381)

Part of #2369, closes it. Follows phase 4. Ruling on 2396 item 1 (accept, document,
real confinement is 2414) lands here as four conditions plus five prohibitions.

## Seams verified on this branch (all cited, all current)

- Reply entry: `attemptProjectReply` in packages/workshop/src/project-reply.ts:170,
  called from project-routes.ts:240. Never-throws contract on lines 165-169.
  No ACP branch exists; settings read nowhere in workshop.
- Settings registry: packages/settings/src/instance-settings-keys.ts:14. Generic
  admin read/write at packages/settings/src/routes.ts:443 (`GET /api/admin/settings`)
  and :470 (`PATCH /api/admin/settings/:key`), keyed by the registry, no migration.
  Plain-string precedent: `web.native_search_enabled`, read at
  packages/settings/src/web-search-engine-resolver.ts:24.
- Client: `MossAcpClient.openSession` at packages/acp/src/client.ts:147 always
  passes surface `workshop` default, sends blanket `_meta.disableBuiltInTools`
  at client.ts:168, gates capabilities at :161. No production instantiation
  exists (grep: only client.ts and index.ts reference the class).
- Launch list: `launchOffList` at packages/acp/src/tool-table.ts:69, documented
  "phase 5 passes these on". Spec section 3 condition 3: phase 5 replaces the
  blanket flag with the surface off-list as `_meta.claudeCode.options.disallowedTools`.
- Cards: MCP build-command cards via gateway `confirmAndRun`
  (packages/ai/src/gateway/gateway.ts:736), summary from tool `summarize`.
  runCommand summarize at packages/workshop/src/manifest.ts:221 shows the whole
  command. Emission on the token session id at gateway.ts:201-206.
  Built-in asks via `requestAcpBuiltInPermission`
  (packages/ai/src/gateway/acp-permission.ts:212), card text `acpCardText` at :129.
- Delivery: `ChatGatewayNotifier.emit` (packages/chat/src/gateway-notifier.ts:13)
  falls back to the raw key for `workshop:<uid>:<pid>` keys, which have no
  subscriber (subscribe keys are `actor:surface`,
  packages/chat/src/live/chat-surface.ts:19). The card is lost today.
- Scrubber: `redactSecrets` (packages/ai/src/adapters/redact.ts:22) covers token
  shapes only. Build output path (`appendExecOutput` at
  packages/cli-runner/src/acp-host.ts:742, returned by `execPoll` at :683) is
  unscrubbed; only stderr tail is scrubbed (:418).
- Token mint: `mcpTokenLifecycle` mint/revoke in packages/chat/src/routes.ts:298,
  allowlist from `listToolsForActor`. Workshop composition at
  packages/module-registry/src/index.ts:2658 passes no gateway deps today.
- Map: artifact errors derive from manifest features
  (scripts/build-app-map.ts:52); `app-map-core.ts` has NO errors list, only
  screens+settings. The plan line "core gains the matching error entry" is stale
  (see decisions D5). Manifest checks enforce description length and
  remediation refs (module-registry index.ts:2690+).
- UAT shape: tests/uat/specs/workshop-project-entry.uat.spec.ts:1 (Playwright,
  isolated provisioner guard). Trigger map at
  .claude/skills/coordinate/uat-trigger-map.tsv:118 already covers
  packages/workshop/\*\*.

## Decisions

- D1 Settings values: `default` (today's engine) and `claude-code-acp`. Unknown
  value reads as `default` with a warning. Keys `workshop.agent`, `chat.agent`
  appended to the registry, never reordered. No per-person override.
- D2 Agent list per surface comes from a catalog both sides import
  (`ACP_KNOWN_AGENTS` in `@moss/shared`): Claude Code passes Workshop only;
  nothing passes chat yet (capabilities.ts:46 always refuses chat), so the chat
  select shows `default` plus a note. Adapter-start gate stays the enforcement.
- D3 Reply branch lives in `attemptProjectReply`: setting `claude-code-acp`
  plus injected opener takes the ACP path, else today's path byte for byte.
  ACP selected but opener absent, or any failure at any step, returns
  `{ delivered: false }`. The POST handler shape does not change.
- D4 Workshop drives a narrow opener interface; composition (chat package side,
  where gateway deps live) implements tunnel plus token mint plus decider.
  Session key `workshop:<userId>:<projectId>`. History replays from feed rows
  (cap 20 entries / 8000 chars). Prompt timeout 10 min (covers 150 s holds).
  Bearer is fixed-expiry, revoked in a finally close.
- D5 Map drift: with no core errors list, the workshop feature entry plus its
  error and remediation IS the matching entry (artifact carries module and
  feature ids). No core file touched; drift recorded here and in the PR.
- D6 Approval routing fork (flagged to coordinator): workshop-keyed
  `action_request`/`action_result` events route to the owner's chat drawer,
  the one answerable card that exists, instead of a new project-window card.
  Reason: pending rows carry no project attribution, so a project card needs a
  schema change; the drawer already re-hydrates pending cards and resolves by
  id. If the coordinator wants the card in the project window instead, the
  routing line is one place and this plan's T8 is replaced.
- D7 Scrub point is the runner `appendExecOutput` (covers poll, tool result,
  agent, chat, audit downstream). Residual said plainly in spec and PR:
  shape-based scrubbing plus single-owner acceptance is not a sandbox.
- D8 The sandbox sentence (brief wording, exact) goes on the runCommand
  `summarize` (the card), the new feature description (the map), and the spec.
  Built-in shell stays doubly off (launch off-list plus runner settings file),
  so no second card needs it. No always-allow, no remembered approval, full
  command on every card, env and folder exactly as phase 3 left them, per-user
  identity stays off.

## Tasks (commit per task, only the named files)

1. Settings keys, catalog, read helpers.
   Files: instance-settings-keys.ts (append two keys), new
   packages/shared/src/acp-agents.ts (catalog, `agentsForSurface`, login
   sentence), new packages/settings/src/agent-settings.ts
   (`WORKSHOP_AGENT_SETTING`, `CHAT_AGENT_SETTING`, read with `default`
   fallback, `isKnownAcpAgentId`). If packages/settings/src/manifest.ts
   enumerates instance settings, append there too.
   Tests: unknown value reads as default; unknown id rejected; agentsForSurface
   returns Claude Code for Workshop only. Each fails if the allowlist or the
   fallback is wrong.
2. Admin pane selects. Files: apps/web/src/api/client.ts (add
   list/upsert instance-setting calls), settings-ai-admin-pane.tsx (new
   Agents group with Workshop and Chat selects, login sentence beside the
   outside agent, chat note that no outside agent passes yet).
   Tests: existing settings pane checks plus a render/behavior check that only
   passing agents are offered per surface; fails if chat offers Claude Code.
3. Launch off-list switch. Files: packages/acp/src/client.ts (send
   `_meta.claudeCode.options.disallowedTools` from `launchOffList(surface)`,
   drop the blanket flag), client.test.ts (expect the off-list per surface).
   Tests fail if the blanket flag is still sent or Workshop allows shell.
4. Build-output scrub. Files: packages/cli-runner/src/acp-host.ts
   (`appendExecOutput` runs `redactSecrets` before retaining).
   Tests: token-shaped output (`Bearer`, `jst_`, `JARVIS_MCP_TOKEN=`) comes
   back redacted from `execPoll`; fails on the unscrubbed path. Record the
   fail-without-protection run in the PR.
5. Sandbox sentence on the card. Files: packages/workshop/src/manifest.ts
   (`summarize` appends the exact sentence).
   Tests: summary contains the full command plus the sentence; fails if either
   is missing or the command is cut.
6. ACP reply path. Files: new packages/workshop/src/acp-reply.ts (prompt
   build from persona plus two build sentences under 150 words total, history
   replay, open/prompt/close, persist via `appendAssistantReply`), edit
   project-reply.ts (branch per D3), project-routes.ts (pass opener through),
   new opener implementation chat-side plus composition threading.
   Tests: setting `default` keeps byte-for-byte behavior (existing tests);
   ACP selected without opener delivers false; history cap respected; prompt
   carries persona plus feed lines; fails if the old path changes or an
   exception escapes.
7. Approval routing. Files: packages/chat/src/gateway-notifier.ts (workshop
   keys inject to the owner on the default surface).
   Tests: workshop-keyed request and result reach the owner subscriber; main
   chat keys unchanged; fails if the card is still lost.
8. Map entries, append-only. Files: packages/workshop/src/manifest.ts
   (append feature with behavior description carrying the sentence, the
   not-approved error, remediation). Nothing reordered.
   Tests: manifest consistency checks plus artifact build include the new
   entries; fails if ids or refs break.
9. Spec section plus UAT plus trigger rows. Files:
   docs/superpowers/specs/2026-09-06-acp-client-design.md (append "What a
   build command can reach", link 2414), new
   tests/uat/specs/2369-acp-workshop-build.uat.spec.ts (real project, real
   build command, approval answered in the drawer, reply delivered),
   uat-trigger-map.tsv (rows for the touched Workshop, settings, runner
   files). Verify 2414 exists before linking.
10. Live proof on dev: real project, real build, card answered by a person,
    inside 30 s. If no person is reachable, report code-complete plus the
    green UAT run, never claim the proof.

## Determinism boundary

Visible answers render from feed rows and notifier events, never raw model
text. The agent has two jobs: answer the project message, pick tools inside
the turn. No turns enter host chat. Model text crosses into user data only
through `appendAssistantReply`. Guidance stays under 150 words.

## Kill gate

If open, initialize, session, prompt cannot complete against the real adapter
on dev after tasks 3 and 6 (login, environment, transport), stop and re-slice.
Owner: coordinator. The 30 s attended slice proof is the exit.

## Verification (unpiped, exit 0)

- `pnpm vitest run packages/acp packages/workshop packages/settings packages/cli-runner > /tmp/p5-unit.log 2>&1; echo EXIT=$?`
- `pnpm format:check > /tmp/p5-fmt.log 2>&1; echo EXIT=$?`, then `pnpm lint`,
  then `pnpm typecheck`, each unpiped, before every push.
- Full gate only via the verify-gate skill (`scripts/run-gate.sh start`,
  then `wait --follow` backgrounded). Never a bare gate command, never piped.
- UAT through the coordinator harness on live dev.

## Review checklist

- [ ] Task issue 2381 open and named; spec approved; ruling 2396 read
- [ ] Every assumed capability cited file:line above, or settled (tunnel
      backing verified first in task 6 before building on it)
- [ ] No function bodies above; signatures, test cases, commands only
- [ ] Determinism boundary stated; guidance under 150 words
- [ ] E2E named (task 10); every command unpiped with exit 0
- [ ] Kill gate named with owner; rejected option (project-window card)
      steelmanned in D6
