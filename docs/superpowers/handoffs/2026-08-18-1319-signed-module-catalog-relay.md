# Relay: #1319 Signed Moss Module Catalog

- **Issue:** #1319, risk tier `security`. Approved by Ben 2026-08-17.
- **Branch/worktree:** `build-1319-signed-module-catalog` (this worktree). Clean tree, no commits yet.
- **Coordinator:** Herdr label `Coordinator`, agent name `coordinator-take44`, session id
  `3e71acd4-1b49-4a73-8c0d-9adf1e41c447`. Already notified of this relay (routine, no blocker/fork).
- **Skill to resume under:** `coordinated-build`, step 1 (plan) — step ½ (spec-vs-branch
  verification) is DONE, see below. No code written yet.

## Spec location (handoff doc's claim is stale)

The handoff doc `docs/coordination/handoff-1319-signed-module-catalog.md` (not on this branch —
read via `git show e4edaf89b:<path>`) claims the spec is at
`docs/superpowers/specs/2026-08-17-1319-signed-module-catalog.md`. **That file does not exist
anywhere in git history** (exhaustively checked: `git ls-tree`, `git log --diff-filter=A`, full
`git rev-list --all` sweep). The real, Ben-approved spec is the **GitHub issue #1319 body**.
`gh issue view --json body` returns an opaque `<<ccr:...>>` collapse marker for this body's size —
use `gh api repos/motioneso/moss/issues/1319 --jq .body` instead. Full spec saved at
`/tmp/issue-1319-body.md` (100 lines) — **that tmp file will not survive a session boundary**;
re-fetch with the `gh api` command above if needed, or pull the full text from agentmemory (next
section) which quotes every Implementation/Testing Decision verbatim.

## Durable state already saved

Full spec decisions + independently-verified seam map (file:line citations for every touchpoint)
are saved in agentmemory: `mcp__plugin_agentmemory_agentmemory__memory_recall` or
`memory_smart_search` with query `1319 signed module catalog` (project `jarv1s`, tag `1319`). Read
that memory FIRST — it is the seam map, not just a pointer. Do not re-derive it by re-reading all
those files; only spot-check if something looks stale.

Files independently verified (not just Explore-reported) as of this relay: `registry-source.ts`,
`index-schema.ts`, `publish-module-registry.ts`, `.github/workflows/modules-registry.yml`,
`module-distribution-port.ts`, `routes-module-registry.ts`, `module-registry-rows.ts`,
`routes.ts` (`ModuleDistributionDependencies`/`SettingsRoutesDependencies`), `platform-api-modules.ts`
(`ModuleRegistryRowDto` + JSON schema), `module-reconcile.ts` phases 0-5 (ensure-at-boot, phase 3
lines ~254-305).

**Still NOT independently read** (Explore-reported only — spot-check before relying on for the
plan): `apps/web/src/settings/settings-module-registry-section.tsx` (UI, 333 lines),
`tests/integration/module-distribution.e2e.test.ts` (561 lines — spec says extend this harness,
not build a new one), `packages/module-registry/src/distribution/pipeline.ts`/`extract.ts`/`stage.ts`
internals, `packages/db/src/keyring.ts` (symmetric rotation precedent, shape-only reference).

## Next concrete step

1. Skim the still-unread files above only if the plan needs their exact shape (UI component, e2e
   harness structure) — bounded reads, not full front-to-back.
2. Draft the plan with `plan-build` → `docs/superpowers/plans/2026-08-18-1319-signed-module-catalog.md`.
   Seam knowledge is sufficient to draft now; the memory entry lists the 8 concrete work items
   (Ed25519 keyring module, publish-time sign+self-verify at `publish-module-registry.ts:148-153` +
   new GH Actions secret, fetch-time verify + cache reshape, DTO/schema/derive verification field,
   admin-route 409/override contract, `module-reconcile.ts` phase-3 fail-closed-no-override, UI
   verified/unverified/override-confirm surface, UAT spec + `uat-trigger-map.tsv` row).
3. Message the Coordinator (resolve pane fresh by label `Coordinator` + confirm session id
   `3e71acd4-1b49-4a73-8c0d-9adf1e41c447` via `herdr pane list` — never reuse a cached pane number)
   with the plan path. **STOP and wait for approval before writing any code.**
4. On approval: build task-by-task via `superpowers:test-driven-development`, commit green per
   task (`Co-Authored-By: Claude` trailer, task-scoped `git add`), pre-push trio + rebase before
   every push, `coordinated-wrap-up` at the end (gate on isolated DB per `verify-gate` skill,
   live-path proof since this touches admin UI).

## Reminders for whoever resumes

- No DB migration for #1319 (spec explicitly out-of-scope) — do NOT claim 0185 (reserved for #1586).
- Collision zone with #1586 (not urgent, #1586 hasn't started building): `apps/api/src/server.ts`
  ~L459/L485, `packages/settings/src/routes.ts` ~L994/L1000, `platform-api.ts` barrel.
- Relay trigger is the context-meter 70% warning for everyone — don't invent a personal threshold,
  and don't burn a fresh budget re-reading everything already verified above.
