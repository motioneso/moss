# Relay: #1319 Signed Moss Module Catalog (relay #2)

- **Issue:** #1319, risk tier `security`. Approved by Ben 2026-08-17.
- **Branch/worktree:** `build-1319-signed-module-catalog` (this worktree). Clean tree, no commits yet.
- **Coordinator — STALE, re-resolve before messaging.** This doc previously named session
  `3e71acd4-1b49-4a73-8c0d-9adf1e41c447` (`coordinator-take44`). At last check (`herdr pane list`,
  2026-08-18) **two** panes held the `Coordinator` label: `3e71acd4-...` with `agent_status:"done"`
  (that pane's title showed nothing in-progress) and a newer one, `0af0d87c-2a93-4ced-9b55-56dbdfafd9fe`,
  `agent_status:"working"`, pane title "Boot coordinator take45 brief" — i.e. the coordinator has
  itself relayed to a `take45` successor. **Do NOT message `3e71acd4` — run `herdr pane list` fresh
  and confirm exactly one live pane holds the `Coordinator` label before sending anything** (per
  `coordinated-build`'s red-flag: 0 or >1 matches means halt, don't guess).
- **Skill to resume under:** `coordinated-build`, step 1 (plan). Step ½ (spec-vs-branch
  verification) is DONE. **Zero code written in this lane across both relays.**

## What changed since relay #1

Relay #1 left two files Explore-only (UI component, e2e test structure) and hadn't grepped for
secret-name collisions or existing Ed25519 code. This relay independently read/verified all of
that — **the seam map is now fully closed, no more reads needed before drafting the plan.**

## Durable state — read BOTH memories, in order

1. `mcp__plugin_agentmemory_agentmemory__memory_recall` project `jarv1s`, query
   `1319 signed module catalog` → surfaces `mem_msy75bdj_94916a3aab69` (spec decisions + first
   seam map — the 8 work items list lives here) and `mem_msy7avet_7aa9c3da101b` (this relay's
   additions: exact current shapes/line numbers for every touchpoint, now including the
   previously-unread UI component and e2e harness). Read both in full — together they are
   sufficient to draft the plan with zero further file reads.
2. `memory_smart_search` returned empty for this query last time (indexing quirk) — use
   `memory_recall` instead.

Spec is the GitHub issue body, not a docs/ file:
`gh api repos/motioneso/moss/issues/1319 --jq .body` (tmp copy from relay #1 will be gone by now —
re-fetch if you need the verbatim text; the memories already quote every decision).

## Next concrete step (unchanged from relay #1, now unblocked)

1. Draft the plan with `plan-build` → `docs/superpowers/plans/2026-08-18-1319-signed-module-catalog.md`.
   Both memories give exact file:line insertion points for all 8 items: Ed25519 keyring module (new;
   packages/db/src/keyring.ts is a shape-only rotation precedent, NOT reusable — asymmetric verify
   side only needs a public-key map), publish-time sign+self-verify at
   `publish-module-registry.ts:150-153` (between self-check and writeFileSync) + new GH Actions
   secret in `modules-registry.yml` (also fix the prune-keep-list at line ~56 to retain the new
   `.sig` asset), fetch-time verify in `registry-source.ts` `fetchRegistryIndex()` (line 60) +
   cache reshape in `module-distribution-port.ts`'s `registryCache` (line ~39-50), DTO/schema/derive
   verification field (`platform-api-modules.ts` `ModuleRegistryRowDto`+schema lines 415-497,
   `routes.ts` `ModuleDistributionDependencies.fetchRegistryEntries` lines 156-179), admin-route
   409/override contract in `routes-module-registry.ts` download route (lines 114-166, insert
   between priorStates check line 128 and `dist.download()` line 133), `module-reconcile.ts` phase-3
   fail-closed-no-override (lines 254-305, mirrors existing warn-and-continue pattern at 300-304),
   UI verified/unverified/override-confirm surface in `settings-module-registry-section.tsx`
   (banner parallel to existing `registryUnavailable` banner at line 236-240; override dialog
   chained off the download confirm at line 180-190), UAT spec + `uat-trigger-map.tsv` row, and
   extend `module-distribution.e2e.test.ts`'s mock registry (serves `/index.json` at line 124,
   listens line 178) to also serve/omit/corrupt a signature asset for the new test cases.
2. Message the Coordinator (resolve pane fresh by label `Coordinator` + confirm session id
   `3e71acd4-1b49-4a73-8c0d-9adf1e41c447` via `herdr pane list`) with the plan path.
   **STOP and wait for approval before writing any code.**
3. On approval: build task-by-task via `superpowers:test-driven-development`, commit green per
   task (`Co-Authored-By: Claude` trailer, task-scoped `git add`), pre-push trio + rebase before
   every push, `coordinated-wrap-up` at the end (gate on isolated DB per `verify-gate` skill,
   live-path proof since this touches admin UI).

## Reminders for whoever resumes

- No DB migration for #1319 (spec explicitly out-of-scope) — do NOT claim 0185 (reserved for #1586).
- Collision zone with #1586 (not urgent, #1586 hasn't started building): `apps/api/src/server.ts`
  ~L459/L485, `packages/settings/src/routes.ts` ~L994/L1000, `platform-api.ts` barrel.
- Relay trigger is the context-meter 70% warning for everyone — you have a fresh full budget now.
  Draft the plan and message the coordinator BEFORE doing any more file reads; the seam map is
  closed, re-reading source is not progress.
