# Relay — #1528 (1140-F) account-state error text

**Spec:** `docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md` §1140-F
**Plan:** `docs/superpowers/plans/2026-08-17-1528-account-state-error-text.md` (already committed)
**Worktree/branch:** this one, `1528-account-state-error-text` (off `origin/main`)
**Tier:** security — adversarial Opus QA + Ben merge sign-off required before merge.
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list` before messaging, never
a cached pane number. (Prior doc's baked session id `de66eab9-...` was already stale once; always
re-resolve by label.)

## Relay reason

Context-meter 70% warning fired mid-build (right after root-causing the schema-stripping bug
below), immediately followed by a compaction summary appearing in this session's context — both
are hard relay triggers per the `relay` skill. Relaying now per that rule, not because of any
blocker (the blocker was resolved — see ruling below — before this doc was written).

## Coordinator ruling — SCOPE IS NOW WIDENED, already approved, do not re-ask

The coordinator answered the escalation I sent (via `herdr agent prompt` to `coord-take34` /
`Coordinator` label) with an explicit ruling, quoted in full so nothing is lost:

> Ruling on your scope question: widen 1140-F to include the one-line errorResponseSchema fix in
> packages/shared/src/schema-fragments.ts (add 'code' as an optional declared field). Reasoning:
> shipping only the literal-text mapping without this leaves 'code' silently dropped exactly as
> before -- the spec's own acceptance premise of preserving the existing code field would not
> actually hold on the wire. That's worse than not shipping, since it would read as fixed when it
> isn't. It's a 1-line schema widening in the same file family as the bug, low blast radius
> (declares a field that's already being sent, doesn't relax validation elsewhere). Go ahead and
> include it in this lane's scope. Proceed.

**Do not re-escalate this. It is decided.** The owned surface for this lane is now:
`apps/api/src/server.ts`, `tests/integration/auth-settings.test.ts`, and
`packages/shared/src/schema-fragments.ts` (one field addition only — do not touch anything else in
that file or in `packages/shared/src/platform-api.ts`).

## What's done (committed: `8a653363b`)

- Plan doc, fully seams-checked, at the path above. Read it by section — it already has the exact
  literal-branch diff for `server.ts` and the 3 test cases in full.
- 3 new tests added to `tests/integration/auth-settings.test.ts`, inserted in the
  `"multi-user registration + lifecycle (Phase 2 Slice A)"` describe block, after the existing
  `"blocks deactivated user from authenticated endpoint..."` test:
  1. `"blocks pending user from /api/modules with the fixed 403 literal (#1528)"` — line ~588
  2. `"blocks deactivated user from /api/modules with the fixed 403 literal (#1528)"` — line ~626
  3. unknown/no-session case (401, no `code` field) — placed after test 2
- Confirmed RED for the right reason via a real run (log was `/tmp/1528-red3.log`, now stale/gone —
  rerun to see current state): tests 1-2 fail only on the missing `code` field in the JSON body
  (`error` text already matches, since `AccountPendingApprovalError`/`AccountDeactivatedError` in
  `packages/auth/src/index.ts:47-59` already emit the target literals). 24/26 other tests in the
  file pass.

## Root cause of the `code`-stripping (verified, cite these lines)

- `apps/api/src/server.ts:884-903` — the `/api/modules` catch block. **Not yet edited.** Currently
  reads `.message` off the error for the two known codes (line 899) instead of literals — this is
  the primary 1140-F fix, still to do.
- `packages/shared/src/schema-fragments.ts:8-15` — `errorResponseSchema`:
  ```ts
  { type: "object", additionalProperties: false, required: ["error"],
    properties: { error: { type: "string" } } }
  ```
  No `code` property declared → Fastify's fast-json-stringify serializer silently drops `code` from
  every response using this schema, regardless of what the handler `.send()`s. This is the
  newly-in-scope fix: add `code: { type: "string" }` to `properties` (NOT required — the 401 path
  legitimately omits it).
- `packages/shared/src/platform-api.ts:308-321` — `listModulesRouteSchema` uses
  `errorResponseSchema` for both its 401 and 403 responses. Read-only context, do not edit.

## Next concrete steps for the successor (in order)

1. `[ -d node_modules ] || pnpm install` (should already exist — skip).
2. Read the plan doc's "Locked implementation contract" section only (not the whole plan) to
   refresh the exact `server.ts` diff.
3. **TDD GREEN, task 1:** edit `packages/shared/src/schema-fragments.ts:8-15` — add
   `code: { type: "string" }` to `properties` (leave `required` as `["error"]`). Re-run the focused
   tests (command below) — expect the `code` field now survives serialization but the two 403 tests
   may still fail on the wrong status/message if `server.ts` hasn't changed yet (it currently
   forwards `.message`, which already equals the target literal, so this alone may go GREEN — verify,
   don't assume).
4. **TDD GREEN, task 2:** edit `apps/api/src/server.ts`'s `/api/modules` catch block per the plan's
   locked contract — replace the `.message`-reading branch with the two explicit literal branches
   for `account_pending_approval` / `account_deactivated`; leave the unknown-error 401 path
   unchanged.
5. Re-run the focused test file; expect all 26 tests (23 pre-existing + 3 new) green.
6. Run `pnpm build:app-map` once before any vitest run if `dist/app-map.json` doesn't already exist
   in this worktree (it was missing on first boot; may or may not persist — check first).
7. Full isolated-gate-DB verification per `verify-gate` skill before wrap-up (gate DB
   `jarvis_gate_1528` on `jarv1s-postgres` was provisioned earlier in this lane and can likely be
   reused — DROP/CREATE it fresh per the skill's discipline regardless, don't trust its old state).
8. Pre-push trio + rebase, then `coordinated-wrap-up` (PR, live-path assessment — this is a
   backend-only error-text fix with no UI surface, so state explicitly "no live-path proof
   applicable, backend-only" rather than skipping the question).

## Exact commands that work (do not rediscover these)

```bash
# Build artifact needed before ANY vitest run against a fresh worktree:
pnpm build:app-map

# Focused test run -- NEVER use `pnpm --filter @moss/api test`, it's a false green
# (workspace packages declare no test script; exits 0 with ~1 line of log, 0 tests run).
# Always background it -- foreground first-runs against a fresh gate DB exceed the
# Bash tool's default 3-minute timeout even when legitimately still running.
nohup pnpm vitest run tests/integration/auth-settings.test.ts \
  > /tmp/1528-focused.log 2>&1; echo "### FINAL rc=$?" >> /tmp/1528-focused.log &
# then Monitor/poll the log for the "### FINAL rc=" sentinel -- never trust the
# <task-notification> exit code, it's the wrapper's, not vitest's.
```

Isolated gate DB (per `verify-gate` skill, not yet run this lane):
```bash
GATEDB=jarvis_gate_1528
docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS $GATEDB;"
docker exec jarv1s-postgres psql -U postgres -c "CREATE DATABASE $GATEDB;"
export JARVIS_PGDATABASE=$GATEDB
pnpm verify:foundation > /tmp/1528-gate.log 2>&1; echo "### FINAL rc=$?" >> /tmp/1528-gate.log
```

## Out of scope (unchanged from original handoff, still binding)

- `packages/ai/src/terminal-routes.ts`, `packages/settings/src/route-error.ts`,
  `packages/settings/src/routes-serializers.ts` — no shared account-state mapper exists yet; do not
  create one here.
- `/api/me`'s own error path — different file, not owned by this child.
- Anything in `packages/shared/src/platform-api.ts` or `packages/shared/src/schema-fragments.ts`
  beyond the single `code` property addition ruled in above.
- `docs/coordination/` — coordinator-only, never touch.
