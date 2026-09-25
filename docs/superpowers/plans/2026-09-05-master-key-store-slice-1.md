# Plan: master key store, slice 1 (integrations family)

Spec: `docs/superpowers/specs/2026-09-05-master-key-store-design.md`. Task: #2312.
Status: plan drafted, NOT approved. Needs coordinator approval before code (lane has
no handshake path yet — see Collision notes).

## Seams (all cited from the current tree)

- Secret registry + generic-route guard: `packages/settings/src/instance-settings-keys.ts:3-42`
  (`secret: true` entries rejected from generic upsert with 400).
- Envelope precedent: `packages/settings/src/web-search-key.ts:108-124` (encrypt + upsert),
  `:67-77` (read/decrypt, null when unset), `:94-106` (presence-only status).
- Keyring retired-key path: `packages/db/src/keyring.ts:66-94`.
- Cache-invalidate precedent: `invalidateWebSearchProviderCache` in
  `packages/web-research/src/providers.ts`.
- Boot construction to remove: `apps/api/src/server.ts:448`
  (`createIntegrationsCipher(process.env)` at startup).
- Routes to harden: `packages/integrations/src/routes.ts:46`
  (`dependencies.cipher ?? createIntegrationsCipher()` — sync env read per router build).
- Settings repository upsert: `packages/settings/src/repository.ts:364`.
- UAT map: `.claude/skills/coordinate/uat-trigger-map.tsv` (row to add, step 4).

## Tasks

1. Registry: add `keys.integrations` with `secret: true` to
   `INSTANCE_SETTINGS_REGISTRY`. Test: generic PATCH of that key returns 400.
2. Store functions in settings package (new file `master-key-store.ts`):
   `loadIntegrationsKeyring(scopedDb)`, `generateFamilyKey`, `rotateFamilyKey`,
   `getFamilyKeyStatus`. Order env > store > missing; in-memory cache + invalidate.
   Tests: round-trip; env wins; missing never throws; rotation keeps retired-id
   envelopes readable; status JSON contains no key material.
3. Lazy integrations cipher: replace server.ts:448 eager build with first-use load;
   routes.ts:46 falls back to loader. Missing key at request time yields the
   setup-guidance error naming the keys screen. Test: boot with env lacking the key
   is green; tool-call time surfaces guidance, not a throw.
4. Banner + keys screen state: status endpoint (presence only) and Settings home
   banner slot when any family missing. UI asserts through the wiring (a real caller
   passes the status, not just the component). UAT spec
   `tests/uat/specs/2312-master-key-store.uat.spec.ts` + trigger-map row.
5. Docs: backup warning + README/docs admin-generate flow (spec section 3.5, Ben
   2026-09-05). App-map entries: core settings screen + banner, integrations
   "needs attention" error + remediation (same PR).

## Verification (unpiped, expected exit 0)

```bash
npx vitest run tests/unit/settings-master-key-store.test.ts > /tmp/mks1.log 2>&1; echo "EXIT=$?"
npx eslint packages/settings/src/master-key-store.ts packages/integrations/src/routes.ts --max-warnings=0 > /tmp/mkslint.log 2>&1; echo "EXIT=$?"
```

Full gate per `verify-gate` skill before PR (DB-touching steps need the skill, not
improvised). Pre-push trio + fresh rebase before every push. Note: no Actions
outage — coordinator 2026-09-05 corrected checkpoint 66: skipped checks mean the
branch conflicts with main, a rebase brings them back. Plan on real CI checks;
also note a conflicting branch silently gets zero checks, so rebase early.

## Kill gate

Upgrade simulation (env without the key): boot green + banner state + degraded
integrations tools, all observed. If lazy loading forces a bigger boot refactor than
server.ts:448 + routes.ts:46, stop and re-scope with the coordinator instead of
widening. Owner: coordinator on plan approval.

## Collision notes (for coordinator)

- `apps/api/src/server.ts` is shared and hot — needs a worktree/branch assignment,
  not shared-checkout edits.
- `packages/settings/src/*` registry + routes overlap the settings surface other
  lanes touch; serialize.
- No migration number needed (key-value rows, no DDL).
- Open question: worker-side integrations cipher users (registerWorkers path) —
  verify during build whether any eager construction exists there too.

## Out of scope (slice 1)

Module-credential + news families (slice 2), setup-prod changes (slice 2),
no-new-env contributor check (slice 3).
