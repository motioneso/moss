# Build plan — #2012 Workflow definition contracts and registry validation

- **Issue:** #2012 `[819-A] Workflow definition contracts and registry validation` (Part of #819)
- **Approved spec:** `docs/superpowers/specs/2026-07-08-workflow-layer-pg-boss.md`, sections
  "Workflow Definition API" (lines 50-133) and "Artifacts" (lines 321-343).
- **Implementation spec:** the `SPEC` comment on issue #2012 (authored by the planning lane).
- **Risk tier:** security.
- **Branch:** `fleet/lane-2012` off `origin/main` (`51cc4e624`).

## Scope

Add the TypeScript shape a developer writes a workflow definition in, plus boot-time validation
that rejects a malformed one before the API or worker can start. Nothing executes a workflow.

Explicitly out of scope (deferred to later 819 slices): workflow database schema, pg-boss queues,
worker execution, approval persistence, HTTP routes, UI.

## Seams check — every assumed capability, cited on this branch

| Assumption                                                           | Evidence on this branch                                                                                              | Status                                                                                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| No workflow contracts exist in the SDK                               | `grep -ri workflow packages/module-sdk/src packages/module-registry/src` returns nothing                             | confirmed absent                                                                                                                   |
| `packages/module-sdk/src/workflow.ts` does not exist                 | directory listing of `packages/module-sdk/src/`                                                                      | confirmed absent                                                                                                                   |
| `packages/module-registry/src/workflow-registry.ts` does not exist   | directory listing of `packages/module-registry/src/`                                                                 | confirmed absent                                                                                                                   |
| Manifest interface to extend                                         | `packages/module-sdk/src/index.ts:622` `export interface MossModuleManifest`                                         | confirmed                                                                                                                          |
| Barrel re-exports a sibling file by explicit named list              | `packages/module-sdk/src/index.ts:665-699` (`external-module.js`)                                                    | confirmed; mirror this                                                                                                             |
| Barrel must stay free of `node:*` imports                            | `packages/module-sdk/src/index.ts:8-11` comment; `tests/unit/module-sdk-barrel-browser-safety.test.ts`               | confirmed                                                                                                                          |
| File-size gate exists and would be pressured by a big `index.ts`     | `package.json:12` `check:file-size` -> `scripts/check-file-size.ts`; `packages/module-sdk/src/index.ts` is 827 lines | confirmed; new file is the right call                                                                                              |
| Boot-time fail-closed hook already exists                            | `packages/module-registry/src/index.ts:2164` top-level `assertModuleRegistryConsistency(BUILT_IN_MODULES);`          | confirmed; no new boot hook needed                                                                                                 |
| That function takes registrations and throws                         | `packages/module-registry/src/index.ts:2178-2180`                                                                    | confirmed                                                                                                                          |
| Registration shape carrying the manifest                             | `packages/module-registry/src/index.ts:642-654` `BuiltInModuleRegistration`                                          | confirmed                                                                                                                          |
| Module-load-time derived constant precedent                          | `packages/module-registry/src/index.ts:2170` `MODULE_IMAGE_CSP_HOSTS`                                                | confirmed; build the registry the same way                                                                                         |
| Package name is `@moss/module-sdk`, manifest is `MossModuleManifest` | `packages/module-sdk/src/index.ts:622`                                                                               | **spec drift**: the design spec says `@jarv1s/module-sdk` / `JarvisModuleManifest`. Follow the branch, not the spec's stale names. |

No open questions. Every capability this plan leans on is cited above.

### Spec staleness check

The design spec was written 2026-07-08. Every premise it states about the tree ("add X", "X does
not exist") still holds on this branch, with the single naming drift noted in the table. Nothing
in this slice has already shipped.

## Determinism boundary

Not applicable in the usual sense: this slice adds no user-facing surface, no chat turn, and no
model-authored value. It is types plus a synchronous validator. The one determinism property that
does matter here is stated as a rule below: **validation failures take the process down; they are
never swallowed into a partially-populated registry.**

## Trust boundary (security tier)

- Workflow definitions are **built-in only** in this slice. `JsonMossModuleManifest`
  (`packages/module-sdk/src/external-module.ts`) is deliberately NOT extended, because a
  downloadable module runs in a separate worker and cannot supply a TypeScript handler function.
- The validator treats each definition as **untrusted input at runtime**, not just at compile
  time: a plain JavaScript module can pass fields the types forbid. So every rule is checked with
  runtime guards, including the `queue` / `queueName` ban, which exists so a definition can never
  reach into the queue namespace that `assertModuleRegistryConsistency` already polices.
- Error messages name the module id, workflow id and rule name. They must never echo handler
  source, approval details content, or any value that could carry private data.

## Tasks

Each task commits green on its own.

### Task 1 — Workflow contracts in the module SDK

New file `packages/module-sdk/src/workflow.ts`. No `node:*` imports. Every field `readonly`.

Exported signatures (contracts, not bodies):

```ts
export const MAX_WORKFLOW_STEP_ATTEMPTS = 10;

export type WorkflowTrigger = "manual" | "module";
export type WorkflowStepKind = "task" | "approval";
export type WorkflowBackoffStrategy = "fixed" | "exponential";

export interface WorkflowArtifactPort {
  write(input: {
    readonly workflowRunId: string;
    readonly stepRunId: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Promise<{ artifactRef: string; sha256: string; sizeBytes: number }>;
  read(artifactRef: string): Promise<{ bytes: Uint8Array; contentType: string }>;
}

export interface WorkflowStepContext {
  readonly actorUserId: string;
  readonly requestId: string;
  readonly workflowRunId: string;
  readonly stepRunId: string;
  readonly runInput: Record<string, unknown>;
  readonly stepInput: Record<string, unknown>;
  getStepResult(stepId: string): Promise<Record<string, unknown> | null>;
  readonly artifacts: WorkflowArtifactPort;
}

export type WorkflowStepHandler = (
  context: WorkflowStepContext
) => Promise<Record<string, unknown>>;

export interface WorkflowApprovalSpec {
  readonly summary: string;
  readonly details?: Record<string, string | number | boolean | null>;
}

export interface WorkflowStepRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs?: number;
  readonly backoff?: WorkflowBackoffStrategy;
}

export type WorkflowEdgeCondition =
  | { readonly type: "always" }
  | { readonly type: "onSuccess" }
  | { readonly type: "onFailure" }
  | {
      readonly type: "resultEquals";
      readonly field: string;
      readonly equals: string | number | boolean | null;
    };

export interface WorkflowEdgeDefinition {
  readonly from: string;
  readonly to: string;
  readonly condition: WorkflowEdgeCondition;
}

export interface WorkflowStepDefinition {
  readonly id: string;
  readonly kind: WorkflowStepKind;
  readonly retry?: WorkflowStepRetryPolicy;
  readonly timeoutMs?: number;
  readonly handler?: WorkflowStepHandler;
  readonly approval?: WorkflowApprovalSpec;
}

export interface ModuleWorkflowDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly version: number;
  readonly startStepId: string;
  readonly trigger: WorkflowTrigger;
  readonly steps: readonly WorkflowStepDefinition[];
  readonly edges: readonly WorkflowEdgeDefinition[];
}
```

Then in `packages/module-sdk/src/index.ts`:

- re-export the above by explicit named list from `./workflow.js`, mirroring the
  `external-module.js` block at lines 665-699;
- add `readonly workflows?: readonly ModuleWorkflowDefinition[];` to `MossModuleManifest`, with a
  one-line comment recording that downloadable modules are excluded on purpose.

`packages/module-sdk/src/external-module.ts` is not touched.

### Task 2 — The validator and the built registry

New file `packages/module-registry/src/workflow-registry.ts`.

```ts
export interface WorkflowRegistryEntry {
  readonly moduleId: string;
  readonly definition: ModuleWorkflowDefinition;
}

export type WorkflowRegistry = ReadonlyMap<string, WorkflowRegistryEntry>;

export function validateModuleWorkflows(
  registrations: readonly { readonly manifest: MossModuleManifest }[]
): void;

export function buildWorkflowRegistry(
  registrations: readonly { readonly manifest: MossModuleManifest }[]
): WorkflowRegistry;
```

Rules enforced, each throwing an `Error` on the first breach. Message format carries a
machine-readable rule name in quotes so tests assert on the rule, not on prose:

`Module "<moduleId>" workflow "<workflowId>" failed rule "<rule>": <detail>`

| Rule name               | What it rejects                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duplicate-workflow-id` | the same workflow id declared twice, in one module or across two                                                                                         |
| `workflow-id-prefix`    | an id that is not `<moduleId>.<something>`                                                                                                               |
| `workflow-version`      | a version that is not an integer >= 1                                                                                                                    |
| `steps-empty`           | a workflow with no steps                                                                                                                                 |
| `duplicate-step-id`     | two steps sharing an id inside one workflow                                                                                                              |
| `start-step`            | `startStepId` naming a step that does not exist                                                                                                          |
| `edge-endpoint`         | an edge whose from-step or to-step does not exist                                                                                                        |
| `unreachable-step`      | a step not reachable from the start step by following edges                                                                                              |
| `cycle`                 | any cycle in the graph                                                                                                                                   |
| `retry-policy`          | `maxAttempts` below 1 or above `MAX_WORKFLOW_STEP_ATTEMPTS`, non-integer, or a `backoffMs` that is not a positive finite number                          |
| `step-handler`          | a task step with no handler, or an approval step carrying a handler                                                                                      |
| `step-approval`         | an approval step with no approval spec                                                                                                                   |
| `approval-terminal`     | an approval step with no outgoing edge                                                                                                                   |
| `edge-condition`        | a condition whose `type` is not one of the four allowed shapes, or a `resultEquals` missing a non-empty string `field` or carrying a non-scalar `equals` |
| `queue-name`            | any `queue` or `queueName` property on a definition or a step                                                                                            |

Reading of the spec line "every non-terminal task step has at least one outgoing edge": v1 has no
terminal flag, so a task step with no outgoing edges is accepted as an end point and an approval
step with no outgoing edges is rejected. This is the SPEC comment's stated reading; recorded here
so a reviewer can disagree on the issue rather than guess.

### Task 3 — Wire into the existing boot check and expose the registry

In `packages/module-registry/src/index.ts`:

- call `validateModuleWorkflows(registrations)` from inside `assertModuleRegistryConsistency`
  (starts at line 2178), so the existing top-level call at line 2164 already fails the API and the
  worker closed at boot. No new boot hook.
- build the registry once at module load next to `MODULE_IMAGE_CSP_HOSTS` (line 2170), and export
  `getWorkflowRegistry(): WorkflowRegistry` returning it.

Because the constant is built at load, an invalid definition takes the process down rather than
quietly vanishing from the registry — the spec's "invalid definitions must never silently
disappear" requirement.

No module declares a workflow yet, so `getWorkflowRegistry()` returns an empty lookup. Expected.

### Task 4 — Tests

`tests/unit/module-sdk-workflow-contracts.test.ts`

- **Behaviour:** a definition using both step kinds and all four edge conditions type checks and is
  structurally readable at runtime. **Fails against a broken implementation** if a condition shape
  or a step field is missing or misnamed, because the file will not compile.
- **Behaviour:** the retry cap is exported and is an integer >= 1. **Fails** if the constant is
  dropped or set to a nonsense value that would make the retry rule unenforceable.

`tests/unit/module-registry-workflow-validation.test.ts` — fake registrations built in the test;
the real `BUILT_IN_MODULES` list is never touched. One case per rule, each asserting the thrown
message contains the module id, the workflow id, and the rule name:

duplicate id across two modules; unprefixed id; version `0`; version `1.5`; duplicate step ids;
`startStepId` naming a missing step; edge pointing at a missing step; an unreachable step; a
two-step cycle; a three-step cycle; `maxAttempts: 0`; `maxAttempts` above the cap; a task step with
no handler; an approval step carrying a handler; an approval step with no outgoing edge; an unknown
edge condition type; a definition carrying a queue name; and a happy path — one valid definition
with a task step, an approval step, an `onFailure` edge and a `resultEquals` edge — which validates
cleanly and appears in the built registry keyed by its id and carrying its module id.

**Why each fails against a broken implementation:** every negative case is a definition that a
missing rule would accept, so a dropped rule turns the case from "throws" into "returns", which the
test catches directly. The happy path guards the opposite failure — a rule so strict that nothing
valid survives it.

## Phase e2e note

This slice ships no user-facing surface: no route, no screen, no module manifest change that a user
could see, no database. There is therefore **no UAT spec and no `uat-trigger-map.tsv` row**, and
the live-path gate does not apply. The equivalent end-to-end proof for this slice is that importing
the module registry package — which both the API server and the worker do at boot — runs the
validator, demonstrated by a unit test and by the API and worker still starting with the change in.

## Verification (never piped; expected exit code 0 for each)

```bash
pnpm check:file-size > /tmp/2012-filesize.log 2>&1; echo "EXIT=$?"
pnpm typecheck       > /tmp/2012-typecheck.log 2>&1; echo "EXIT=$?"
pnpm lint            > /tmp/2012-lint.log 2>&1; echo "EXIT=$?"
pnpm format:check    > /tmp/2012-format.log 2>&1; echo "EXIT=$?"
pnpm test:unit       > /tmp/2012-unit.log 2>&1; echo "EXIT=$?"
```

Known trap, not this branch: `tests/unit/module-sdk-worker.test.ts` fails on this machine and
passes in CI. Do not chase it, do not bisect over it. Everything else must be green.

Anything touching the database goes through the `verify-gate` skill. This slice does not touch it.

## Kill gate

**Observation that ends the line:** if enforcing the acyclic rule turns out to conflict with a
built-in module that already needs a loop, or if the "approval step must have an outgoing edge"
reading blocks a real workflow someone wants to write, stop and take it back to the issue rather
than inventing a terminal flag. **Owner:** Ben, via a comment on #2012. Nothing in this slice
depends on that answer, so it is a follow-up decision, not a blocker.

## Rulings ledger

- The design spec's package and interface names (`@jarv1s/module-sdk`, `JarvisModuleManifest`) are
  stale; the tree uses `@moss/module-sdk` and `MossModuleManifest`. Follow the tree.
- Contracts go in a new file, not the SDK barrel, because the barrel is 827 lines against a
  1000-line size gate and is not exempt.
- Downloadable modules are excluded from workflows on purpose (no TypeScript handler across the
  worker boundary), so `JsonMossModuleManifest` gains nothing.
- No new boot hook is needed: `packages/module-registry/src/index.ts:2164` already runs the
  consistency check at import time, and both the API server and the worker import that package.
