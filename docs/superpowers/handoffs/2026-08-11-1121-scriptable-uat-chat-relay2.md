# Relay 2 — #1121 scriptable UAT chat (build agent)

**Spec (approved):** `docs/superpowers/specs/2026-08-10-1121-scriptable-uat-chat.md`
**Issue:** #1121 · **Risk tier:** `sensitive`
**Worktree:** this one · **Branch:** `build/1121-scriptable-chat` off `origin/main` @ `7aa85f628`
**Coordinator:** label `Coordinator`, pane `w1:p73`, session `019fefbd-5852-71d2-b0b1-4da3cdbbf1d1`
  (re-resolve pane fresh via `herdr pane list` — never reuse a `…-N`)
**Prior relay:** `docs/superpowers/handoffs/2026-08-11-1121-scriptable-uat-chat-relay.md` (read
  that one too — this doc only adds to it, doesn't repeat its full seams-check list)
**Original handoff:** `docs/superpowers/handoffs/2026-08-11-1121-scriptable-uat-chat.md`

## State

Still zero code written, zero plan document written. Git tree clean, nothing to commit except this
doc. This is the **second** relay in the seams-check/planning phase — both relays hit the 70%
meter before producing the plan. **Do not repeat that pattern**: read the spec by section, then
write the plan in the same turn, don't re-verify what's already cited below.

## Everything in relay 1 still holds — re-read it, don't re-derive it

All seams-check citations, the two flagged gaps (compose `JARVIS_CLI_TOOLS_PREFIX` line 152 fix;
new `chat.persistent_runtime.enabled` instance-setting), and the ordered next-steps list in
`2026-08-11-1121-scriptable-uat-chat-relay.md` are current — verified against this branch again
this session, no drift.

## New this session: gap 3, folded into a concrete plan step (not an open question)

`tests/uat/seed/levels.ts:75-77` — `seedLevel` returns **before** `seedAiProviderChunk` (line 89)
when `options.level === "solo-admin"`. 4 of the 6 mapped target UAT specs run at solo-admin level:
`runtime-context.uat.spec.ts`, `1133-chat-attachments.uat.spec.ts`,
`1264-settings-self-operation.uat.spec.ts`, `1311-install-grant.uat.spec.ts` (the other two:
`app-map-grounding.uat.spec.ts` = multi-user, `self-operation-content-commands.uat.spec.ts` =
admin+data — both already past the early return).

**Decision:** the plan needs a `chatScript`-gated call to seed the scripted AI provider row
**before** the `if (options.level === "solo-admin") return;` line, independent of the
onboarding/data-chunk ladder — solo-admin specs need the scripted model to exist and be selectable
by `selectChatModelForUser`, they don't need onboarding-chunk or data-chunk seeding. This is a
narrow, in-scope addition (one new conditional call + a `chatScript` field threaded onto
`SeedOptions`, per `tests/uat/seed/types.ts`), not a redesign of the level ladder. Confirmed this
doesn't block AppShell reachability — solo-admin already reaches AppShell today by whatever
existing mechanism the passing (pre-fixme) parts of those 4 specs rely on; that mechanism is
unrelated to AI-provider seeding and out of scope here.

Cite in the plan: `tests/uat/seed/levels.ts:58-77` (full function shown — early return at 75-77,
`seedAiProviderChunk` call at 89 for comparison), `tests/uat/seed/types.ts` `SeedOptions` (needs
`chatScript?: string`), `tests/uat/seed/cli.ts:74-83` (env-var read + `seedLevel` call site — add
`JARVIS_UAT_SEED_CHAT_SCRIPT` alongside the existing optional vars there).

## Next concrete steps (unchanged from relay 1, restated for clarity)

1. Read the spec **by section** (Minimal Implementation + Locked Boundaries + Acceptance mapping)
   — do not re-read sections already summarized in relay 1 / the analysis that produced it.
2. Write `docs/superpowers/plans/2026-08-11-1121-scriptable-uat-chat.md` per `plan-build`:
   - Phase 1: fixture contract + fixture executable + harness/seed wiring (run-uat.ts regex,
     provisioner.ts chatScript threading, new seed chunk/row **including the gap-3 solo-admin
     call above**, compose line-152 fix, `chat.persistent_runtime.enabled` setting) + unit tests.
   - Phase 2 (kill-gated on Phase 1 Coordinator review): convert the 7 mapped specs + new
     confirmation spec + live-path evidence.
   - Determinism boundary, kill-gate owner (Coordinator), unpiped verification commands — all per
     `plan-build` rules 3/5/6.
3. Message Coordinator (`herdr pane list` fresh-confirm single "Coordinator" label first) with the
   plan pointer. **STOP for approval.**
4. Only after approval: build.

## Reminders

- Never touch `docs/coordination/`, no repo-wide format, explicit `git add` paths only.
- Scope ends at PR + report — never move the board, close the issue, or merge.
