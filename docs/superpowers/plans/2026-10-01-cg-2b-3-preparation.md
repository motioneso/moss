# Build plan: classifier gate 2b.3 — one-time default-model preparation

Task issue: #2894. Parent spec: `docs/superpowers/specs/2026-10-01-classifier-gate-for-chat.md`.
Parent plan section: `docs/superpowers/plans/2026-10-01-classifier-gate-for-chat.md` → "2b.3 One-time
default-model preparation" (+ "Contracts and invariants", "Rulings"). Ben's rulings 5, 6 and 8.

Base branch: `cg-2b-3-preparation`, forked from `origin/main` at `9f7109f85` (2b.2, PR 2888).
Build on 2b.2's storage and contracts; do not reshape them. No migration.

Tier: security (stored tool definitions reach a model).

## Goal and boundary

Draft, but do not store, the per-tool classifier preparation for one owner's connection: a one-line
classifier description, the argument declarations derived from the tool's input schema, and a
declarative reply template. The draft is produced by the owner's **current default chat model**,
selected through the existing chat-model selection, reading the discovered tool definitions once.
The owner reviews and edits each draft and saves it through 2b.2's existing route; a cancelled review
persists nothing.

This slice is **backend + contracts only**: no screen (2b.4), no runtime menu or dispatch (2b.5), no
live/UAT proof (2b.6). It adds one prepare endpoint, one pure preparation module and a small
composition-layer port. It does not execute any tool and does not call the classifier.

Determinism boundary: every value the reviewer sees is either derived from the stored definition in
code (argument declarations) or model prose that is validated and only ever shown as an editable
draft; nothing is stored by this slice. Every stored field is written only by 2b.2's explicit save.
The reply text a handled turn renders is 2b.5's concern and never model prose.

## Seams check (each cited from the current tree)

- Owner's default chat model through existing selection:
  `packages/ai/src/repository.ts:1651-1661` (`selectChatModelForUser`), which resolves the user
  override against the admin-configured set and the instance default (`:1663-1712`).
- Structured adapter on an explicit resolved model:
  `packages/ai/src/structured/generate-structured.ts:105-137` (`explicitModel`, `singleAttempt`,
  `maxOutputTokens`, `servedByLabel`), `:139-144` (`GenerateStructuredExplicitModel`),
  `:169-230` (resolve/first attempt), `:224-228` (`singleAttempt`), `:376-397` (AJV validate; no
  repair retry once attempts bound), `:238-284` (provider-kind allow-list; CLI branch).
- Structured-capable provider kinds and the choice-only discriminator:
  `packages/shared/src/ai-types.ts:174-184` (`SORTING_PROVIDER_KINDS`,
  `isSortingProviderKind` — "provider kinds generateStructured can execute"),
  `:186-189` (`isSystemOneProviderKind`).
- Port is composed in the composition root, so integrations stays free of `@moss/ai`:
  `packages/integrations/package.json:12-19` (no `@moss/ai` dependency);
  `packages/module-registry/src/index.ts:1912-1923` (integrations registration),
  `:840-842` (`createCliStructuredAdapter`), `:845` (`new AiRepository()`),
  `:43-66,181-187` (`@moss/ai` imports already present).
- 2b.2 storage/contracts to build on (not reshape): `packages/integrations/src/classifier-settings.ts:40-55`
  (`ClassifierPreparationEntry`/`Map`), `:368-397` (`effectiveClassifierTools`),
  `:400-411` (`classifierPreparationView`), `:215-264` (`parseReviewedEntry`);
  `packages/integrations/src/classifier-fingerprint.ts:28-41`;
  `packages/integrations/src/repository.ts:34-35,136-155,265-306,385-386`;
  `packages/integrations/src/routes.ts:263-328` (classifier routes), `:36-49` (route deps);
  `packages/shared/src/integrations-api.ts:10-19` (descriptor), `:57-88` (preparation + save).
- Curation gate for ordinary availability: `packages/integrations/src/curation.ts:41-64`
  (`effectiveEnabledTools`). Root-combinator skip to mirror: `packages/integrations/src/tool-manifests.ts:32,78-80`.
- Classifier size bounds and template rules to reuse: `packages/module-sdk/src/classifier.ts:16-23`
  (`CLASSIFIER_LIMITS`), `:56-72` (declaration), `:116-136` (template placeholders are dotted paths
  into the output schema ending at a plain type), `:144-190` (required non-enum args must be declared).
- Output envelope whose fields a reply template may use:
  `packages/integrations/src/tool-manifests.ts:34-40` (`IntegrationOutcomeEnvelope` — `status`,
  `action`, `summary`, `detail`), `:268-278` (synthetic tool shape, no `outputSchema` yet).
- Detail projection strips `invoke` today: `packages/integrations/src/discovery.ts:26-78` (line 60).
- Route helpers / error handling: `packages/integrations/src/routes.ts:456-486`.
- Manifest and app map: `packages/integrations/src/manifest.ts:10-73`;
  `packages/shared/src/app-map-core.ts:170-176`; module surface descriptions must be ≤ 240 chars
  (`tests/unit/app-map-integrity.test.ts:139-185`); route syntax check
  (`tests/unit/route-coverage.test.ts:99-105`).
- Abort wiring pattern: `packages/sports/src/routes.ts:349-351` (`request.raw.once("aborted", …)`).

No gate/DB command will run except through `scripts/run-gate.sh` (verify-gate skill). No migration.

## Decisions

### D1 — One prepare endpoint; drafts are transient

`POST /api/integrations/:id/classifier/prepare` (`packages/integrations/src/routes.ts`), added to
`manifest.routes`. Body `{ force?: boolean }` (anything else 400). It loads the connection through
the owner-scoped repository (404 when not owned), requires `classifierEnabled === true` (409 when
off — the switch is what requests preparation, 2b.1), runs the pure preparation module, and returns
the drafts. It **writes nothing**: no draft endpoint, no stored draft. Cancelling (or never
cancelling) leaves the stored preparation map untouched, so a cancelled review persists nothing.

This is the endpoint 2b.4's editor calls; 2b.4 renders it and calls 2b.2's existing
`PUT /api/integrations/:id/classifier/tools/:toolName` to save each reviewed draft.

### D2 — The composition-layer port selects the default chat model; the feature code names none

New `packages/integrations/src/classifier-preparation.ts` defines the port **type** and never calls
`@moss/ai`. New `packages/module-registry/src/classifier-preparation-port.ts` implements it and is
passed into `registerIntegrationsRoutes` from the integrations registration
(`packages/module-registry/src/index.ts:1916-1923`).

```ts
export interface PreparationChatModel {
  readonly id: string;
  readonly providerConfigId: string;
  readonly providerKind: string; // opaque; no provider-name literal in feature code
  readonly providerModelId: string;
}
export type PreparationChatSelection = {
  readonly model: PreparationChatModel;
  /** false when this model cannot produce the required structured draft. */
  readonly structured: boolean;
};

export interface ClassifierPreparationPort {
  /** The owner's current default chat model, or null when none is configured. */
  selectDefaultChatModel(scopedDb: DataContextDb): Promise<PreparationChatSelection | null>;
  /** One bounded structured call on the explicit resolved model. One attempt, no retry. */
  runStructuredDraft(
    scopedDb: DataContextDb,
    input: {
      readonly model: PreparationChatModel;
      readonly schema: Record<string, unknown>;
      readonly prompt: string;
      readonly maxOutputTokens: number;
      readonly signal?: AbortSignal;
    }
  ): Promise<PreparationStructuredOutcome>;
}
export type PreparationStructuredOutcome =
  | { ok: true; object: unknown; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; error: "needs_config" | "provider_error" | "validation_failed" | "aborted" };
```

The composition implementation: `selectDefaultChatModel` calls
`new AiRepository().selectChatModelForUser(scopedDb)` and sets `structured:
isSortingProviderKind(model.provider_kind)`. `runStructuredDraft` calls `generateStructured` with
`explicitModel` mapped from the descriptor, `service: MODULE_WORKER_SERVICE_KEY`,
`singleAttempt: true`, `servedByLabel: "main"`, and `{ repository, cipher: createAiSecretCipher(),
createCliStructuredAdapter: deps.createCliStructuredAdapter }`. It never routes by service, never
falls back to the classifier or another model, and never touches the HTTP/CLI adapter files (3.6a
collision) — it only calls `generateStructured`.

### D3 — Unsupported selection is a setup failure, never a silent switch

`prepareClassifierToolDrafts` returns a whole-run `status`:
`"ok" | "unavailable" | "unsupported_model"`. `unavailable` when `selectDefaultChatModel` returns
null; `unsupported_model` when `selection.structured` is false. Both make **zero** draft calls and
return no drafts. The route returns 200 with that body; 2b.4 shows a setup failure and the
remediation from D8. There is no second model and no classifier fallback.

### D4 — Targets, reuse and call counts

Targets = discovered tools that are ordinary-chat available (`effectiveEnabledTools`,
`curation.ts:41-64`) and whose `inputSchema` has no root combinator (mirror of
`tool-manifests.ts:78-80`). A target is **reused** (0 model calls) when the stored map already has an
entry whose `definitionFingerprint` equals `toolDefinitionFingerprint(tool)` and `force` is false.
Otherwise it is drafted once. So: re-enabling unchanged reviewed definitions costs nothing; a new or
changed definition drafts once; `force` re-drafts every target (the explicit, user-visible
re-preparation that incurs cost again). No automatic retry: `runStructuredDraft` is `singleAttempt`,
a failed tool gets exactly one call, and only a later explicit prepare call retries it.

Per-call bounds: `INTEGRATION_CLASSIFIER_PREPARE_MAX_TOOLS = 20` targets drafted per request
(`remaining` reports how many eligible targets were left, so 2b.4 loops after saving),
`INTEGRATION_CLASSIFIER_PREPARE_CONCURRENCY = 2` concurrent draft calls,
`INTEGRATION_CLASSIFIER_PREPARE_MAX_OUTPUT_TOKENS = 700`, and
`INTEGRATION_CLASSIFIER_MAX_DEFINITION_CHARS = 8000` per sent definition (over that, the tool is
marked failed `definition_too_large`, never truncated and never thrown — the structured prompt
itself caps at 64 KiB, `schema-bounds.ts:4`).

### D5 — The model drafts only the description and the reply template

The structured output schema is exactly:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["description", "replyTemplate"],
  "properties": {
    "description": { "type": "string", "minLength": 1, "maxLength": 200 },
    "replyTemplate": { "type": "string", "minLength": 1, "maxLength": 200 }
  }
}
```

Argument declarations are **derived in code** by `derivePreparationArguments(inputSchema)`: a
required argument whose schema `enum` is non-empty and all-string becomes `{ kind: "enum", values }`
(capped at `CLASSIFIER_LIMITS.candidates`); every other required argument becomes `{ kind: "extract" }`;
optional arguments are omitted. This is why the model cannot invent enum options (D6): fixed choices
come from the schema, not from prose. A `candidates` argument needs a real candidate source, which is
2b.5's, so the draft never invents one; 2b.4 lets the owner edit an argument to `candidates` once a
source exists.

The reply template may use only the envelope fields `{status}`, `{action}`, `{summary}`
(`tool-manifests.ts:34-40`); `{detail}` is unknown-typed and rejected by the module-sdk template
check when 2b.5 builds the declaration, so the boundary validator rejects it too. The model never
writes executable template code and never approves a tool.

### D6 — Untrusted definitions: one bounded prompt, a worked example, a boundary validator

The prompt builder sends only the six definition fields the 2b.2 fingerprint already covers
(`name`, `description`, `group`, `inputSchema`, `readOnly`, `idempotent`, `destructive`) — never the
connection row. Transport URL, base URL, credential placement, credential envelope, `invoke`,
headers, secrets and any other extra field on the discovered object are dropped by construction.
Device inventories and raw tool responses are never fetched or included; this slice invokes no tool.
The definition is JSON under an `UNTRUSTED DATA:` marker, with instruction text under 150 words and
one worked example. Output is validated by the structured call's AJV (with
`additionalProperties: false`) and then by a boundary validator:

```ts
export function parsePreparationDraft(
  raw: unknown
): ParseResult<{ description: string; replyTemplate: string }>;
```

which rejects anything not one line, over 200 chars, containing a placeholder outside
`{status}/{action}/{summary}`, containing an unmatched brace, or not an object. A rejected draft
makes the tool `invalid_draft` and nothing is stored. Injection text in a description or schema is
data the model may echo back as prose only; it can change no field list, no enum value and no code.

### D7 — Response contract (transient; no persistence)

`packages/shared/src/integrations-api.ts`:

```ts
export type IntegrationClassifierDraftFailure =
  | "provider_error"
  | "invalid_draft"
  | "aborted"
  | "definition_too_large";
export interface IntegrationClassifierToolDraft {
  readonly toolName: string;
  readonly definitionFingerprint: string; // current fingerprint the draft is bound to
  readonly description: string;
  readonly arguments: Readonly<Record<string, IntegrationClassifierArgument>>;
  readonly replyTemplate: string;
}
export interface IntegrationClassifierToolDraftFailure {
  readonly toolName: string;
  readonly reason: IntegrationClassifierDraftFailure;
}
export interface PrepareIntegrationClassifierResponse {
  readonly disclosure: IntegrationClassifierPreparationDisclosure;
  readonly status: "ok" | "unavailable" | "unsupported_model";
  readonly drafts: readonly IntegrationClassifierToolDraft[];
  readonly reused: readonly string[];
  readonly failed: readonly IntegrationClassifierToolDraftFailure[];
  readonly remaining: number;
}
```

A draft carries the fingerprint at draft time, so 2b.2's existing save rejects a replay of an old
approval with 409 after a definition change (already tested in 2b.2). The prepare route makes zero
repository writes; the existing `PUT` is the only writer.

### D8 — Disclosure, manifest, app map

`INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE` (new const in `integrations-api.ts`, imported by
2b.4): names that the discovered names/descriptions/input schemas/annotations are sent to the owner's
default chat model; that a hosted model sends them to its provider; that preparing and re-preparing
use model usage and may cost money (no price is quoted); and that transport addresses, sign-in
details, headers, secrets, device lists and raw tool results are not sent.

`packages/integrations/src/manifest.ts`: add the prepare route; add feature
`integrations.connection_classifier_preparation` (≤ 240 chars) describing preparation, cost, privacy
and reuse; nest prerequisite errors `integrations.classifier_preparation.no_default_model` and
`integrations.classifier_preparation.model_cannot_draft`, each with remediation
`integrations.classifier_preparation.choose_chat_model`
(`path: "/settings?section=assistant"`, `scope: "user"`).

`packages/shared/src/app-map-core.ts`: extend the `integrations` setting description with one
sentence naming preparation, the model/cost/privacy disclosure and the setup-failure recovery. (This
is a capability sentence, not a screen-control claim; 2b.2's security review dropped its core-map
sentence because that described a UI control, which 2b.3 does not. Kept because the parent section
requires the core map update; 2b.4 will extend it.)

## Tasks (each commits green; explicit `git add` paths)

1. **Shared contracts.** Add D7 types + D8 disclosure const to
   `packages/shared/src/integrations-api.ts`. No existing interface changes (no fixture churn).
2. **Pure module + export.** `packages/integrations/src/classifier-preparation.ts`
   (port types, `buildPreparationDefinitionPayload`, `buildPreparationPrompt`,
   `preparationDraftSchema`, `parsePreparationDraft`, `derivePreparationArguments`,
   `preparationTargets`, `prepareClassifierToolDrafts`); export from `index.ts`.
3. **Route.** `packages/integrations/src/routes.ts`: `preparationPort?` dep, the `POST …/prepare`
   route, body parsing, abort wiring, 404/409.
4. **Composition port.** `packages/module-registry/src/classifier-preparation-port.ts`; pass it into
   `registerIntegrationsRoutes` (`index.ts:1916-1923`).
5. **Manifest + app map.** D8.
6. **Tests.** `tests/unit/integrations-classifier-preparation.test.ts` (below).

## Test cases (behaviour + the failure each catches)

`tests/unit/integrations-classifier-preparation.test.ts` (expected exit 0):

- **Port routing.** `selectDefaultChatModel` is called once; every `runStructuredDraft` receives the
  exact selected model descriptor; the module source and its inputs contain no provider/model name
  literal. (Catches a silent route to another model.)
- **Unsupported selection.** `structured: false` → `status:"unsupported_model"`; `null` →
  `status:"unavailable"`; zero `runStructuredDraft` calls in both. (Catches a fallback to another
  model or the classifier.)
- **Call counts per version.** Fresh tools draft once each; a current stored entry → `reused`, zero
  calls; `force` → one call again. `singleAttempt` means a provider error is one call only. (Catches
  an automatic retry that repeats the setup charge.)
- **Boundary + malformed drafts.** A non-object, a multiline or over-length description, a
  `{detail}` placeholder, an unmatched brace, and extra JSON fields each yield `invalid_draft` and no
  draft; well-formed output yields a draft. (Catches unvalidated model prose reaching the review.)
- **Malicious definitions.** A tool description/input schema carrying instructions and a fake draft
  echoing them still only passes through the field validator; no field list, enum value or code is
  taken from the text; the prompt carries the untrusted-data marker and its instructions are under
  150 words. (Catches prompt-injection controlling the declared contract.)
- **Secret stripping (negative control).** A connection row whose `url`, `baseUrl`,
  `credentialPlacement` carry credential material, and a discovered tool object carrying an
  `Authorization` header, an `apiKey` and an `invoke` recipe, produce a payload containing none of
  them. Observe failing with the field whitelist replaced by a spread of the connection/tool.
- **No device inventory (negative control).** A discovered tool carrying `devices`/`deviceInventory`
  and a listing `invoke` contributes neither to the payload, and this slice never calls a tool.
  Observe failing with the whitelist removed.
- **Reused / cancelled / edited / rejected.** `reused` lists current entries; the pure module has no
  repository dependency and the route records zero writes for prepare, so a cancelled or rejected
  review stores nothing; an edited draft is whatever the client later sends to 2b.2's save.
- **Replay of an old approval.** A draft's `definitionFingerprint` equals the definition at draft
  time and differs after the definition changes (2b.2's save then 409s; that behaviour is already
  covered by 2b.2).
- **Route-level (Fastify + fake repository + fake port).** prepare returns drafts with no write;
  `force` non-boolean → 400; switch off → 409; unknown/other-owner id → 404; abort mid-run marks the
  remaining tools `aborted`.
- **Bounds.** The 21st target is left with `remaining: 1`; an over-size definition is
  `definition_too_large`; concurrency never exceeds 2.

The two negative controls are the brief's required observed-failing tests; the plan records the
removal and rerun in the PR body.

## Verification (unpiped; expected exit code beside each)

```bash
pnpm exec vitest run tests/unit/integrations-classifier-preparation.test.ts > /tmp/cg2b3-unit.log 2>&1; echo "EXIT=$?"   # 0
pnpm format:check > /tmp/cg2b3-fmt.log 2>&1; echo "EXIT=$?"        # 0
pnpm lint > /tmp/cg2b3-lint.log 2>&1; echo "EXIT=$?"               # 0
pnpm typecheck > /tmp/cg2b3-tsc.log 2>&1; echo "EXIT=$?"           # 0
pnpm check:file-size > /tmp/cg2b3-size.log 2>&1; echo "EXIT=$?"    # 0
pnpm build:app-map > /tmp/cg2b3-map.log 2>&1; echo "EXIT=$?"       # 0
scripts/run-gate.sh start            # then background: scripts/run-gate.sh wait --follow   (exit 0)
git diff --check                     # 0
```

No piped gate commands. The named unit file matches the parent plan's slice-2b verification row.

## Kill gate

If the owner's default chat model turns out not to be resolvable through
`selectChatModelForUser` for a connection owner (for example, because connection rows can belong to
an actor with no chat identity), stop and report to the coordinator before adding any second model
path. Owner of that call: the coordinator.

## Out of scope / deferred

- The review/edit screen (2b.4); runtime menu, candidate sources, candidate listing and reply
  rendering (2b.5); the assembled integrations-screen proof (2b.6).
- Risk is not drafted. Ruling 5 keeps risk a user review; the `tools` in `IntegrationDetail` already
  expose the server hints (`readOnly`/`destructive`/`idempotent`) for 2b.4 to show as a suggestion.
- No `candidates` argument source, no device/area listing call, no candidate cache — all 2b.5.
- No change to `packages/ai` (adapter files are 3.6a's; this slice only calls `generateStructured`).
- No migration.

## Release note (for the PR)

Category: N/A (internal preparation endpoint and contracts; the screen ships in 2b.4).
