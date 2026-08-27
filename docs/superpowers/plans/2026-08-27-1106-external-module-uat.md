# Plan: #1106 — UAT proof for undeclared external module trust warning + credentials

Spec: issue #1106, comment starting `SPEC` (posted 2026-08-27). Task issue: #1106.
Risk tier: routine.

## Seams check (file:line citations)

- `filterUndeclaredExternalModules` drops any module whose id is already in the registry index —
  `apps/web/src/settings/settings-instance-modules-pane.tsx:24-28`. The test module id must not
  appear in `GET /api/admin/module-registry` results, so a made-up id (`uat-1106-fixture`) is safe.
- Trust warning exact text —
  `apps/web/src/settings/settings-instance-modules-pane.tsx:164-166`.
- Group card wrapper class `pane__card`, title in `.pane__cardtitle` (plain div, not a heading) —
  `packages/settings-ui/src/index.tsx:171-175`. Match module-install.uat.spec.ts's convention of
  scoping to `.pane__card` with `hasText`.
- Row markup: `.set-row` / `.set-row__name` / `.set-row__desc` —
  `packages/settings-ui/src/index.tsx:191-196`. Row `desc` renders as
  `${publisher} · v${version}${reason...}` —
  `apps/web/src/settings/settings-instance-modules-pane.tsx:158`.
- Enable switch accessible name is `Enable ${module.name}`, unchecked when `status !== "enabled"` —
  `apps/web/src/settings/settings-instance-modules-pane.tsx:153-157`.
- Credential input accessible name is the credential's `displayName` (`aria-label`) —
  `apps/web/src/settings/module-credentials-section.tsx:124`. Renders only once
  `query.data` resolves and `credentials.length > 0` —
  `apps/web/src/settings/module-credentials-section.tsx:66-67`.
- Manifest JSON shape (instance-scope auth entry) proven server-accepted —
  `tests/integration/module-credentials.test.ts:45-63`.
- `restartUatStack(projectName, baseURL)` reruns boot module scan —
  `tests/uat/provisioner.ts:680-695` (calls `docker compose restart jarv1s`, waits for
  `/health/ready`).
- `buildUatComposeArgs(projectName, extra)` — `tests/uat/provisioner.ts:403-407`. Used directly
  for the one-off `cp` call; no changes needed to `provisioner.ts`.
- Module folder read at boot: `/data/modules` created and chowned in
  `scripts/start-jarv1s.ts:156-166`; module-reconcile step runs after migrations
  (`scripts/start-jarv1s.ts:134-138`).
- `uatLevel` export convention (no direct `provisionForUat` call in the spec file — the harness
  provisions from this export): `tests/uat/specs/1270-provider-signin.uat.spec.ts:11`,
  `tests/uat/specs/module-install.uat.spec.ts:5`. Valid levels:
  `tests/uat/provisioner.ts:324` (`"bare" | "solo-admin" | "admin+data" | "multi-user"`). Spec's
  "minimal admin-only" = `"solo-admin"`.
- Login + nav steps to copy: `tests/uat/specs/module-install.uat.spec.ts:20-33` (open Settings ->
  Admin/Setup -> Instance modules).
- `JARVIS_UAT_PROJECT_NAME` / `JARVIS_UAT_BASE_URL` env contract —
  `tests/uat/specs/module-install.uat.spec.ts:15-19`.

Open question: none — every premise the SPEC comment names still holds on this branch (verified
step ½ before this plan).

## Determinism boundary

N/A — this is a test-only change with no model-in-the-loop behavior and no new UI code.

## Phase 1 (only phase)

**Task 1 — new UAT spec file**

`tests/uat/specs/1106-external-module-trust-credentials.uat.spec.ts`

- `export const uatLevel = { level: "solo-admin", without: [] } as const;`
- Build a temp dir (`mkdtempSync`) containing `jarvis.module.json`:
  ```json
  {
    "schemaVersion": 1,
    "id": "uat-1106-fixture",
    "name": "UAT Fixture Module",
    "version": "0.1.0",
    "publisher": "UAT Test Publisher",
    "lifecycle": "optional",
    "compatibility": { "jarv1s": ">=0.1.0" },
    "auth": [
      { "id": "uat-1106-fixture.api", "displayName": "Fixture API key", "kind": "api-key", "scope": "instance" }
    ]
  }
  ```
- Copy folder into the container: `docker` + `buildUatComposeArgs(projectName, ["cp", localDir, "jarv1s:/data/modules/uat-1106-fixture"])` via the same `runCommand`-style helper the file imports (mirror how `provisioner.ts` invokes `docker`; use `node:child_process` `execFile`/`spawnSync` directly in the spec — no new export needed from `provisioner.ts`).
- `await restartUatStack(projectName, baseURL)`.
- Sign in as admin (copy `module-install.uat.spec.ts:20-26`), open Instance modules (copy
  `module-install.uat.spec.ts:28-33`).
- Assertions:
  1. `page.locator(".pane__card", { hasText: "External modules" })` visible.
  2. Trust warning text visible (exact string from `settings-instance-modules-pane.tsx:164-166`).
  3. A `.set-row` containing "UAT Fixture Module" visible, with desc text containing
     "UAT Test Publisher" and "v0.1.0".
  4. `getByRole("checkbox", { name: "Enable UAT Fixture Module" })` visible and NOT checked.
  5. `getByLabel("Fixture API key")` (the credential input) visible.
- Stretch (only if time remains, not required for done): toggle the switch on then off, assert
  `toBeChecked()` then not.

**e2e test for this phase:** the new spec itself, run via the project's normal UAT command against
a live docker stack. This IS the live-path proof — there is no separate "smaller" test to run
first since the spec only has meaning against a live stack.

Verification:
```bash
JARVIS_UAT_SEED_LEVEL=solo-admin node_modules/.bin/tsx tests/uat/run-uat.ts tests/uat/specs/1106-external-module-trust-credentials.uat.spec.ts > /tmp/uat-1106.log 2>&1; echo "EXIT=$?"
```
Expected exit code: 0. (Exact invocation confirmed against `tests/uat/run-uat.ts` before running —
adjust only the command-line shape if that file's actual CLI differs, not the assertions above.)

**Kill gate:** if the External modules group does not appear at all after a correct restart, that
is a real product bug (per the SPEC comment's own instruction) — stop, do not work around it in the
test, escalate via `fleetctl set 1106 status=blocked` with the observed behavior. Call: this agent,
since there is no live coordinator in fleet-daemon mode.

## uat-trigger-map.tsv

Add two rows (new spec covers these paths, not previously mapped):
```
blocking	apps/web/src/settings/settings-instance-modules-pane.tsx	tests/uat/specs/1106-external-module-trust-credentials.uat.spec.ts
blocking	apps/web/src/settings/module-credentials-section.tsx	tests/uat/specs/1106-external-module-trust-credentials.uat.spec.ts
```

## Verification (pre-push trio)

```bash
pnpm format:check > /tmp/fmt.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"
```
Expected exit code: 0 for each.
