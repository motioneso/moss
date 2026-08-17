# Relay 2 — 1139-b-fallback-identity (#1519)

**Worktree/branch:** `.claude/worktrees/1139-b-fallback-identity` / `1139-b-fallback-identity`.
**Coordinator label:** `Coordinator` — re-resolve pane fresh via `herdr pane list`, never cached.

## Done since relay 1

- Pre-push trio green, rebased on origin/main, pushed.
- Own gate GREEN: `VF_EXIT=0`, gate DB `jarvis_gate_1139_b_fallback_identity`, log
  `/tmp/jarv1s-gate/1139_b_fallback_identity-20260816-165844.log` (`### FINAL rc=0`).
- **PR #1650 open** (`Part of #1519`). Body currently has a "Pending" placeholder in the live-path
  section — needs replacing once proof lands.
- Hit and recovered a disk-full/ENOSPC incident mid-gate (shared box, `/dev/sdj1`) via the documented
  procedure in memory `dev-box-disk-full-uat-images.md` (`docker builder prune -f` +
  `docker image prune -f`). Didn't need a new memory — existing one already covers it.
- Coordinator has NOT yet been messaged with PR #1650's link — do that as soon as you pick this up,
  even before finishing live-path proof, so it's not silent.

## RESOLVED (this session, after writing the section below)

Traced the blocking question to ground: `ChatSessionManager` (`packages/chat/src/live/chat-session-manager.ts:165,238,281,289`)
caches ONE live engine per session key and reuses it across turns until kill/idle/`/clear` — so a
second same-thread turn hits the same `ClaudePrintChatEngine`, which flips to `--resume` after its
first `submit()`. Confirms the scripted-chat harness structurally cannot express "same text twice"
(ambiguous on the very first invocation). Also checked the shared dev instance's AI provider config:
`select count(*) from app.ai_provider_configs` on the `jarv1s` dev DB (via
`docker exec jarv1s-postgres psql -U postgres -d jarv1s`) = **0** — no chat-capable provider
configured there either, so a manual live-instance proof is also blocked right now.

**Action taken:** reverted the unused `tests/uat/seed/types.ts` edit. Posted the honest blocked
status as a PR comment (https://github.com/motioneso/moss/pull/1650#issuecomment-5310535276) and
updated the PR body's Live-path section to "NOT MET — code-complete, unverified" (used the
`gh api PATCH` workaround per memory `gh-pr-edit-body-silently-fails.md` — `gh pr edit --body-file`
silently no-ops here). Flagged to coordinator/Ben for a call: either configure a real chat-capable
provider on the shared dev instance for someone to verify by hand, or accept the mocked e2e
regression (`tests/e2e/chat-drawer.spec.ts`, commits `c98a2d997`/`79483461e`) as the evidence for
this child, matching the existing precedent in `tests/uat/specs/1089-1090-chat-drawer-private.uat.spec.ts`.

**PR #1650 is otherwise complete**: gate green, pushed, rebased. Nothing left in this lane's control
— next step is the coordinator/Ben decision above, not further build work.

## Remaining: live-path proof only (superseded by RESOLVED section above — kept for history)

Spec artifact requirement (`docs/superpowers/specs/2026-08-10-1139-chat-export-ui-followups.md`
lines 176-182, Child 1139-B):
> On a real #1000 instance with a configured chat route, send the same text in two turns while the
> browser is network-throttled enough to expose POST fallbacks before SSE reconciliation. Record the
> drawer from both fallback rows through both streamed confirmations. Each logical turn must remain
> visible exactly once; the first SSE arrival must not make its identical sibling flicker away.
> Attach the video or ordered screenshots and run link to this child PR.

### Uncommitted edit — decide before continuing

`tests/uat/seed/types.ts` has one uncommitted change (harmless, additive): added
`"1519-fallback-identity"` to the `UatChatScript` union + `UAT_CHAT_SCRIPTS` array. No fixture JSON
or spec exists yet to use it. Either finish the fixture/spec and commit together, or revert if you
choose the manual-proof fallback below instead.

### Open blocking question (where I stopped)

The UAT chat-script harness (`tests/uat/fixtures/scripted-provider/claude-main.ts`) requires
**exactly one fixture turn** whose `expectIncludes` matches the prompt, globally across the whole
script (`ambiguous-or-zero-eligible-turns` / `eligible-turn-out-of-order` otherwise). The spec needs
the exact same text ("Ping") sent twice in one thread. That's only fixture-expressible as a single
matching turn if **both** sends land at the same `effectiveTurnIndex` (i.e., each HTTP turn gets a
fresh scripted-CLI "new session", not a `--resume`).

I was tracing whether the real (non-scripted) `ClaudePrintChatEngine`
(`packages/chat/src/live/claude-print-chat-engine.ts`) — whose `hasSubmitted` flag flips `--session-id`
to `--resume` after the first submit — is reused across HTTP requests for the same chat thread, or
freshly constructed per request. `grep -n "ClaudePrintChatEngine\|hasSubmitted" packages/chat/src/live-routes.ts`
returned **nothing**, so the engine is wired somewhere else (factory/DI/engine-selection module — see
memory `engine-selection-forks-at-the-rpc-seam.md`). **Not yet resolved.**

Next action: `grep -rln "ClaudePrintChatEngine" packages/ apps/` to find the construction site, then
read enough to answer: does turn 2 of the same thread reuse turn 1's engine/session state?

- If **yes** (resume) → the same-text UAT approach may be genuinely inexpressible with this harness.
  Fall back to the documented pattern in `tests/uat/specs/1089-1090-chat-drawer-private.uat.spec.ts`
  (`test.fixme()` + a clear scope-note citing the harness limitation), and instead produce a **manual
  live dev-instance proof**: stand up dev per `dev-preview-recipe.md`, sign in, open chat, use real
  Chrome DevTools Network throttling by hand, send "Ping" twice fast, screenshot/record, attach
  directly to PR #1650 via `gh pr comment`. This satisfies the Live-Path Gate even without a
  checked-in automated spec — say so explicitly in the PR comment.
- If **no** (fresh session per HTTP turn) → write a single-turn fixture
  `tests/uat/fixtures/chat-scripts/1519-fallback-identity.json` (model on
  `tests/uat/fixtures/chat-scripts/phase1-smoke.json`), then a spec
  `tests/uat/specs/1519-fallback-identity.uat.spec.ts` modeled on
  `tests/uat/specs/1533-chat-surface-live-path.uat.spec.ts` (screenshot helper, `afterEach` log dump)
  + `tests/uat/specs/runtime-context.uat.spec.ts` (`signIn`/`openChat` helpers), with
  `uatLevel = { level: "solo-admin", chatScript: "1519-fallback-identity" }` (solo-admin avoids the
  admin+data news-provider conflict noted in 1533's header). Add CDP throttling:
  `const cdp = await page.context().newCDPSession(page); await cdp.send("Network.emulateNetworkConditions", {...})`
  before sending — `tests/uat/specs/1089-1090-chat-drawer-private.uat.spec.ts`'s header confirms the
  harness has no route-mock transport (real network only), so CDP-level throttling (not route
  interception) is the only lever; not yet validated empirically that it actually widens the race.

Either way: run via `pnpm test:uat` (check `tests/uat/run-uat.ts` for the spec-filter CLI flag),
capture screenshots into `test-results/…`, then:
```
gh pr comment 1650 --body "Live-path proof: <description + screenshots/run link>"
```
replacing the PR body's "Pending" placeholder text too.

## Then: coordinated-wrap-up steps 4-5

Report to coordinator (exact template in the `coordinated-wrap-up` skill, already loaded this
session — re-invoke `Skill({skill: "coordinated-wrap-up"})` if starting fresh) — PR link, `VF_EXIT=0`
gate DB name, live-path status (proof posted, or "NOT MET automated — manual proof posted, reason:
harness turn-matching constraint"), branch/rebase state, deferred: none, teardown: confirm whatever
UAT/dev instance you started is stopped and any seed rows/PIDs are cleaned up explicitly.

If the harness constraint above turns out to be a genuine trap (likely), `memory_save`
(`project: "jarv1s"`, type `bug`) documenting: "UAT scripted-chat-script matcher requires globally
unique `expectIncludes` across the whole fixture — two turns can't share identical prompt text,
which blocks scripting 'send the same message twice' scenarios unless each HTTP turn gets a fresh
CLI session."

## Do NOT

- Touch `docs/coordination/`, the board, milestones, or merge.
- Re-run `pnpm install`, re-read the full spec section (already captured above and in relay 1).
