# Module AI tasks: per-task model choice for downloaded modules

Status: Draft (2026-10-25), awaiting Ben's approval
Task: #3716 (unblocks #3317 stories 83b-83c; 83d needs open question Q1)
Grounded on: `origin/main` at `ad69bc66e`

## Goal

A downloaded module names the AI job it is doing ("plan", "swap", "estimate"). An administrator
can bind each named job to a mode or a specific model. Unbound jobs fall back to the module's
binding, then the generic module binding, then the instance default at the job's declared tier.
Features still request capabilities and tiers only; no provider or model name is ever hardcoded.

## Problem (verified)

| #   | Claim in #3716                                          | Verdict                         | Evidence                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Structured-AI request takes no task                     | True                            | `packages/module-registry/src/external/worker-rpc-host.ts:574-599` allow-list is `schema`, `prompt`, `maxOutputTokens`, `tierHint`; anything else throws `invalid_rpc`. Both bridges hardcode `module.<id>`: `apps/api/src/external-module-ai-bridge.ts:37`, `apps/worker/src/external-module-ai-bridge.ts:48`. SDK type matches: `packages/module-sdk/src/worker.ts:122-128`.       |
| 2   | Lookup falls back to `module.worker`, not `module.<id>` | True for a task key, moot today | `packages/ai/src/repository.ts:1421-1424` tries `[service, module.worker]`. With a `module.<id>.<task>` key the module's own binding is skipped. No downloaded module can send a task key yet, so this only bites once claim 1 is fixed.                                                                                                                                             |
| 3   | An "instance pin" overrides module bindings             | Mechanism true, label wrong     | `repository.ts:1401-1420` returns the pin before any binding unless `requireExplicitBinding`. The pin is **per user**, not instance-wide: stored in `app.preferences` under the owner (`repository.ts:1934-1942`, `:2010-2020`), set by an admin per target user (`packages/ai/src/admin-ai-pin-routes.ts:49-80`). The override is deliberate (see "The pin is a privacy boundary"). |
| 4   | Admin pane lists only Chat and Email reading            | True                            | `apps/web/src/settings/settings-ai-admin-pane.tsx:65-86` (`SERVICE_ROWS`), rendered at `:721-756`.                                                                                                                                                                                                                                                                                   |

Supporting facts:

- Bindings are instance-wide. One JSON blob, `ai.service_bindings` in `app.instance_settings`
  (`repository.ts:341`, merge-upsert at `:903-940`). No per-user module bindings exist.
- The binding store already accepts dotted keys. `PUT /api/ai/services/:service/binding` accepts
  `module.<installed-id>.<anything>` (`packages/ai/src/capability-route-routes.ts:122-135`).
  Key shape: `packages/shared/src/ai-types.ts:156-161`.
- Dotted keys already exist for built-ins: `module.connectors.email-extract`
  (`packages/connectors/src/extract-deps.ts:62`), `module.trail-marker.judge`
  (`packages/focus-judgment/src/constants.ts:6`), `module.commitments.email-judgement`
  (`packages/commitments/src/email-judgement.ts:20`).
- Downloaded module ids cannot contain dots (`packages/module-registry/src/external/validate.ts:42`),
  so `module.<id>.<task>` parses unambiguously.
- The rpc host already reads the module's own manifest per call, e.g. action families
  (`worker-rpc-host.ts:330-343`). Task validation can sit beside it.
- The external validator re-emits only listed fields (`validate.ts:912-947`); an unknown top-level
  key is dropped silently today.
- The manifest hash covers the validated manifest (`packages/module-registry/src/node.ts:144`,
  `install-draft.ts:71`).
- Capabilities include `vision` (`packages/module-sdk/src/ai-capabilities.ts:7-23`), but
  structured AI has no image input. That is #1696 (open).
- Modules never learn which model answered. Both bridges drop model and usage
  (`apps/api/src/external-module-ai-bridge.ts:45-49`).

### The pin is a privacy boundary

- An admin pins one user to a model or a provider. The pin "hard-locks ALL of the user's traffic
  (chat + voice + workers) to that provider" (`repository.ts:2029-2030`).
- Worker and voice misses stay inside the pinned provider and never cross to another backend
  (`repository.ts:1275-1292`, `:1295-1312`).
- The users it protects are anyone an admin keeps on one backend: a local model for privacy, or a
  single paid account for cost.
- A module binding is instance-wide and set for everyone. Letting it beat a per-user pin would send
  a pinned user's private data to a provider the admin excluded for that user. This spec keeps the
  pin as a hard boundary and lets bindings steer only inside it.

## Design

### 1. Manifest declaration

New optional top-level field on the downloaded-module manifest.

```json
"aiTasks": [
  { "id": "plan",     "label": "Plan writing",        "defaultTier": "reasoning" },
  { "id": "swap",     "label": "Quick swaps",         "defaultTier": "interactive" },
  { "id": "estimate", "label": "Nutrition estimates", "defaultTier": "economy" },
  { "id": "photo",    "label": "Photo reading",       "defaultTier": "interactive", "requires": ["vision"] }
]
```

Shared type, in `packages/module-sdk/src/index.ts` beside the other manifest declarations:

```ts
export interface ModuleAiTaskDeclaration {
  readonly id: string; // /^[a-z][a-z0-9-]{0,31}$/
  readonly label: string; // 1-48 chars, shown in Settings
  readonly defaultTier: AiModelTier; // "reasoning" | "interactive" | "economy"
  readonly requires?: readonly "vision"[]; // extra capabilities beyond json
}
// JsonMossModuleManifest gains: readonly aiTasks?: readonly ModuleAiTaskDeclaration[];
```

Validation, in `validate.ts` as `validateAiTasks(raw, errors)`:

- Non-empty array, at most 16 entries, ids unique.
- `id` has no dots, so a task key is always `module.<id>.<task>` with exactly one extra segment.
- `defaultTier` must be a known tier.
- `requires` is a unique subset of `["vision"]`. Nothing else is allowed, because `json` is
  implied and the other capabilities (`chat`, `tool-use`, `transcription`, `web-search`) are not
  structured-output capabilities.
- Unknown keys inside an entry reject the manifest, matching the `appMap` rule.
- `aiTasks` is added to the re-emit list at `validate.ts:912-947`. Forgetting it is silent (the
  briefing comment at `:938-941` records the same trap), so a unit test covers it.
- Built-in compiled manifests may use the same type later. No built-in adopts it in this work.

### 2. Request field

SDK (`packages/module-sdk/src/worker.ts:122-128`) and rpc host request gain one optional field:

```ts
generateStructured(input: {
  schema: Record<string, unknown>;
  prompt: string;
  maxOutputTokens?: number;
  tierHint?: AiModelTier;
  task?: string;            // a declared aiTasks id
}): Promise<...unchanged...>;
```

Rules in `aiRequest` (`worker-rpc-host.ts:574`) and the `ai.generateStructured` branch (`:386`):

| Request                                              | Result                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| No `task`                                            | Unchanged. Service `module.<id>`, tier from `tierHint` or `economy`.                         |
| `task` declared in this module's own manifest        | Service `module.<id>.<task>`, tier from the declaration, extra capabilities from `requires`. |
| `task` not declared, or module declares no `aiTasks` | `invalid_rpc`. Host log names the task (detail is host-only, `worker-rpc-host.ts:634-643`).  |
| `task` and `tierHint` together                       | `invalid_rpc`. The declaration owns the tier; two sources would disagree silently.           |
| `task` not a string or empty                         | `invalid_rpc`.                                                                               |

The host resolves the declaration and hands the bridge a host-built route. The module never
supplies tier or capabilities for a task.

```ts
// packages/module-registry/src/external/worker-rpc-host.ts
export interface ExternalModuleAiRequest {
  readonly schema: Record<string, unknown>;
  readonly prompt: string;
  readonly maxOutputTokens?: number;
  readonly tierHint?: AiModelTier;
  readonly task?: {
    // host-side only, never parsed from wire params
    readonly id: string;
    readonly defaultTier: AiModelTier;
    readonly requires: readonly AiModelCapability[];
  };
  readonly signal?: AbortSignal;
}
```

Both bridges map `task` to `service: module.<id>.<task.id>`, `tierHint: task.defaultTier` and
`requiredCapabilities: task.requires`. The returned shape stays `{ ok, object }` or
`{ ok: false, error }`.

### 3. Resolution order

`GenerateStructuredInput` (`packages/ai/src/structured/generate-structured.ts:107`) and
`resolveModelForService` (`repository.ts:1377`) gain one option:

```ts
readonly requiredCapabilities?: readonly AiModelCapability[]; // in addition to `capability`
```

The binding chain for a service key is derived, not passed:

| Service key                        | Chain, first bound key wins                          |
| ---------------------------------- | ---------------------------------------------------- |
| `module.<id>.<task>`               | `module.<id>.<task>`, `module.<id>`, `module.worker` |
| `module.<id>`                      | `module.<id>`, `module.worker` (unchanged)           |
| `module.worker`                    | `module.worker` (unchanged)                          |
| any, with `requireExplicitBinding` | the key alone (unchanged)                            |

Then:

1. **Binding.** B = first bound key in the chain, or none.
2. **Tier.** T = B's tier if B is a mode binding, else the request tier (task default tier, else
   `tierHint`, else `economy`). Bindings beat hints, as today (`repository.ts:1461-1468`).
3. **Capabilities.** R = `json` plus `requiredCapabilities`. Every candidate model must carry all
   of R, in every branch below, including pin and fallback searches.
4. **Pin.** Applied before the binding is used, with the rule below.
5. **No pin.** A model binding serves if active and carrying R. A dangling model binding degrades
   inside the default provider at T (today's rule, `repository.ts:1440-1458`). A mode binding
   picks automatically at T. No binding resolves the instance default at T
   (`repository.ts:1475`).
6. **Miss.** `needs_config` to the module, logged host-side as today.

### 4. The pin rule

The pin is an outer boundary. Bindings and tiers choose a model inside it.

- **Model pin.** The pinned model serves every task that it can, meaning it carries R. Bindings are
  ignored, because the admin picked one exact model for this user. If the pinned model lacks R
  (say a vision task), search the pinned model's provider at T for R. If nothing is found, return
  `needs_config`. Never leave the provider.
- **Provider pin.** If B is a model binding whose model belongs to the pinned provider and carries
  R, use it. Otherwise search the pinned provider at T for R. If nothing is found, return
  `needs_config`. Never leave the provider.

| Case | Pin                     | Binding found                                      | Result                                                                     |
| ---- | ----------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| 1    | none                    | task model binding, active                         | that model                                                                 |
| 2    | none                    | no task binding; module mode binding `interactive` | automatic pick at `interactive`                                            |
| 3    | none                    | nothing bound                                      | default provider at the task's declared tier                               |
| 4    | none                    | only `module.worker` model binding                 | that model                                                                 |
| 5    | none                    | task model binding, model removed                  | default provider at the request tier                                       |
| 6    | none                    | vision task; bound model lacks vision              | treat as dangling: default provider at T with vision, else `needs_config`  |
| 7    | model pin               | task bound to another model                        | pinned model, if it carries R                                              |
| 8    | model pin, lacks vision | vision task                                        | pinned provider at T with vision, else `needs_config`                      |
| 9    | provider pin P          | task bound to a model in P                         | that model                                                                 |
| 10   | provider pin P          | task bound to a model in another provider          | P at T, where T comes from the declared tier (a model binding has no tier) |
| 11   | provider pin P          | task bound to mode `reasoning`                     | P at `reasoning`                                                           |
| 12   | any                     | task not declared                                  | `invalid_rpc` before routing                                               |
| 13   | any                     | `requireExplicitBinding` caller                    | unchanged: key alone, pin ignored as today                                 |

Case 9 and case 11 are a behaviour change. Today a provider pin ignores every binding and uses
only the request's tier hint (`repository.ts:1405-1420`, `:1296-1303`). After this, bindings
steer inside the provider. The boundary is unchanged.

### 5. Settings pane

The change extends the existing "Which model does what" group on Settings, AI providers
(`settings-ai-admin-pane.tsx:721`). There is no new screen.

```
Which model does what
  Chat & briefing              [ Interactive         v ]  model-x
  Email reading                [ Specific: model-y   v ]  model-y
  Classifier                   [ ...                   ]
  ----------------------------------------------------------------
  Meals                        [ Instance default    v ]
    Plan writing               [ Use Meals' choice   v ]  Reasoning
    Quick swaps                [ Use Meals' choice   v ]  Interactive
    Nutrition estimates        [ Specific: model-z   v ]  model-z
    Photo reading   Vision     [ Use Meals' choice   v ]  Needs configuration
  ----------------------------------------------------------------
  Let people choose their own chat model            [switch]
  Chat lock rows ...
```

- Each installed downloaded module that declares `aiTasks` gets one module row (key
  `module.<id>`) followed by one indented row per task (key `module.<id>.<task>`). Modules sort by
  name, tasks by declaration order.
- Rows reuse `ServiceRow` (`settings-ai-admin-pane.tsx:336`) and its `rt` row markup, the `Select`
  primitive from `@moss/ui`, and `Badge` for the "Vision" tag. All come through
  `apps/web/src/settings/settings-ui.tsx:6`.
- `ServiceRow` gains an inherit option at the top of the dropdown. On a task row it reads
  "Use <Module>'s choice"; on a module row it reads "Instance default". Choosing it deletes the
  binding through the existing `DELETE /api/ai/services/:service/binding`
  (`capability-route-routes.ts:242`).
- The model list filters to active models that carry `json` plus the task's `requires`, using the
  same readiness filter as today (`settings-ai-admin-pane.tsx:368-381`).
- The right-hand status shows the bound model, the inherited tier label, or "Needs configuration"
  when no active model can carry R. It does not preview pins, because pins differ per user.
- With more than three modules declaring tasks, the module block moves into a `CollapsibleGroup`
  (`settings-ui.tsx:26`) titled "Modules", whose summary line counts bound tasks. With three or
  fewer, it stays inline.
- Empty: no module declares tasks, so no module rows and no divider. Loading: rows wait on the
  existing bindings query. Error: the task list query failing hides module rows and shows one
  inline `Note` with Retry.
- No explanatory copy beyond each row's label.

Data for the pane comes from one new read route, declared in `packages/ai/src/manifest.ts` beside
the bindings routes (`:478-492`):

```ts
// GET /api/ai/module-tasks   permissionId "ai.view", chat blocked (self_authority)
export interface AiModuleTasksResponse {
  readonly modules: readonly {
    readonly moduleId: string;
    readonly moduleName: string;
    readonly tasks: readonly ModuleAiTaskDeclaration[];
  }[];
}
```

`@moss/ai` gets the data through an injected dependency, the same way it gets installed ids today
(`packages/ai/src/routes.ts:129`, wired at `packages/module-registry/src/index.ts:2258`):

```ts
readonly listModuleAiTasks?: () => readonly {
  moduleId: string; moduleName: string; tasks: readonly ModuleAiTaskDeclaration[];
}[];
```

Binding writes tighten. For a downloaded module, `PUT` on `module.<id>.<suffix>` requires
`<suffix>` to be a declared task, and a model binding must carry `json` plus that task's
`requires`. Built-in dotted keys keep today's rule (`capability-route-routes.ts:122-135`).

## What does not change

- Calls without `task`, including every built-in caller and Meals until it adopts tasks.
- `requireExplicitBinding` callers: email extraction, Trail Marker judge, connectors.
- The binding storage format and the `ai.service_bindings` key.
- The sorting-model path (`repository.ts:1516-1569`) and the chat model override.
- What a module sees back: the object or one of the five errors. No model, provider or usage.
- Pin storage, pin routes and pin precedence over bindings. Pins still never leave their provider.
- Voice transcription routing.

## Migration and backfill

- No SQL. Bindings live in an existing JSON blob; the new keys are new entries in it.
- No applied migration is touched.
- No backfill. Existing `module.<id>` and `module.worker` bindings keep their meaning and now also
  act as the fallback for that module's tasks.
- Side effect on one built-in: `module.commitments.email-judgement` (not explicit-binding,
  `packages/module-registry/src/email-judgement-wiring.ts:53-60`) gains `module.commitments` in its
  chain. No UI sets that key, so this only matters if an admin set it through the API.
- Manifest hash: a module whose `jarvis.module.json` already carries `aiTasks` (dropped silently
  today) gets a different validated-manifest hash after upgrade. The plan must confirm what hash
  drift does on load before shipping (Q3).
- Bindings for a task that a module update removes stay in the blob, unreachable and harmless.
  Module bindings are not purged on uninstall today either.

## Design forks

### Fork A: how a pin meets a module binding (chosen: pin is the boundary)

| Option                                               | Outcome     |
| ---------------------------------------------------- | ----------- |
| A1. Pin stays the boundary; bindings steer inside it | **Chosen.** |
| A2. Module bindings beat pins                        | Rejected.   |
| A3. Status quo: pin ignores bindings                 | Rejected.   |

Steelman for A2: the admin set both. A task binding is the more specific choice, and an admin who
binds Meals plan writing to a reasoning model expects it to run there for everyone. The pin was
introduced to lock chat, and it reaching module work is arguably collateral.

Why A2 still loses: the code and comments say the pin covers workers on purpose
(`repository.ts:2029-2030`), and its misses refuse to cross providers for privacy
(`:1287-1290`). A binding is instance-wide; a pin is a per-user exception. Letting the general rule
beat the exception would move a pinned user's meal data to a provider the admin excluded for them,
with no signal. A1 still gives the admin's binding effect whenever it fits inside the pin (cases 9
and 11), and A2's case shrinks to "the admin pinned a user away from the model they then bound",
which is the pin doing its job.

A3 loses because a provider-pinned user would always get the request tier, never the admin's
binding, even when the bound model sits in the pinned provider.

### Fork B: where tasks are declared (chosen: manifest)

| Option                                                     | Outcome     |
| ---------------------------------------------------------- | ----------- |
| B1. Manifest `aiTasks`                                     | **Chosen.** |
| B2. Free task strings at call time, listed after first use | Rejected.   |

Steelman for B2: no manifest change, no validator work, no hash concern. A module can add a task in
a patch without touching its manifest, and the existing PUT already accepts any suffix.

Why B2 loses: the pane cannot list a task until it has run once, so an admin cannot bind plan
writing before the first plan is written on the wrong model. A typo routes silently to the parent
binding. Tier and capability would come from the module at call time, so a module could claim
`economy` for heavy work. B1 puts all of that in the hash-pinned manifest the admin enabled.

### Fork C: task with tier hint (chosen: reject both together)

Steelman for allowing both: a module could nudge one call heavier, such as a long plan. It loses
because the admin's binding already beats hints, so the hint would only matter when nothing is
bound, and two tier sources make "why did this run on economy?" hard to answer.
Modules that need two tiers declare two tasks.

## Tests

| #   | Behaviour                                                                                                                                                      | Why a broken build fails it                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| T1  | Validator accepts a good `aiTasks` and re-emits it unchanged                                                                                                   | A missing re-emit line drops the field with `ok: true`; the test reads the output manifest.         |
| T2  | Validator rejects dotted ids, duplicate ids, unknown tier, `requires: ["chat"]`, unknown entry keys, more than 16 entries                                      | Each check missing lets one bad manifest through.                                                   |
| T3  | rpc host: declared task reaches the bridge as `module.<id>.<task>` with the declared tier                                                                      | A bridge that still hardcodes `module.<id>` sends the wrong key.                                    |
| T4  | rpc host: undeclared task, task with no `aiTasks`, and task plus `tierHint` each return `invalid_rpc` and never call the bridge                                | A lenient host routes a typo to the parent binding; the bridge spy proves no call.                  |
| T5  | Module A cannot use module B's task id                                                                                                                         | Validation against any manifest but the caller's own fails this.                                    |
| T6  | Resolver chain: task binding, then module, then `module.worker`, then default at declared tier (cases 1-4)                                                     | Today's two-key chain skips the module binding in case 2.                                           |
| T7  | Vision task never resolves to a json-only model in any branch, including dangling fallback and pin fallback (cases 6, 8)                                       | A resolver that checks only `json` in one branch picks a model that cannot see.                     |
| T8  | Model pin wins over a task binding (case 7)                                                                                                                    | A2-style precedence returns the bound model.                                                        |
| T9  | Provider pin honours an in-provider task binding and ignores an out-of-provider one (cases 9, 10)                                                              | Status quo ignores case 9; A2 breaks case 10. Case 10 must assert the chosen model's provider is P. |
| T10 | Provider pin with a mode binding uses the binding's tier inside P (case 11)                                                                                    | Today's code uses the request hint instead.                                                         |
| T11 | `requireExplicitBinding` callers resolve exactly as before (case 13), for the three built-in dotted keys                                                       | A chain rewrite that ignores the flag adds parents and pins.                                        |
| T12 | Calls without `task` produce identical resolutions to today for a fixture of pins and bindings                                                                 | Guards every existing module.                                                                       |
| T13 | PUT rejects `module.<downloaded-id>.<undeclared>` and a model lacking `vision` for a vision task; accepts built-in dotted keys as before                       | A loose PUT stores a binding the resolver would treat as dangling.                                  |
| T14 | GET `/api/ai/module-tasks` lists declared tasks for installed modules only, admin only                                                                         | Leaks uninstalled modules or answers non-admins.                                                    |
| T15 | Pane: inherit option deletes the binding; task model list hides models missing a required capability; module block absent when no module declares tasks        | Each is a visible regression an admin would hit.                                                    |
| T16 | Live path on a dev instance: install a test module with two tasks, bind one task to a specific model, run both, confirm from host logs which model served each | CI cannot prove the real bridge and resolver are wired together.                                    |

## App map

Update `packages/shared/src/app-map-core.ts`, setting `aiproviders` (`:286`), description at
`:363`:

- The Which model does what section also lists each installed module that declares AI tasks. Each
  module gets a row for its own choice and a row per task.
- A task row offers "Use <Module>'s choice", a mode, or a specific model. A module row offers
  "Instance default", a mode, or a specific model.
- Tasks that read photos show a Vision tag and offer only vision-capable models.
- A person whose administrator locked them to one provider or model stays on it; task choices apply
  only when they fit inside that lock.
- Error "Needs configuration" on a task row: no active model can do that task. Remediation: add or
  enable a model with the needed capability, or pick one in the row.

Module-owned entries (Meals' own `appMap`) are Meals' work, not this spec's.

## Open questions

**Decided by Ben, 2026-10-25.**

- Q1: option 1. Return the model's display name only, never its id or provider, when the call resolved through a task or module binding.
- Q2: show only enabled modules.
- Q4: yes. Ship `requires: ["vision"]` before #1696 lands.
- Q3 stays with the plan author. Q5 is tracked as #3729.

| #   | Question                                                                                                                                                                                                                                                                                                                                                         | Owner                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Q1  | Story 83d wants the page to say which model wrote a plan. Modules are blind to the model by design (`external-module-ai-bridge.ts:45-49`). Option 1: return the model's display name, never its id or provider, when the call resolved through a task or module binding. Option 2: keep modules blind and drop 83d. Recommendation: option 1, display name only. | Ben                           |
| Q2  | Should a downloaded module's task rows show at all for a module that is installed but disabled? Recommendation: show only enabled modules.                                                                                                                                                                                                                       | Ben                           |
| Q3  | What does a manifest-hash change on platform upgrade do to an enabled module whose manifest already carries `aiTasks`? Must be answered from `node.ts` and the enable path before the plan is approved.                                                                                                                                                          | Plan author                   |
| Q4  | Vision tasks route correctly but cannot send an image until #1696 lands. Is shipping `requires: ["vision"]` before #1696 acceptable? Recommendation: yes, because Meals photo paths already wait on #1696.                                                                                                                                                       | Ben                           |
| Q5  | Should uninstalling a module purge its `module.<id>*` bindings? Out of scope here; the same gap exists today.                                                                                                                                                                                                                                                    | Plan author, file a follow-up |
