# Plan — issue 2154: module build post-completion silent failure

**Spec:** `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md` (approved), Stage 2
context from issue #1902. **Task issue:** #2154, `Part of #1739`.

## Seams check (file:line citations)

- The bug: the job catch block writes `error.name`, not `error.message`, into the build row.
  `apps/worker/src/module-build-step-runner.ts:88-91` —
  `error: error instanceof Error ? error.name : "unknown error"`. For a plain `new Error(...)`,
  `.name` is always the literal string `"Error"`. This is the "row flips to failed with only
  Error" behaviour from the issue.
- The step right after the AI coding step finishes: `packages/ai/src/module-build/run-build-step.ts:55-58`
  — when `nextBuildStep` returns `null` (`run-build-step.ts:68-71`), it calls
  `deps.finishBuild(build.id, workingDir)`.
- `finishBuild` is implemented in `apps/worker/src/worker.ts:265-296`. It calls
  `installModuleDraft` (`packages/module-registry/src/external/install-draft.ts:38-70`) and, on a
  structured failure, throws `new Error(\`generated module failed validation: ${...}\`)`
(`worker.ts:292-294`) — a real, useful message that today never survives the catch block above.
- `installModuleDraft` calls `statSync(manifestPath)` with no try/catch
  (`install-draft.ts:43-44`). If the build never wrote `jarvis.module.json`, this throws a raw
  `ENOENT` fs error instead of the function's own structured `{ ok: false, errors }` shape that
  every other failure mode in this function uses (e.g. `install-draft.ts:50-51`, `55-56`, `60-61`).
- Retry disagreement: `MODULE_BUILD_QUEUE` has `retryLimit: 3` (`packages/jobs/src/pg-boss.ts:72-77`).
  `createRunModuleBuildStepForJob`'s only early-exit check is for `status === "cancelled"`
  (`module-build-step-runner.ts:51-53`). A build the catch block just marked `"failed"` has no such
  check, so a pg-boss retry re-enters `prepareRunStepDeps`/`runStep` — including relaunching the
  live coding agent — against a build the database already says is finished and failed. That is
  the "worker and database state agree" exit criterion.
- Existing test already locks in the buggy behaviour and must be updated, not left red:
  `tests/unit/worker-module-build-step-runner.test.ts:238-265`, asserts
  `expect.objectContaining({ status: "failed", error: "Error" })` for a thrown
  `new Error("boom")`.
- Test file for `installModuleDraft`: `tests/unit/module-registry-install-draft.test.ts` (existing
  fake-dependency pattern to follow, ~lines 67-112).

## Out of scope

- PR #2101's browser proof (explicitly deferred by the handoff).
- Any change to `packages/module-sdk` shared files (PR #2153 collision — not touched here).
- Any change to `AccessContext`, RLS, or migrations — none needed for this fix.

## Task 1 — preserve the real error message

**File:** `apps/worker/src/module-build-step-runner.ts`

Change the catch block (currently lines 84-94) so the stored `error` string is
`error.message`, not `error.name`:

```ts
error: error instanceof Error ? error.message : "unknown error";
```

**Test change:** `tests/unit/worker-module-build-step-runner.test.ts:238-265` — update the
existing "(regression)" test's assertion from `error: "Error"` to `error: "boom"` (matching the
`throw new Error("boom")` already in that test). Rename the test description to say it preserves
the thrown message, not just that it writes a failed status.

**Why this test proves the fix:** before the change, the assertion `error: "boom"` fails (actual
value is `"Error"`); after the change it passes.

## Task 2 — don't retry a build already marked failed

**File:** `apps/worker/src/module-build-step-runner.ts`

Extend the early-exit check (currently line 51, `if (build.status === "cancelled")`) to also
return early for `build.status === "failed"`:

```ts
if (build.status === "cancelled" || build.status === "failed") {
  return { deferred: false };
}
```

Placed before `prepareRunStepDeps`/`runStep` are called, so a pg-boss retry against an
already-failed build never relaunches the live agent.

**New test** in `tests/unit/worker-module-build-step-runner.test.ts` (same fake pattern as the
existing cancelled-build test): given `getModuleBuild` returns a build with `status: "failed"`,
assert `runStep` and `prepareRunStepDeps` are never called and the job returns
`{ deferred: false }`.

**Why this test proves the fix:** before the change, `runStep` is called (assertion
`expect(runStep).not.toHaveBeenCalled()` fails); after the change it passes.

## Task 3 — installModuleDraft returns an actionable error instead of a raw fs throw

**File:** `packages/module-registry/src/external/install-draft.ts`

Wrap the `statSync(manifestPath)` check (currently lines 43-46) in a try/catch that returns the
function's existing structured failure shape instead of letting the raw fs error propagate:

```ts
let manifestSize: number;
try {
  manifestSize = statSync(manifestPath).size;
} catch {
  return { ok: false, errors: ["the build did not produce jarvis.module.json"] };
}
if (manifestSize > MAX_MANIFEST_BYTES) {
  return { ok: false, errors: ["jarvis.module.json is too large"] };
}
```

No signature change — `InstallModuleDraftResult` is unchanged.

**New test** in `tests/unit/module-registry-install-draft.test.ts` (same fake pattern as the
existing suite): call `installModuleDraft` against a `buildSourceDir` with no
`jarvis.module.json` file, assert
`{ ok: false, errors: ["the build did not produce jarvis.module.json"] }` rather than a thrown
exception.

**Why this test proves the fix:** before the change, the call throws instead of returning
(`await expect(...).rejects` vs `.resolves` — the test asserts `.resolves.toEqual(...)`, which
fails against the current code because it throws); after the change it passes. This is also the
issue's own reported reproduction shape: coding step finishes, `finishBuild` throws, row flips to
`"failed"` a moment later — now with a real reason instead of a raw stack-trace message, or (for
this specific missing-manifest case) a clean structured error instead of an uncaught exception.

## Determinism boundary

No model-authored values reach user data here — this only changes what a thrown JavaScript error's
`.message` populates in an existing plain-text `error` column, and how a fs failure is reported.
No prompts, no chat surfaces touched.

## Verification

```bash
pnpm --filter @moss/worker exec vitest run tests/unit/worker-module-build-step-runner.test.ts > /tmp/2154-step-runner.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, 3 relevant tests passing (updated regression test + new failed-status test +
pre-existing tests unchanged).

```bash
pnpm --filter @moss/module-registry exec vitest run tests/unit/module-registry-install-draft.test.ts > /tmp/2154-install-draft.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, new missing-manifest test passing alongside existing suite.

Full isolated gate via the `verify-gate` skill before wrap-up (never run `pnpm verify:foundation`
directly).

## Kill gate

Phase is a single small slice (three tasks, ~30 lines of production code total). If Task 3's
wrapping turns up other uncaught throws inside `stageModuleDir`/`hashExternalPackage` that need the
same treatment, stop after Task 3 and report the additional scope to the coordinator rather than
silently expanding — call made by the coordinator, not this lane.

## Exit criteria mapping

- "Focused regression check fails before, passes after" → Task 1's updated test + Task 3's new
  test.
- "Draft save/install completes or returns a useful actionable error" → Task 1 (real message
  surfaces) + Task 3 (structured error instead of raw throw).
- "Worker and database state agree after the coding step completes" → Task 2 (no retry re-entry
  against an already-failed build).
