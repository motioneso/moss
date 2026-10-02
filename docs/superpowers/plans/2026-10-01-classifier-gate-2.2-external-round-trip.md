# Classifier gate 2.2: external-module round trip — lane plan

Lane: `cg-2-2-external`. Issue: #2882. Branch: `cg-2-2-external` (from `origin/main`).
Parent plan: `docs/superpowers/plans/2026-10-01-classifier-gate-for-chat.md`, section 2.2.
Spec: `docs/superpowers/specs/2026-10-01-classifier-gate-for-chat.md` §3.4-3.5.

Goal: carry a validated classifier opt-in from an installable module's `jarvis.module.json`
through discovery into the runtime manifest, with the candidate hook expressed as a worker
handler that runs through the existing sandbox/RPC mechanism. No direct database access, no
new execution surface.

## Step 1: prove the sandbox runtime hook (brief gate)

The brief requires: prove and cite the existing sandbox runtime hook; if it cannot support a
bounded read-only candidate hook, stop and report. **Result: CONFIRMED.** Evidence:

Host calls into the sandbox by handler name:

- `packages/module-registry/src/external/worker-runtime.ts:121` —
  `ExternalModuleWorkerRuntime.invoke(module, handler, input, rpc, options)`.
- `worker-runtime.ts:265` spawns one child per `(module, lane)` via
  `spawn(process.execPath, [join(module.dir, entrypoint)], { cwd: module.dir, env, stdio })`,
  with a scrubbed env built at `:261` (only `LANG`/`LC_ALL`/`TZ`).
- `worker-runtime.ts:222` sends `method: "module.invoke"` with
  `params: { handler, input, deadlineAt, preferences?, localTimezone? }`.

Bounded:

- `worker-runtime.ts:40-42` `resolveHardTimeout` (default 120_000 ms, ceiling
  `MAX_INVOCATION_MS` = 600_000 at `packages/module-sdk/src/external-module.ts:93`).
- Per-call override `options.timeoutMs` (`worker-runtime.ts:128`, applied at `:174-176`).
- Stall timer (`:173`, re-armed at `:193-200`) and hard timer (`:202-205`).

Cancellable:

- `worker-runtime.ts:180-185` `kill()` aborts the invocation's `AbortController` and kills the
  child; the signal is forwarded into host-held work (pinned fetch `:275-284`,
  `ai.generateStructured` `:367-374`).

Read-only and actor-scoped:

- `packages/module-registry/src/external/worker-rpc-host.ts:150`
  `createExternalModuleRpcHandler({ toolRisk, actorUserId, requestId, ... })`.
- With `toolRisk: "read"` the host refuses `notify.post` (`:227`), `ai.generateStructured`
  (`:367`), `auth.setCredential` (`:447`) and `kv.set`/`kv.delete` (`:498`), and runs
  `db.query` with `readOnly: true` (`:336-340`).
- Every DB branch runs under
  `workerDataContext.withDataContext({ actorUserId, requestId }, ...)` (`:318`).

Already used in production for tools:

- `apps/api/src/external-module-tools.ts:59-140` builds the RPC handler with
  `toolRisk: tool.risk` and calls `runtime.invoke(module, tool.handler, ...)`, spreading
  `actorUserId` into the handler input last (`:121-125`).

Conclusion: a candidate hook declared as a handler name can be invoked with `toolRisk: "read"`,
actor-scoped input, a bounded `timeoutMs`, and the caller's abort signal plumbed to `kill()`.
This is the existing mechanism; no direct DB access is needed.

## Seams check (current branch)

| Assumed capability                                     | Evidence                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK classifier contract is merged (2.1)                | `packages/module-sdk/src/classifier.ts:16` `CLASSIFIER_LIMITS`; `:50-54` `ClassifierCandidateProvider` (function form); `:56-72` `ModuleAssistantToolClassifier`; `packages/module-sdk/src/index.ts:652-653` `classifier?` on the tool manifest.      |
| Consumers of the contract                              | `packages/chat/src/live/classifier-gate-arguments.ts:82` `checkClassifierEligibility`; `:129-135` `candidateOptions`; `packages/chat/src/live/classifier-gate.ts:122` `loadCandidates(tool, signal)` and `:474` `guard(loadCandidates(...), signal)`. |
| External declaration exists, without classifier        | `packages/module-sdk/src/external-module.ts:179-193` `ExternalModuleAssistantToolDeclaration`.                                                                                                                                                        |
| External validation exists, without classifier         | `packages/module-registry/src/external/validate.ts:634-690`; unknown-key + bounds pattern at `:793-844` (briefing) is the template.                                                                                                                   |
| External manifest synthesis exists, without classifier | `packages/module-registry/src/external/tool-manifests.ts:30-77`; field-by-field copy at `:61-75` (the `safeErrors` precedent for not spreading).                                                                                                      |
| Runtime dispatch boundary exists                       | `apps/api/src/external-module-tools.ts:59-146`.                                                                                                                                                                                                       |
| The gate already tolerates a load failure              | `classifier-gate.ts:474-480` maps a throw to `candidates_unavailable` and any abort to cancelled/timeout.                                                                                                                                             |
| No user-facing surface in this slice                   | No classifier eligibility entry in `packages/shared/src/app-map-core.ts`; 2.1 changed no app-map declaration.                                                                                                                                         |

## Design decisions

1. **External classifier declaration reuses the SDK argument kinds.** New type in
   `packages/module-sdk/src/external-module.ts`:

   ```ts
   export interface ExternalModuleClassifierDeclaration {
     readonly description: string;
     readonly arguments?: Readonly<Record<string, ClassifierArgumentDecl>>;
     /** Names a worker handler. Required when any argument is `candidates`. */
     readonly candidatesHandler?: string;
     readonly replyTemplate: string;
   }
   ```

   `ExternalModuleAssistantToolDeclaration` gains `readonly classifier?:` of that type. A JSON
   manifest cannot carry the SDK's function-valued `candidates`, so the handler name is the
   portable form; rejection of a candidates argument without a handler keeps absent = off.

2. **Synthesis is a field-by-field copy, not a spread.** `createExternalToolManifests` builds
   `classifier` only from the four known fields, and only attaches `candidates` when an invoker
   was supplied. This mirrors the `safeErrors` decision at `tool-manifests.ts:54-60`.

3. **Validation reuses `checkClassifierEligibility` instead of a second copy of the rules.**
   `validateExternalModuleManifest` checks the external-only structure (unknown keys, handler
   name shape, candidates symmetry) and then calls the SDK gate with a stub provider standing in
   for the handler. One source of truth for description/template/argument rules.

4. **The candidate invoker is a new optional third argument** to
   `createExternalToolManifests(discoveries, invoke, invokeCandidates?)`. Absent invoker means a
   candidates argument makes the tool ineligible (safe default), matching absent = off.

5. **The runtime gains an optional caller signal.** `ExternalModuleWorkerRuntime.invoke` options
   gain `readonly signal?: AbortSignal`, which kills the invocation with a new `aborted` error
   code. The classifier gate passes the turn's signal into `loadCandidates`; without this, a
   cancelled turn would leave the sandbox child running to its hard ceiling. This is plumbing an
   existing guarantee, not a new execution surface.

6. **The candidate hook gets its own bounded ceiling.** `invokeCandidates` sets a small
   `timeoutMs` (constant, exported for tests) so a broken hook cannot hold the 3,000 ms gate; the
   caller signal is the tighter bound when present.

7. **Rejected option — a direct handler reference resolved host-side by importing module code.**
   It would avoid the subprocess spawn, but it executes module code in the host process and
   bypasses the read-only RPC gate — exactly the "direct database access" the brief forbids.
   Rejected. Rejected option — reusing the `tool` lane for candidates: it serializes with real
   tool calls on one child; a stalled candidate could delay a later tool call. A dedicated lane
   is not needed because candidates always run before dispatch, and the timeout kills the child;
   keep the `tool` lane.

## Determinism boundary

No model-authored text, and no new model job, in this slice. The declaration is data plus a
string template with `{field}` placeholders; the reply renders from the tool result by code
(`classifier-gate-arguments.ts:229`). Candidate values are worker output validated by
`normalizeClassifierCandidates` before they reach the menu (`classifier-gate.ts:477`). No module
injects a chat turn. Guidance is one line, bounded at 200 characters.

## Tasks

### Task 1 — declaration type and external validation

Files: `packages/module-sdk/src/external-module.ts`,
`packages/module-registry/src/external/validate.ts`,
`packages/module-registry/src/external/validate-classifier.ts` (new, keeps `validate.ts` under
the 1000-line cap), `tests/unit/external-module-tool-manifest-policy.test.ts`.

Decisions:

- `validateClassifierDeclaration(tool, errors)` rejects unknown classifier keys; requires a
  non-empty single-line `description` and `replyTemplate`; bounds both to
  `CLASSIFIER_LIMITS`; validates `candidatesHandler` against the briefing handler shape
  (`/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/`, max 64); requires a `candidatesHandler`
  when any declared argument is `candidates`, and rejects a `candidatesHandler` with no such
  argument; then calls `checkClassifierEligibility` with a stub provider.
- Call it from the `assistantTools` loop in `validate.ts` (after `lintAssistantToolInputSchema`)
  and re-emit `classifier` through the existing wholesale `assistantTools` copy at `:867-869`.

Tests (why each fails against a broken implementation):

- a valid enum-only classifier passes validation and `checkClassifierEligibility` is eligible.
- a candidates argument with no handler fails; a handler with no candidates argument fails;
  an unknown classifier key fails; a template placeholder not in `outputSchema` fails; an
  over-200-character description fails.

### Task 2 — synthesis and runtime dispatch

Files: `packages/module-registry/src/external/tool-manifests.ts`,
`apps/api/src/external-module-tools.ts`, `packages/module-registry/src/external/worker-runtime.ts`.

Decisions:

- `ExternalCandidateInvoker`:
  ```ts
  export type ExternalCandidateInvoker = (
    module: ExternalModuleDiscovery,
    handler: string,
    access: { readonly actorUserId: string; readonly requestId: string },
    signal: AbortSignal
  ) => Promise<unknown>;
  ```
- `createExternalToolManifests(discoveries, invoke, invokeCandidates?)` synthesizes
  `classifier.candidates = (scopedDb, ctx, { signal }) => invokeCandidates(module, handler,
{ actorUserId: ctx.actorUserId, requestId: ctx.requestId }, signal)`.
- `worker-runtime.ts`: add `signal?` to invoke options; on abort, `kill(new
ExternalModuleWorkerError("aborted"))`; clear the listener in `finally`. Extend the error code
  union with `"aborted"`.
- `external-module-tools.ts`: extract the shared RPC input into a local helper so the candidate
  invoker reuses the same construction with `toolRisk: "read"`; pass the candidate invoker as
  the third argument to `getManifests`.

Tests:

- synthesized provider forwards the acting actor IDs and signal to the invoker; no invoker means
  no `candidates` function and the tool is ineligible for a candidates argument.
- `ExternalModuleWorkerRuntime` rejects with `aborted` for an already-aborted signal, and aborts
  a mid-flight invocation without waiting for the hard ceiling.

### Task 3 — installed fixture round trip (the phase e2e)

File: `tests/unit/external-module-classifier-round-trip.test.ts` (new).

A temp-dir fixture worker (same pattern as `tests/unit/external-worker-runtime.test.ts:12-88`)
exposes `demo.candidates`, plus a `hang` handler and a throwing handler. The fixture manifest is
run through the real `validateExternalModuleManifest`, then `createExternalToolManifests` with a
real `ExternalModuleWorkerRuntime` and a candidate invoker built from
`createExternalModuleRpcHandler({ toolRisk: "read", ... })`. The test drives
discovery → validate → manifests → `checkClassifierEligibility` / `candidateOptions` and asserts:

1. valid opt-in survives loading and is eligible; `candidateOptions` lists the values.
2. no opt-in stays off (`eligible: false`, no menu entry).
3. two actor IDs receive their own candidate value (the fixture echoes `input.actorUserId`).
4. a mutation attempted by the hook (`kv.set`) is refused by the read-only RPC and does not
   change the returned list.
5. a hook that throws declines (provider rejects) and the tool's own `invoke` is never called
   (spy count 0) — no tool write.
6. a hook that hangs rejects within the bounded timeout, so a stalled dependency cannot strand
   the gate.

Exit: this fixture test passes with a real spawned worker; assertions 3-6 each fail if the
corresponding guard is removed (actor id not forwarded, `toolRisk` set to `"write"`, no try/
catch, no timeout).

### Task 4 — documentation

File: `docs/module-developer-guide.md` (§13.1 table row + a short subsection beside §11.1).
State: installable modules declare `assistantTools[].classifier` with a `candidatesHandler`
instead of a function; the hook runs read-only, actor-scoped and bounded through
`worker-runtime.ts`; the same 200-character/50-candidate bounds apply.

App map: no change. This slice adds a developer manifest field and validation, not a screen,
setting, navigation path or user-visible behavior; 2.1 set the same precedent for the SDK
opt-in. Record that decision in the PR body.

## Verification

Unit files (no database), unpiped:

```bash
pnpm test:unit tests/unit/external-module-tool-manifest-policy.test.ts tests/unit/external-module-classifier-round-trip.test.ts tests/unit/external-worker-runtime.test.ts tests/unit/external-validate.test.ts > /tmp/cg22-unit.log 2>&1; echo "EXIT=$?"
```

Expected `EXIT=0`.

```bash
pnpm typecheck > /tmp/cg22-typecheck.log 2>&1; echo "EXIT=$?"
```

Expected `EXIT=0`.

Full gate at wrap-up, only through `scripts/run-gate.sh` per the verify-gate skill:

```bash
scripts/run-gate.sh start           # creates a fresh isolated gate DB
scripts/run-gate.sh wait --follow   # backgrounded; exit 0 pass / 1 fail / 2 dead
```

No UI/UAT spec: this slice changes no user-facing surface (no live-path proof required; note
that plainly in the PR).

## Kill gate

If the fixture cannot demonstrate a read-only, actor-scoped, bounded candidate invocation, or if
the `signal` plumbing forces changes outside `worker-runtime.ts` and
`external-module-tools.ts`, stop and report to the coordinator with the exact failing citation
rather than widening the change. Decider: the coordinator (module-platform owner for a re-slice).

## Out of scope

- Real candidate declarations for any installed module (that is 2.3 / slice 2b).
- Wiring `loadCandidates` in the live chat path (slice 3.5).
- Any change to the gateway, the gate engine, the setting, or the app map.
