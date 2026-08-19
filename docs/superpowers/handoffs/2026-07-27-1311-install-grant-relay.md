# Relay: #1311 install-time grant not applied to default-enabled modules

**Worktree/branch:** `/home/ben/Jarv1s/.claude/worktrees/1311-install-grant`, branch `1311-install-grant` off `origin/main`. No PR yet.

**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list` (do not trust a pane number written here; confirm by label + `agent_session.value`).

**Spec source:** `/home/ben/Jarv1s/.claude/worktrees/coord-1262/docs/coordination/handoff-1311-install-grant-default-enabled.md` — read this in full again if you don't have it in context (it's short by design).

**Risk tier:** `security`. Needs Ben's explicit sign-off before merge — do not merge, only PR.

## ⚠️ Skill updates landed mid-run (main `8f1b6d44`) — read before proceeding

A coordinator broadcast landed after this lane started. **Re-read `coordinated-build`,
`coordinated-wrap-up` fresh from disk** (they're re-read live each invocation, so you'll get
the update automatically) — but note the highlights now, because they change your plan/build/gate
steps materially:

1. **Gate isolation is now mandatory and stricter.** Never run `pnpm verify:foundation`
   unscoped — an unscoped run on 2026-07-25 took prod chat down for 90 minutes. Use:
   ```bash
   GATEDB=jarvis_gate_1311installgrant
   docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS $GATEDB;"
   docker exec jarv1s-postgres psql -U postgres -c "CREATE DATABASE $GATEDB;"
   export JARVIS_PGDATABASE=$GATEDB
   ( pnpm verify:foundation > /tmp/cb-vf.log 2>&1; echo "### FINAL verify:foundation rc=$?" >> /tmp/cb-vf.log ) &
   # wait, then:
   grep '### FINAL' /tmp/cb-vf.log
   ```
   Never pipe the gate command (`| tail`, `| grep` on the live run) — pipes swallow the real exit
   code. DROP the gate DB when done. Don't run concurrently with another lane's gate.

2. **Live-path gate is now part of YOUR finish line, not just merge.** This fix touches a
   user-facing surface (assistant tool confirm-card behavior) — CI-green + review is NOT enough.
   Before wrap-up, run `.claude/skills/coordinate/resolve-uat-triggers.sh` to see which UAT specs
   apply (empty output ≠ no proof needed — the trigger map is deliberately incomplete; use
   judgement). Post a live end-to-end proof (real UI on a live dev instance, assertions/evidence) as a
   `gh pr comment` on your PR. Without it, report status as "code-complete, unverified" — never
   "done". This is also exit criterion #3 from the handoff (Playwright run, zero confirm cards).

3. **Plan with `plan-build`, NOT `superpowers:writing-plans`.** The old sub-skill reference in
   `coordinated-build` step 1 is stale — use `plan-build` instead.

4. **Relay only at the context-meter 70% warning.** No personal/earlier threshold.

5. **Report terse and result-first in normal English.** Caveman/telegraph mode is removed from
   this skill family — my one message to the coordinator before this update landed used caveman
   style; that's fine (already sent), but write your future updates in normal terse English, not
   caveman.

## State: root-cause done, zero code written yet

Full investigation complete, already relayed to the coordinator (see message sent to `Coordinator`
label just before this doc, restating the below). Nothing is committed because nothing has been
written — this doc is the only artifact from this session.

### The bug

Only two call sites in the whole codebase write the install-time trust row
(`grantSelfOperationForModule`), both in `packages/settings/src/routes-modules.ts`:
- `PATCH /api/admin/modules/:id` (~line 106-133)
- `PATCH /api/me/modules/:id` (~line 280-312)

Both fire only on an explicit *enable* action. Modules that are `defaultEnabled: true` (news,
sports, tasks, settings — confirmed via their `manifest.ts` `availability` blocks) are already on
at install and never traverse either PATCH handler under normal use. Their `granted_at_install`
tools therefore never get their action-policy row written, so `resolvePolicy` (in
`packages/ai/src/gateway/policy.ts`, invoked once per tool-dispatch at
`packages/ai/src/gateway/gateway.ts:~178`) finds no stored tier and falls back to a confirm card —
exactly the #1311 symptom.

**Correction to the handoff doc:** it says "tasks appears to work" as if tasks were unaffected —
false. `TasksCompatibilityHelper.getResolvedTaskChangesPolicy`
(`packages/tasks/src/action-policy.ts:11-27`) returns `"ask_each_time"` when neither the canonical
nor legacy preference key exists — same underlying bug, just not yet noticed. Don't use tasks as a
"this already works" reference; it needs the same fix.

### Fix design (not yet implemented)

Self-heal the grant lazily, inside `ActionPolicyLookup.getFamilyTier` — the exact runtime
choke-point every tool dispatch passes through regardless of whether an enable/install event ever
fired. Two implementations to touch:

1. **Generic path** — `packages/chat/src/routes.ts`, `buildActionPolicy()` (~line 839+), the
   non-tasks branch of `getFamilyTier`. When `listActionPolicies` finds no stored policy for
   `(moduleId, familyId)`: resolve the module's manifest via `args.resolveActiveModules(ctx.actorUserId)`,
   check whether any `assistantTools` entry has `selfOperationGrant === "granted_at_install" &&
   actionFamilyId === familyId`; if so, call `grantSelfOperationForModule(scopedDb, args.repository,
   manifest)` (already exported from `@jarv1s/ai`, already an unused-but-available import path —
   `packages/chat/package.json` already depends on `@jarv1s/ai` workspace) then re-read
   `listActionPolicies` for the authoritative tier.

2. **Tasks path** — `packages/tasks/src/action-policy.ts`,
   `TasksCompatibilityHelper.getResolvedTaskChangesPolicy` (line 11-27). When neither `canonical`
   nor `legacy` preference exists (line 18), call `this.grantInstallTimeTrustIfUnset(db)` and
   return `"trusted_auto"` directly instead of `"ask_each_time"`.

`grantInstallTimeTrustIfUnset` (tasks) must be **kept**, not replaced by the generic primitive —
it uniquely checks/preserves the legacy `tasks.agency_auto_execute` boolean key that predates
#1263, which the generic `insertActionPolicyIfAbsent` doesn't know about.

### Why this can't regress exit criterion #4 (confirm_always must still prompt)

Two structural guarantees already enforced at manifest-build-time (see
`packages/ai/src/gateway/self-operation.ts` validation, ~lines 300-430):
- A family can never be referenced by both a `granted_at_install` tool and a `user_promotable`
  tool (build throws).
- A `confirm_always` tool can never declare `executionPolicy: "auto"` (build throws).

So even if a `confirm_always` tool's family somehow had a `trusted_auto` tier stored,
`resolvePolicy`'s `tool.executionPolicy === "auto"` check (in `packages/ai/src/gateway/policy.ts`)
always fails for it — the self-heal only ever fires for `granted_at_install` tools by construction,
and those two are mutually exclusive with `confirm_always`/`user_promotable` families.

### Open item not yet resolved

`docs/superpowers/specs/2026-07-26-module-self-operation-content-commands.md` and
`...-settings-commands.md` exist in the specs dir and were listed but never opened. Unclear
whether either is a formal spec this task should also satisfy, beyond the handoff doc itself. Check
by section if either seems relevant once you're in `plan-build` — don't full-read.

Also open: whether to add self-heal to `GET /api/ai/action-policy` (the Settings → Permissions
display route, `packages/ai/src/action-policy-routes.ts`) — currently decided **against**, to keep
the fix minimal and focused on the runtime dispatch gate (the actual choke point that produces
confirm cards). Flag this as a scope decision if the coordinator or Ben wants the display route to
self-heal too; not required for the #1311 symptom itself.

## No existing test coverage

Confirmed via grep — zero existing unit tests reference `buildActionPolicy`/`getFamilyTier`
(chat), `grantSelfOperationForModule` (ai), or `grantInstallTimeTrustIfUnset`/
`getResolvedTaskChangesPolicy` (tasks). All new tests need to be authored from scratch as part of
the plan.

## Next concrete steps for successor

1. `[ -d node_modules ] || pnpm install` (should already exist — skip actual install).
2. Run the agentmemory required recalls for this work (state; RLS not directly relevant here but
   check anyway per CLAUDE.md table).
3. Re-verify the spec/handoff premises against current branch state (per `coordinated-build` §½)
   — should still hold, nothing merged into `main` should have touched this since the handoff was
   written, but confirm.
4. Write the TDD plan with **`plan-build`** (not `writing-plans` — see skill update above) to
   `docs/superpowers/plans/2026-07-27-1311-install-grant-default-enabled.md` or similar, covering:
   - Tests: `granted_at_install` tool on a `defaultEnabled` module (news or sports) dispatches
     without a confirm card, no prior explicit enable.
   - Tests: `confirm_always` tools still prompt (regression guard for criterion #4).
   - Unit tests for both `getFamilyTier` self-heal paths (generic + tasks).
   - The two code edits described above.
   - A live-path UAT plan item (see skill-update §2) — resolve which spec via
     `resolve-uat-triggers.sh`, plan to post proof as `gh pr comment`.
   - PR-description note justifying why `grantInstallTimeTrustIfUnset` stays (exit criterion #2).
5. Message `Coordinator` (fresh-resolved label): plan ready, path, request approval. **Stop and
   wait** — do not write code before approval.
6. After approval: TDD build, commit per task, `git add` only explicit task files.
7. Pre-push trio + rebase, then gate run using the **isolated gate DB** procedure above (not the
   old ad-hoc `JARVIS_PGDATABASE=x pnpm ...` inline form — it doesn't survive backgrounding).
8. `coordinated-wrap-up`: push, open PR, post live-path UAT proof as PR comment, report to
   coordinator. Flag security tier / Ben sign-off requirement explicitly in the report.
