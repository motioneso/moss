# Host, Account, Diagnostics, and Operator Truth Implementation Plan (#993)

> **Build gate:** Execute only after
> `docs/superpowers/specs/2026-07-13-993-host-account-truth-security-design.md` is approved.
> This plan adds no host-mutation endpoint and stages only task-owned paths.

**Goal:** Make host/runtime, diagnostics, log-level, email ownership, and profile hierarchy truthful
without adding privileged web operations or an insecure email-change flow.

**Grounded on:** rebased planning head `b1529307` (preflight current with
`origin/main@e0553ed5` on 2026-07-14).

## Ownership and Exclusions

Owned product paths are exactly:

- `packages/ai/src/adapters/multiplexer-resolve.ts`
- `packages/module-registry/src/chat-multiplexer.ts`
- `packages/auth/src/index.ts`
- `packages/shared/src/platform-api.ts`
- `packages/settings/src/routes.ts`
- `apps/api/src/server.ts`
- `infra/docker-compose.prod.yml`
- `apps/web/src/settings/settings-admin-panes.tsx`
- `apps/web/src/settings/settings-personal-panes.tsx`
- `apps/web/src/styles/settings-panes.css`

Focused test paths are:

- `tests/unit/ai-multiplexer-resolve.test.ts`
- `tests/unit/chat-multiplexer-status.test.ts`
- `tests/unit/chat-multiplexer-usable.test.ts`
- `tests/integration/chat-multiplexer-admin.test.ts`
- `tests/integration/host-diagnostics-admin.test.ts`
- `tests/integration/auth-settings.test.ts`
- `tests/unit/settings-admin-panes.test.tsx`
- `tests/unit/settings-personal-panes.test.tsx`

Do not touch `tests/uat/**`, `docs/coordination/**`,
`apps/web/src/settings/settings-personal-data-panes.tsx`, or
`apps/web/src/settings/settings-module-registry-section.tsx`.

#993 and #995 both own `apps/web/src/styles/settings-panes.css`. Sequence those builds/merges; the
second lane must rebase, re-read the merged stylesheet before editing, preserve the first lane's
changes, and re-run the stylesheet file-size and design-token gates.

## Task 1: Unify Herdr readiness at the root cause

**Files:**

- Modify `packages/ai/src/adapters/multiplexer-resolve.ts`
- Modify `packages/module-registry/src/chat-multiplexer.ts`
- Modify the three multiplexer unit tests listed above

- [ ] Add a small exported `hasHerdrRootConfiguration(env)` predicate recognizing
      `JARVIS_HERDR_ROOT_TAB`, `JARVIS_HERDR_ROOT_PANE`, and `HERDR_PANE_ID`.
- [ ] Use it in `decideMultiplexer` and both status/usable probes; delete the duplicated two-variable
      checks.
- [ ] First add failing cases for root-tab-only, installed-without-root, and tmux env pin; then make
      them pass.
- [ ] Run `pnpm vitest run tests/unit/ai-multiplexer-resolve.test.ts tests/unit/chat-multiplexer-status.test.ts tests/unit/chat-multiplexer-usable.test.ts`.
- [ ] Commit only these paths with a release-note body: operators now see the same Herdr readiness
      that the runtime uses.

## Task 2: Make production setup and recreation instructions executable

**Files:**

- Modify `infra/docker-compose.prod.yml`
- Modify `apps/api/src/server.ts`
- Modify `tests/integration/host-diagnostics-admin.test.ts`
- Modify `tests/integration/chat-multiplexer-admin.test.ts`

- [ ] Make `JARVIS_MULTIPLEXER` env-overridable with tmux as the default and pass through
      `JARVIS_HERDR_ROOT_TAB` with an empty default.
- [ ] Replace the bare restart hint with the exact shipped base-stack recreation command:
      `docker compose -p jarv1s-prod -f docker-compose.prod.yml --env-file ./env.production.local up -d jarv1s`.
      `restart` is forbidden here because it does not reload changed container env; notes-enabled
      deployments must retain `-f docker-compose.notes.yml` as an additional selector.
- [ ] Give the install command the same `-p`/`-f`/`--env-file` selectors. Assert diagnostics returns
      only these fixed commands and no environment values; leave unknown modes without a command.
- [ ] Render Compose config once with defaults and once with Herdr/root-tab env values; assert the
      effective values rather than grepping YAML.
- [ ] Run the two integration tests plus the Compose render checks.
- [ ] Commit these four paths only.

## Task 3: Put a health answer before technical diagnostics

**Files:**

- Modify `apps/web/src/settings/settings-admin-panes.tsx`
- Modify `tests/unit/settings-admin-panes.test.tsx`

- [ ] Add a pure local summary mapper over existing diagnostic checks: fail wins over warn, warn wins
      over pass; fixed next actions are keyed by `database`, `pgboss`, and `multiplexer` ids.
- [ ] Render the summary and next actions first; place runtime metadata in native `<details>`.
- [ ] Replace the ambiguous Herdr rows with Installed, Ready, Active, Selected, and deployment-pinned
      labels, plus exact Compose setup/recreation copy.
- [ ] Remove the dedicated Log level row. Do not add a replacement control.
- [ ] Cover failure ordering, installed-not-ready, ready-not-active, env-pinned tmux, corrected command,
      disclosure behavior, and log-row absence.
- [ ] Run `pnpm vitest run tests/unit/settings-admin-panes.test.tsx` and
      `pnpm --filter @jarv1s/web typecheck`.
- [ ] Commit the two paths only.

## Task 4: Expose only safe identity ownership metadata

**Files:**

- Modify `packages/auth/src/index.ts`
- Modify `packages/shared/src/platform-api.ts`
- Modify `packages/settings/src/routes.ts`
- Modify `apps/api/src/server.ts`
- Modify `tests/integration/auth-settings.test.ts`

- [ ] Add an auth-runtime method that selects only `provider_id` values for the authenticated user;
      never select the account id, password, access token, refresh token, or ID token.
- [ ] Extend `MeResponse` with a bounded identity-owner shape (`jarv1s`, `external`, `mixed`, or
      `unknown`) and a provider-name allowlist. Unknown ids remain `unknown`, not echoed raw.
- [ ] Resolve it only after `/api/me` authenticates the actor; no arbitrary user-id route.
- [ ] Add cross-user and secret-substring assertions before implementation, then make them pass.
- [ ] Run `JARVIS_PGDATABASE=jarv1s_993_identity pnpm vitest run tests/integration/auth-settings.test.ts`.
- [ ] Commit these paths only.

## Task 5: Make email singular and profile hierarchy authored

**Files:**

- Modify `apps/web/src/settings/settings-personal-panes.tsx`
- Modify `apps/web/src/styles/settings-panes.css`
- Modify `tests/unit/settings-personal-panes.test.tsx`

- [ ] Remove email from the profile header; keep the Account row as its single surface.
- [ ] Render credential, external, mixed, and unknown ownership copy from the bounded DTO. Add no
      email mutation affordance.
- [ ] Give `.prof` the existing tokenized warm-card treatment; introduce no raw colors or new UI
      primitive.
- [ ] Assert one visible email occurrence, truthful owner copy, no edit/change action, and preserved
      profile autosave.
- [ ] Run the unit test, web typecheck, and `pnpm check:design-tokens`.
- [ ] Commit the three paths only.

## Task 6: Adversarial security QA and live-path proof

- [ ] Run `pnpm audit:preflight` and record the final SHA.
- [ ] Attempt #993 routes as unauthenticated, member, admin, and another user. Diagnostics must remain
      admin-only; identity metadata must remain self-only.
- [ ] Scan diagnostics and `/api/me` bodies for password/token/secret/connection-URL markers.
- [ ] Confirm no new POST/PUT/PATCH/DELETE host route or shell execution was introduced.
- [ ] Run focused tests, `pnpm check:design-tokens`, and `pnpm verify:foundation`.
- [ ] From the deployed Compose UI, navigate normally to Settings → Advanced host setup, verify all
      five mux states and diagnostic recovery, change the env file, run the exact selector-complete
      `up -d jarv1s` recreation command, refresh, then
      navigate to Account & preferences and verify one correctly owned email. Record DOM assertions and
      commands outside `tests/uat/**`.

## Completion Check

- [ ] Diff contains only approved owned product/test paths.
- [ ] #1042 registry lane and #995/#987 shared settings lane are untouched.
- [ ] No product claim depends on an unverified host mutation or email-change capability.
