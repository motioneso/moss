# Module AI tasks — session-sized implementation plan

Task: #3716. Spec: `docs/superpowers/specs/2026-10-25-module-ai-tasks-design.md`.
Branch: `feat/module-ai-tasks`. Workspace: `~/Jarv1s/.claude/worktrees/mod-ai-tasks`.

## Authorization and scope

The boot brief explicitly authorizes building the draft with provisional defaults; Ben also
approved this slice plan during the session. This overrides the normal approved-spec gate for
this work only. One session, one context window, no relay, no merge. Commit this plan before code.
This session delivers slice 1 only; remaining slices become separate GitHub task issues, with
explicit dependencies. They describe decisions and acceptance criteria, not prewritten code.

No SQL, migration edits, model/provider literals, or private job payloads. Sibling specs own
page writes and job enqueue; do not implement those here. Per Ben's later instruction, stack the
PR on `docs/module-platform-specs` while #3718 is open; retarget/rebase onto main after it merges.
Do not duplicate the spec into a new commit.

Remaining task issues: resolver #3725, RPC/bridges #3726, admin API #3727, Settings/live proof
#3728. Binding retention Q5 is tracked separately in #3729.

## Seams verified in the current tree

- SDK task tier/capabilities already exist in `packages/module-sdk/src/ai-capabilities.ts:6`.
  Manifest declarations are re-exported at `packages/module-sdk/src/index.ts:844`; the JSON
  manifest itself lives at `packages/module-sdk/src/external-module.ts:389`.
- External validation is pure/browser-safe, reconstructs an allow-list at
  `packages/module-registry/src/external/validate.ts:912`, and delegates bounded declarations
  near `:837`. It is already 951 lines; use a dedicated `validate-ai-tasks.ts`, not inline growth.
- Discovery hashes the validated manifest and package separately at
  `packages/module-registry/src/node.ts:135-145`. Canonical hashing sorts object keys but preserves
  array order (`packages/module-registry/src/external/hash.ts:10-28`).
- **Q3 answered:** reconciliation compares package hashes to decide active/drifted, and compares
  manifest hashes to retain descriptor approval (`packages/module-registry/src/external/reconcile.ts:89-104`).
  Recognizing previously ignored `aiTasks` changes the canonical manifest hash, not package bytes.
  Such an enabled module remains active but loses descriptor approval. Worker invocation rejects
  either hash mismatch (`apps/worker/src/external-module-invoke.ts:177-195`); this includes queued
  jobs through `apps/worker/src/external-module-job-handler.ts:20-22`. Admin enable records current
  hashes and approval (`packages/settings/src/routes-modules.ts:233` and
  `packages/settings/src/repository-external-modules.ts:114-154`). Safest choice: keep all checks;
  require re-enable, never silently accept a new validated manifest. Malformed preexisting
  `aiTasks` now fails validation rather than being dropped. No automatic backfill.
- RPC validates an explicit field allow-list in
  `packages/module-registry/src/external/worker-rpc-host.ts:574`, calls the bridge at `:386`, and
  reads the caller's own discovery. The task wire string must be resolved there, not in modules.
- API bridge calls structured AI with `module.<id>` at
  `apps/api/src/external-module-ai-bridge.ts:37`; worker equivalent is
  `apps/worker/src/external-module-ai-bridge.ts:48`. Both remove usage/model details from responses.
- Service routing/pins are in `packages/ai/src/repository.ts:1377-1480`; current chain at `:1421`
  lacks the parent module. Structured input is in
  `packages/ai/src/structured/generate-structured.ts:107`; additional-capability matching is new work.
- Installed-module dependency injection exists at `packages/ai/src/routes.ts:129`, wired at
  `packages/module-registry/src/index.ts:2258`. Task inventory must use this public composition
  seam, never reach from AI into registry internals.
- Existing Settings rows are in `apps/web/src/settings/settings-ai-admin-pane.tsx:336` and `:721`;
  core app-map setting `aiproviders` is in `packages/shared/src/app-map-core.ts:286`.

## Provisional defaults and remaining decisions

- Q1 (Ben): follow the recommendation of display-name-only attribution if 83d is implemented.
  This spec's routing response remains unchanged. Keep 83d out of all five slices until its
  opt-in response contract is explicitly settled; do not expose ids, provider, usage, or names now.
- Q2 (Ben): provisionally show task rows only for enabled downloaded modules. Admin inventory
  must obtain current enablement, rather than treat on-disk discovery as enabled.
- Q3 (plan author): resolved above; add executable discovery/hash/reconcile regression proof.
- Q4 (Ben): provisionally permit `requires: ["vision"]` before image transport #1696. It declares
  routing requirements only; do not claim images can be supplied through this API.
- Q5: preserve existing uninstall behavior; file a separate follow-up to decide binding cleanup.
- Unspecified edge choice: labels containing only whitespace are invalid; accepted labels are
  preserved exactly (1–48 characters). Optional `requires: []` is valid; omission stays omitted.

## Ordered slices

### 1. Manifest declarations and upgrade evidence — this session

Files: `packages/module-sdk/src/index.ts`, `packages/module-sdk/src/external-module.ts`,
`packages/module-registry/src/external/validate.ts`, new
`packages/module-registry/src/external/validate-ai-tasks.ts`, and
`tests/unit/external-module-ai-tasks-manifest.test.ts`.

Contract: export `ModuleAiTaskDeclaration` beside SDK AI declarations with readonly `id`, `label`,
`defaultTier: AiModelTier`, and optional `requires: readonly "vision"[]`; add optional
`aiTasks: readonly ModuleAiTaskDeclaration[]` to the JSON manifest. A pure
`validateAiTasks(raw: unknown, errors: string[]): readonly ModuleAiTaskDeclaration[] | undefined`
validates and reconstructs task declarations; the main validator must re-emit them.

Acceptance: T1–T2, including 1/16 entries, exact id/label bounds, duplicate ids/capabilities,
unknown fields, malformed objects/arrays, all tiers, and unchanged no-task manifests. Tests
must assert the validated output, not the input. Exercise disk discovery → validation → hashing
→ reconciliation for previously ignored valid declarations; prove old manifest hash clears
approval without disabling unchanged bytes, and current hashes restore approval. Existing
worker hash-mismatch tests cover refusal; do not modify the trust gate.

This is internal groundwork: no RPC `task` field, routing choice, Settings row, or end-user
feature is exposed, so no app-map expansion or browser UI proof applies to this slice. End-to-end
proof for this slice is the real filesystem discovery/reconciliation test, without DB/network.

Kill gate after slice 1: Ben/coordinator evaluates the hash-upgrade evidence and provisional
choices. Stop before runtime work if re-enable is unacceptable or the declaration contract changes.

### 2. Resolver and additional capabilities

Depends on slice 1. Files: `packages/ai/src/repository.ts` (extract focused routing helpers if
needed), `packages/ai/src/structured/generate-structured.ts`, focused resolver/structured tests.
Add optional `requiredCapabilities?: readonly AiModelCapability[]` to structured input and service
resolver options. Match every required capability on every candidate path. Derive task → module
→ `module.worker` chain; explicit-binding remains exact-key-only. Implement spec cases 1–13,
including provider-pin in-provider binding and mode-tier behavior, keeping exact-model rejection
options intact. Prove T6–T12 with real DB fixtures through verify-gate, covering json-only versus
vision models, pin misses, dangling bindings and legacy no-task calls. No module-facing API yet.

### 3. Worker RPC and both bridges

Depends on slices 1–2. Files: SDK `worker.ts`, registry `external/worker-rpc-host.ts`, both app
`external-module-ai-bridge.ts` files, RPC/bridge tests. Add optional wire `task?: string`; only the
host builds `{ id, defaultTier, requires }` from the invoking module's own validated manifest.
Reject task+tierHint, empty/non-string/undeclared/cross-module ids before bridge invocation.
Both bridges send the derived service/tier/capabilities. Preserve response opacity and no-task
behavior. Prove T3–T5 and API+worker wiring, then an installed two-task module invocation through
`test:module-worker-queue-ai` (extend that integration path as needed). Update owning app-map
metadata for any newly exposed behavior; no Settings claims until slice 5.

### 4. Admin task inventory and binding validation

Depends on slices 1–3. Files: AI `routes.ts`, `capability-route-routes.ts`, `manifest.ts`, shared
AI API contracts, registry composition seam `index.ts`, focused API tests. Add admin-only
`GET /api/ai/module-tasks` (`ai.view`, chat blocked as self_authority). Inject module id/name/tasks
and current enabled-state filtering, without importing registry internals into AI. Tighten PUT
for downloaded task suffixes and required model capabilities; retain built-in dotted keys.
Prove T13–T14 using actual routes, permissions, disabled/uninstalled modules and capability
failures, through verify-gate. App-map describes available API behavior accurately.

### 5. Settings task rows and full live proof

Depends on slices 1–4 and Ben's Q2/Q4 disposition. Read design-system skill before any UI work.
Files: `apps/web/src/settings/settings-ai-admin-pane.tsx`, focused settings components/API hooks,
shared API contracts as needed, `packages/shared/src/app-map-core.ts`, browser acceptance tests.
Reuse ServiceRow, Select, Badge, Note, CollapsibleGroup. Sort modules by name and preserve task
order; inherit deletes bindings; filter models by all capabilities. Implement empty/loading/error
Retry and >3-module collapse/count, without adding explanatory prose. Status reflects current
bindings, never per-user pin preview. Prove T15 and T16 through a live dev instance reached from
real Settings UI, using an installed two-task module and bounded host logs. No mocked responses.
Record run, exit code and assertions on PR; otherwise label code-complete, unverified. Do not merge.

## Determinism boundary

Settings feedback and status derive from records and declarations. The model has two existing
jobs only: produce a schema-conforming structured object and report generation failure via the
existing result contract. It never authors Settings labels, routing decisions or acknowledgements,
and modules inject no host-chat turns. This work adds no prompt or model-authored user-data writes;
per-item diff acceptance remains the consuming module's responsibility.

## Verification and closeout

All commands below are unpiped; expected exit 0 unless stated. Use the verify-gate skill for
any gate/DB run, including narrowed scripts. Do not run database tests directly.

- `pnpm exec vitest run tests/unit/external-module-ai-tasks-manifest.test.ts tests/unit/external-hash.test.ts tests/unit/external-reconcile.test.ts`
- `pnpm exec eslint <explicit changed TypeScript paths> --max-warnings=0`
- `pnpm exec prettier --check <explicit changed paths>`
- `pnpm check:file-size`
- `pnpm typecheck`
- `scripts/run-gate.sh start --gate verify:static`; then `scripts/run-gate.sh wait --follow`,
  with the wait detached through the tool; read its terminal exit code. Full DB gate for runtime
  slices uses `scripts/run-gate.sh start` instead. Neither replaces CI or required live proof.

Before commit: inspect every diff, use shared-checkout skill and explicit paths. After each
commit inspect `git show --name-only HEAD`. Before PR: clean tree, use the stacking rule above,
rerun checks
if inputs changed, push branch, fill Release note (slice 1 Category: N/A), list Ben questions and
remaining task links in PR body, report PR to coordinator w1:p1E using herdr-pane-message.

## Rulings ledger

- 2026-10-25: brief authorizes provisional draft defaults and bounded delivery; Ben confirmed
  slice plan. No need to reopen approval before implementing slice 1.
- 2026-10-25: Q3 is not simply “hash drift disables modules.” Package drift disables; canonical
  manifest drift clears descriptor approval and rejects worker invocation until admin re-enable.
  Evidence: reconcile `:89-104`, worker invoke `:177-195`, enable repository `:114-154` above.
- 2026-10-25: Ben directed stacking the build PR on #3718's branch while that PR is open,
  rather than copying its AI spec into a separate commit. Retarget after the spec PR merges.
