# Plan: issue 2173 - UAT provisioning readiness

Spec: `docs/superpowers/specs/2026-09-01-2173-uat-provisioning.md`
Issue: #2173 (task issue; approved plan comment `5497222473`, security ruling `5497191033`)
Risk tier: security

## Locked correction (overrides comment 5497222473's literal commands)

The approved plan comment names a bare `docker logs moss` / `docker inspect ... moss`. The
coordinator's boot brief locks a correction on top of that: **use the run's Compose project and
`jarv1s` service for the bounded lookup, never a global container named `moss`.** This plan follows
the correction, not the literal comment text.

Also locked by the boot brief: no synthetic truncation-only helper/test for deliverable 2. The
proof for the evidence-capture change is the real cached-image repro (RED showing bounded real
cause, then GREEN), not a unit test built around a fabricated log blob.

## Seams cited

- `writeUatEnvFile`, `tests/uat/provisioner.ts:183-291` - four fixed-value encryption-key lines
  already exist (`JARVIS_CONNECTOR_SECRET_KEY`, `JARVIS_AI_SECRET_KEY`,
  `JARVIS_MODULE_CREDENTIAL_SECRET_KEY`, `JARVIS_NEWS_CREDENTIAL_SECRET_KEY` at lines 227-235).
  `JARVIS_INTEGRATIONS_SECRET_KEY` is confirmed absent (grep run against this branch, 2026-09-01).
- `provisionForUat`'s terminal-failure branch, `tests/uat/provisioner.ts:891-916` - the
  `catch (error)` block whose non-retry path is `await cleanupAttempt({ error }); throw error;`
  (lines 914-915). `projectName` is in scope there (bound at line 764, per-attempt).
- `buildUatComposeArgs(projectName, extra)`, `tests/uat/provisioner.ts:410-415` - already the
  mandatory wrapper for every docker compose invocation in this file (project-scoped `-p` + `-f
infra/docker-compose.prod.yml`). Reused for the new evidence-capture calls rather than hand-rolling
  a new invocation shape.
- `runCapture(command, args)`, `tests/uat/provisioner.ts:472-488` - existing private helper that
  spawns and resolves stdout; reused for the new capture, no new dependency.
- `infra/docker-compose.prod.yml:144-145` - confirms the `jarv1s` service name (the
  `container_name: moss` on that line is exactly the out-of-scope global-name problem the spec's
  non-goals section and the boot brief both call out; this plan reads the service by its Compose
  name, never that container name).
- Existing test seam: `tests/unit/uat-provisioner.test.ts:204-230`, the
  `describe("writeUatEnvFile")` -> `"writes an env file pinning..."` test, already asserting the
  sibling `JARVIS_MODULE_CREDENTIAL_SECRET_KEY` / `JARVIS_NEWS_CREDENTIAL_SECRET_KEY` lines. No
  other new test file.

## Task 1 - the missing key

**File:** `tests/uat/provisioner.ts`, inside `writeUatEnvFile`, one new line immediately after the
existing `JARVIS_NEWS_CREDENTIAL_SECRET_KEY` line (236):

```
"JARVIS_INTEGRATIONS_SECRET_KEY=33333333333333333333333333333333",
```

Fixed value only (matches `.github/workflows/ci.yml:340` and `scripts/smoke-compose.ts:229` per the
security ruling). Not read from `process.env`. Not added to `uatComposeInterpolationEnv` (the
compose file never interpolates it - ruling section 2).

**Test:** extend `tests/unit/uat-provisioner.test.ts:205-230` (`writeUatEnvFile` test) with:

```ts
expect(contents).toContain("JARVIS_INTEGRATIONS_SECRET_KEY=");
expect(contents.match(/JARVIS_INTEGRATIONS_SECRET_KEY=(\S+)/)?.[1]?.length).toBeGreaterThanOrEqual(
  32
);
```

**Verify (red, before the line is added):**

```bash
pnpm vitest run tests/unit/uat-provisioner.test.ts > /tmp/2173-task1-red.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=1`, failure is the two new assertions (key absent).

**Verify (green, after):**

```bash
pnpm vitest run tests/unit/uat-provisioner.test.ts > /tmp/2173-task1-green.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

## Task 2 - bounded failure evidence, Compose-scoped

**File:** `tests/uat/provisioner.ts`. New private function beside `runCapture` (~line 488):

```ts
async function captureFailureEvidence(projectName: string): Promise<void> {
  const [logs, statusJson] = await Promise.all([
    runCapture(
      "docker",
      buildUatComposeArgs(projectName, ["logs", "--tail", "50", "jarv1s"])
    ).catch((error) => `<log capture failed: ${String(error)}>`),
    runCapture(
      "docker",
      buildUatComposeArgs(projectName, ["ps", "jarv1s", "--format", "json"])
    ).catch((error) => `<health capture failed: ${String(error)}>`)
  ]);
  console.error(`[uat] ${projectName} jarv1s failed - last 50 log lines and health status:`);
  console.error(logs);
  console.error(statusJson);
}
```

Notes fixing this to the ruling's boundary (section 4):

- `docker compose -p <projectName> -f infra/docker-compose.prod.yml logs --tail 50 jarv1s` -
  Compose project + service scoped, never the bare `moss` container name, never unbounded (`--tail
50` caps it the same way the ruling asked for the literal command).
- `docker compose ... ps jarv1s --format json` returns each container's status fields including
  health - a formatted status read, not `docker inspect` and not a full container inspect. Never
  touches the settings file (`envFile.path`) or prints `process.env`.
- Both `runCapture` calls already inherit `runCapture`'s existing stdout-only capture; neither
  argument list references the env file path or any container env var.

**Wire-in:** `tests/uat/provisioner.ts:891-916`, in the terminal-failure branch, immediately before
the existing `await cleanupAttempt({ error });` at line 914:

```ts
await cleanupAttempt({ error });
```

becomes

```ts
await captureFailureEvidence(projectName);
await cleanupAttempt({ error });
```

No change to the two retry branches (`PortBindConflictError`, `SubnetOverlapConflictError`) - the
spec scopes the capture to the one case that is not a port/subnet retry, matching the approved
plan's task boundary.

**No new unit test for this task** (boot-brief lock: no synthetic truncation-only helper/test).
Proof is the real repro in Task 3.

## Task 3 - prove it against the real crash-loop

Reuse the diagnosis comment's repro shape (`generateUatRunId`, `writeUatEnvFile`,
`uatComposeInterpolationEnv`, `buildUatComposeArgs`, `createUatProvisionPlan`, `bareSeedHook` from
`tests/uat/provisioner.ts`), pointed at the already-cached `ghcr.io/motioneso/moss:uat-smoke` image
so no rebuild is needed, run through `verify-gate` per this repo's DB-touching-test rule.

1. **Before Task 1's line lands** (temporarily revert it locally, do not commit the revert): run
   the repro. Expected RED: `container ... jarv1s ... unhealthy`, and - this is the new part -
   the run's own stderr now shows the bounded `docker compose ... logs --tail 50 jarv1s` block
   containing the real `JARVIS_INTEGRATIONS_SECRET_KEY is required in production` line, plus a
   `ps --format json` health block. This is the evidence-capture proof: it catches the genuine
   pre-fix crash, not a fabricated one.
2. **With both tasks' code in place:** rerun the same repro. Expected GREEN: no `unhealthy` report,
   `docker compose up -d jarv1s --wait` succeeds, stack reaches `/health/ready`.

Record both runs' tails (bounded, last ~50 lines each) as the PR's live-path evidence comment - this
_is_ the live-path proof for this change (a provisioner/test-tooling fix, not a UI surface, so no
Playwright/UAT-spec row is needed per the spec's non-goals).

## Kill gate

If step 1 of Task 3 (pre-fix repro) does NOT reproduce the original `unhealthy` failure on this
branch (e.g. something upstream already changed the crash shape), stop and escalate to the
coordinator before writing Task 1/2's code - the premise would have drifted and the plan needs
re-grounding, not a blind proceed. Call: build agent (this session).

## Out of scope (spec non-goals, restated)

- `infra/docker-compose.prod.yml:145`'s hardcoded `container_name: moss` (concurrency risk,
  hypothesis 3 in the diagnosis comment) - separate issue.
- Any second missing key that might surface after this fix - separate issue, same one-line shape.
- `.env.example`, dev compose, prod compose/example - untouched (ruling section 2; prod already has
  this key per `infra/env.production.example:48`).

## Verification (full gate, before PR)

Per `coordinated-wrap-up` / this repo's `verify-gate` skill - never run `pnpm verify:foundation`
directly or piped. Expected: green, unpiped, exit code captured.
