# Relay — #1121 scriptable UAT chat (build agent)

**Spec (approved):** `docs/superpowers/specs/2026-08-10-1121-scriptable-uat-chat.md`
**Issue:** #1121 · **Risk tier:** `sensitive`
**Worktree:** this one · **Branch:** `build/1121-scriptable-chat` off `origin/main` @ `7aa85f628`
**Coordinator:** label `Coordinator`, session `019fefbd-5852-71d2-b0b1-4da3cdbbf1d1` (re-resolve pane fresh, never reuse a `…-N`)
**Handoff:** `docs/superpowers/handoffs/2026-08-11-1121-scriptable-uat-chat.md` (original — read it too)

## State

No code written yet. `pnpm install` already done — **skip it**. Git tree is clean; nothing to
commit. This session relayed at the context-meter 70% warning, still in the seams-check/planning
phase, before writing the `plan-build` plan document. Coordinator was notified of the relay
(message sent, no reply required to proceed — successor still owes it the plan pointer per the
approval gate once the plan exists).

## What's verified (no drift found)

Checked every spec premise against this branch — all current:
- `tests/uat/run-uat.ts` `readUatLevel` regex is at lines 45-46; extend it (don't replace) with an
  optional `chatScript: "<id>"` field, same pattern as the existing `withoutNewsJsonBinding` /
  `withJobSearchFixture` optional trailing keys.
- `tests/uat/provisioner.ts`: `UatProvisionOptions` interface at 608-618 (add `chatScript?:
  string`), `provisionForUat` signature at 663-665, `SeedHook` type 368-376, `composeSeedHook`
  (sets `JARVIS_UAT_SEED_CONFIRM`) at 417.
- `tests/uat/seed/guard.ts:20` `assertTargetIsEphemeral`; called before any seed write at
  `tests/uat/seed/cli.ts:47-59` and `tests/uat/seed/admin.ts:35`.
- `tests/uat/seed/chunks/ai.ts:11-42` `seedAiProviderChunk` — direct template for the new
  scripted-provider seed row (same non-secret `{cli:true}` credential pattern via
  `cipher.encryptJson`, swap `providerKind:"custom"`→`"anthropic"`, `capabilities:["json"]`→
  `["chat"]`, no service binding).
- `packages/chat/src/live/claude-print-chat-engine.ts`: `buildCommand` 245-282,
  `buildStructuredCommand` 285-310 (must be REJECTED by the fixture), `writeClaudeMcpConfig`
  312-330 — these are the exact launch shapes the fixture executable parses/validates.
- `packages/ai/src/adapters/tmux-bridge.ts:93` — canonical `transcriptGlobDir(provider, cwd,
  homeBase?)` export from `@moss/ai`. Fixture MUST call this, never reimplement the path encoding.
- `packages/ai/src/gateway/confirmation-registry.ts:12` `ConfirmationRegistry`;
  `packages/ai/src/gateway/gateway.ts` private `confirmAndRun` at 528 (called from 218/247),
  read-only-tool bypass at 470.
- `apps/web/src/chat/action-request-card.tsx:62` — real Playwright selector
  `.action-request-card`, imported at `apps/web/src/chat/message-row.tsx:28`.
- `packages/chat/src/routes.ts:277` + `packages/ai/src/gateway/gateway.ts:256` +
  `packages/chat/src/live/claude-permission-hook.ts:409` — confirmed NO server-side canonical
  `mcp__jarvis__<name>` transform exists anywhere; only prefix-startsWith checks. **The fixture
  must independently implement the dot→underscore tool-name derivation** — state this as an
  explicit algorithmic decision in the plan, not a citation.
- Fixmes confirmed present, to replace: `tests/uat/specs/runtime-context.uat.spec.ts:111,122`;
  `tests/uat/specs/1133-chat-attachments.uat.spec.ts:155`;
  `tests/uat/specs/1264-settings-self-operation.uat.spec.ts:87`;
  `tests/uat/specs/self-operation-content-commands.uat.spec.ts:44,51,59`;
  `tests/uat/specs/1311-install-grant.uat.spec.ts:94`. `app-map-grounding.uat.spec.ts` has 12
  #1110/#1121 deferral comments across lines 10-139 to convert.
- `tests/uat/fixtures/chat-scripts/` and `tests/uat/fixtures/scripted-provider/` do not exist yet
  (net new). `tests/uat/specs/scripted-chat-confirmation.uat.spec.ts` does not exist yet (net new).

## Two real gaps vs. the spec's prose (already flagged to Coordinator, not yet ruled on)

1. **`JARVIS_CLI_TOOLS_PREFIX` is hardcoded, not env-overridable.** UAT provisioning drives
   `infra/docker-compose.prod.yml` (single combined `jarv1s` service — confirmed via
   `tests/uat/provisioner.ts:429` `UAT_COMPOSE_FILE = "infra/docker-compose.prod.yml"`), **not**
   the separate-services `infra/docker-compose.yml` (that one is CI-only, no CLI-runner env at
   all — don't confuse the two in the plan). In the prod compose, the `jarv1s` service hardcodes
   `JARVIS_CLI_TOOLS_PREFIX: /data/cli-tools` at **line 152**. Plan needs a step to change that
   line to `${JARVIS_CLI_TOOLS_PREFIX:-/data/cli-tools}` so a scripted UAT run can override it to
   point at the fixture's `bin/` dir while prod keeps the same effective default.
2. **`chat.persistent_runtime.enabled` does not exist anywhere in the tree.** Grepped
   `persistent_runtime`/`persistentRuntime`/`PERSISTENT_RUNTIME` (any casing) across `packages/`,
   `apps/`, `tests/` — zero matches. Both the spec and the original handoff's collision notes treat
   this as an existing setting that scripted runs must "pin off." It needs to be introduced
   (likely `packages/settings` runtime-config-keys registry or an `instance_settings` key,
   following whatever pattern nearby booleans use) as an explicit plan step — flag this to the
   Coordinator as scope beyond a literal reading of the spec, not something to silently absorb.

## Next concrete steps (in order)

1. Read `docs/superpowers/specs/2026-08-10-1121-scriptable-uat-chat.md` **by section only** —
   Minimal Implementation + Locked Boundaries + Acceptance mapping — to write the plan.
2. Write the `plan-build` plan to `docs/superpowers/plans/2026-08-11-1121-scriptable-uat-chat.md`:
   Phase 1 = fixture contract (`tests/uat/fixtures/chat-scripts/*.json` schema) + fixture
   executable (`tests/uat/fixtures/scripted-provider/bin/claude`) + harness/seed wiring
   (`run-uat.ts` regex extension, `provisioner.ts` `chatScript` threading, new seed chunk/row,
   compose line-152 fix, new `chat.persistent_runtime.enabled` setting) + unit/integration tests —
   covers spec sections 1-3 and automated checks 1-5. Phase 2 (kill-gated on Phase 1 review) =
   convert the 7 mapped UAT specs + `scripted-chat-confirmation.uat.spec.ts` + live-path evidence —
   covers the spec's Acceptance mapping + automated check 6 (parse Playwright's actual result, not
   just exit 0).
   - Cite the seams-check items above with file:line in the plan's assumed-capabilities section.
   - State the two gaps above as named open questions for the Coordinator, OR as explicit plan
     steps if you judge them clearly in-scope — Coordinator can overrule either way.
   - Determinism boundary: fixture owns only tool/args/reply decisions; no DB/vault writes or REST
     shortcuts from the fixture; default (`chatScript` unset) behavior byte-for-byte unchanged;
     confirmation-registry flow stays real (proven by the new confirmation spec); actor identity
     from the server-minted MCP token only.
   - Kill gate: name it explicitly after Phase 1, with an owner (the Coordinator, since this is a
     `sensitive`-tier build).
   - All verification commands unpiped with expected exit codes, per `plan-build` rule 5.
3. Message the Coordinator with the plan pointer. **STOP and wait for approval** — do not write
   code before it.
4. Only after approval: build Phase 1 task-by-task with TDD, commit green, kill-gate review, then
   Phase 2, then `coordinated-wrap-up` (gate, PR, live-path proof via real UAT run against the
   scripted fixture, report to Coordinator).

## Reminders

- Never touch `docs/coordination/`, never repo-wide format, explicit `git add` paths only.
- No credential/private-content exposure in fixtures, logs, docs, prompts.
- Scope ends at PR + report — never move the board, close the issue, or merge; that's the
  Coordinator's job.
- Relay again on the next 70% context-meter warning or compaction summary — don't wait for a felt
  sense of degradation.
