# Implementation Plan: Web Search by Default via Model Built-in Search (#2228)

Spec: `docs/superpowers/specs/2026-09-04-web-search-default-native.md`
Task issue: #2228 ("Build: web search by default via the model's built-in search (spec 2026-09-04)")

## Seams Check (file:line verified on this branch)

- Stored settings keys and Brave Search key definition:
  `packages/settings/src/instance-settings-keys.ts:29-42` defines the instance settings registry and the key for Brave Search.
- Setting retrieval and decryption functions:
  `packages/settings/src/web-search-key.ts:50-103` reads the stored envelope and returns status without leaking secrets.
- Admin setting routes for web search:
  `packages/settings/src/web-search-key-routes.ts:52-115` provides GET, PUT, and DELETE endpoints for web search settings.
- Model capabilities and discovery list:
  `packages/module-sdk/src/ai-capabilities.ts:6-22` lists recognized capabilities.
  `packages/shared/src/ai-api.ts:41-44` defines the capability schema.
  `packages/ai/src/model-discovery.ts:242-266` infers tiers and capabilities from model identifiers.
- Provider HTTP adapters:
  `packages/ai/src/adapters/http-api.ts:123-194` builds chat request payloads for Anthropic, OpenAI, and Google.
  `packages/ai/src/adapters/http-api-structured.ts:85-155` builds structured output payloads.
  `packages/ai/src/structured/generate-structured.ts:51-76` orchestrates structured model calls.
- Web research provider contracts:
  `packages/web-research/src/manifest.ts:50-70` defines the assistant search tool.
  `packages/web-research/src/providers.ts:21-24` defines the search provider interface.
  `packages/web-research/src/providers.ts:155-175` resolves the active search provider.
- News availability dependency and gate:
  `packages/module-registry/src/index.ts:2147-2160` wires web search availability into the News module.
  `packages/news/src/personalization-routes.ts:326-364` handles personalization requests and checks search availability.
  `packages/news/src/settings/describe-topics.tsx:36-46` renders the prerequisite gate for described topics.
  `packages/news/src/manifest.ts:485-511` defines features, prerequisites, and remediations for News.
- Admin and user settings interface:
  `apps/web/src/settings/settings-web-search-key-group.tsx:48-111` renders the web search card in admin settings.
  `apps/web/src/settings/settings-ai-pane.tsx:320-355` renders the chat model override picker.
  `apps/web/src/chat/markdown-message.tsx:36-61` renders assistant messages and citations.
  `packages/shared/src/app-map-core.ts:168-183` declares the AI providers settings surface in the app map.

## Determinism Boundary

- All user interface feedback, status indicators, and prerequisite gates render directly from database state and deterministic resolver results.
- The language model is used solely for natural conversation and generating structured search result items when requested.
- Guidance text across all components and manifests stays well under 150 words.
- Structured search items produced by language models undergo schema validation and citation verification before reaching callers.

## Kill Gate after Phase 1

Owner: this session, reporting back upon completion of Phase 1.
If the resolver tests fail to correctly establish precedence between Brave Search and built-in search, or if the setting cannot be persisted cleanly, implementation stops immediately to address the data model before touching provider adapters.

## Phase 1: Core Capability and Settings Resolver

### Tasks

1. Register `web-search` capability in core types:
   - File: `packages/module-sdk/src/ai-capabilities.ts`
     Add `"web-search"` to `AiModelCapability` and `AI_MODEL_CAPABILITIES`.
   - File: `packages/shared/src/ai-api.ts`
     Add `"web-search"` to `aiModelCapabilitySchema`.
2. Register instance setting key:
   - File: `packages/settings/src/instance-settings-keys.ts`
     Add `web.native_search_enabled` to `INSTANCE_SETTINGS_REGISTRY`.
     Export `WEB_NATIVE_SEARCH_ENABLED_SETTING = "web.native_search_enabled"`.
3. Implement engine resolver:
   - File: `packages/settings/src/web-search-engine-resolver.ts`
     Export function signature:

     ```ts
     export type WebSearchEngineResolution =
       | { readonly engine: "brave" }
       | { readonly engine: "model-native"; readonly model: WebSearchActorChatModel }
       | {
           readonly engine: "none";
           readonly reason: "no-key-no-native-model" | "native-disabled" | "model-has-no-search";
         };

     export interface WebSearchActorChatModel {
       readonly id?: string;
       readonly providerModelId?: string;
       readonly capabilities: readonly string[];
     }

     export async function resolveWebSearchEngine(
       scopedDb: DataContextDb,
       actorChatModel: WebSearchActorChatModel | null | undefined,
       env?: NodeJS.ProcessEnv
     ): Promise<WebSearchEngineResolution>;
     ```

   - Export helper functions to read and write the native search switch:
     ```ts
     export async function readNativeSearchEnabled(scopedDb: DataContextDb): Promise<boolean>;
     export async function setNativeSearchEnabled(
       scopedDb: DataContextDb,
       repository: SettingsRepository,
       input: { enabled: boolean; actorUserId: string; requestId: string }
     ): Promise<void>;
     ```

4. Update web search setting contract and routes:
   - File: `packages/shared/src/web-search-api.ts`
     Add `nativeSearchEnabled: boolean` to `WebSearchKeyStatusDto`.
     Update `PutWebSearchKeyRequest` to accept `{ apiKey?: string; nativeSearchEnabled?: boolean }`.
   - File: `packages/settings/src/web-search-key.ts`
     Update `getWebSearchKeyConfig` to return `nativeSearchEnabled`.
   - File: `packages/settings/src/web-search-key-routes.ts`
     Update `PUT /api/admin/settings/web-search` to handle saving the switch when provided.
5. Unit tests:
   - File: `tests/unit/web-search-engine-resolver.test.ts`
     Assert resolver precedence:
     - Returns brave when Brave key is present regardless of switch or chat model.
     - Returns native-disabled when Brave key is absent and switch is false.
     - Returns model-native when Brave key is absent, switch is true, and chat model has web-search.
     - Returns model-has-no-search when Brave key is absent, switch is true, and chat model lacks web-search.
     - Returns no-key-no-native-model when Brave key is absent, switch is true, and chat model is null.
       Why it fails if broken: any inverted precedence or wrong reason tag triggers an assertion failure.

Verification:

```bash
pnpm exec vitest run tests/unit/web-search-engine-resolver.test.ts > /tmp/phase1-unit.log 2>&1; echo "EXIT=$?"
```

Expected exit code: 0.

## Phase 2: Model Discovery and Capability Marking

### Tasks

1. Update discovery inference:
   - File: `packages/ai/src/model-discovery.ts`
     In `inferModel`:
     Check provider family and version:
     - Anthropic: Claude 3.5 and later models receive `web-search`.
     - OpenAI: gpt-4.1 family, gpt-4o family, and o-series receive `web-search`.
     - Google: Gemini 2 and later receive `web-search`.
     - Ollama, custom, and CLI providers do not receive `web-search`.
   - File: `packages/ai/src/provider-validation.ts`
     Mirror the capability checks in `suggestModel`.
2. Update web model edit form:
   - File: `apps/web/src/settings/settings-ai-edit-model-form.tsx`
     Map `web-search: "Web search"` in `CAP_SHORT`.
3. Unit tests:
   - File: `tests/unit/ai-model-discovery-web-search.test.ts`
     Test each provider model family:
     - claude-3-5-sonnet, claude-3-7-sonnet, claude-4-opus get web-search.
     - claude-3-opus and claude-3-haiku do not get web-search.
     - gpt-4o, gpt-4o-mini, gpt-4.1, o1, o3-mini get web-search.
     - gpt-4, gpt-3.5-turbo do not get web-search.
     - gemini-2.0-flash, gemini-2.5-pro get web-search.
     - gemini-1.5-pro does not get web-search.
     - CLI models, Ollama models, and custom models do not get web-search.
       Why it fails if broken: regression in capability inference immediately fails family assertions.

Verification:

```bash
pnpm exec vitest run tests/unit/ai-model-discovery-web-search.test.ts > /tmp/phase2-unit.log 2>&1; echo "EXIT=$?"
```

Expected exit code: 0.

## Phase 3: Provider Adapters with Native Search

### Tasks

1. Update adapter inputs and results:
   - File: `packages/ai/src/chat-adapter.ts`
     Add `nativeSearch?: boolean` to `GenerateChatInput`.
     Add `sources?: readonly { readonly title: string; readonly url: string }[]` to chat output.
   - File: `packages/ai/src/adapters/http-api-structured.ts`
     Add `nativeSearch?: boolean` to `GenerateStructuredProviderInput`.
     Add `sources?: readonly { readonly title: string; readonly url: string }[]` to `StructuredProviderResult`.
2. Implement Anthropic web search in adapter:
   - File: `packages/ai/src/adapters/http-api.ts`
     When `nativeSearch` is true:
     Include Anthropic tool `{ type: "web_search_20250305", name: "web_search", max_uses: 5 }`.
     Extract citation objects from content blocks and normalize to `{ title, url }`.
3. Implement OpenAI web search in adapter:
   - File: `packages/ai/src/adapters/http-api.ts`
     When `nativeSearch` is true:
     Switch endpoint to `/v1/responses` with tool `{ type: "web_search" }`.
     Extract text content and URL citations from annotations.
4. Implement Google web search in adapter:
   - File: `packages/ai/src/adapters/http-api.ts`
     When `nativeSearch` is true:
     Include tool `{ google_search: {} }`.
     Extract grounding metadata chunks into normalized `{ title, url }`.
5. Update structured requests to support native search:
   - File: `packages/ai/src/adapters/http-api-structured.ts`
     Pass native search configuration when `nativeSearch` is true.
     Include normalized sources in structured results.
6. Error handling:
   - Handle provider quota or tool errors gracefully by returning model text without crashing.
7. Unit tests:
   - File: `tests/unit/ai-adapter-native-search.test.ts`
     Verify request shapes and citation extraction across Anthropic, OpenAI, and Google responses.
     Why it fails if broken: checks assert exact wire payloads and citation normalization.

Verification:

```bash
pnpm exec vitest run tests/unit/ai-adapter-native-search.test.ts > /tmp/phase3-unit.log 2>&1; echo "EXIT=$?"
```

Expected exit code: 0.

## Phase 4: Model-Native Provider in Web-Research

### Tasks

1. Implement model-native search provider:
   - File: `packages/web-research/src/providers.ts`
     Export `createModelNativeProvider(runner: ModelNativeSearchRunner): WebSearchProvider`.
     Runs structured search request asking for title, URL, snippet, and merges provider citations.
     Returns empty list when zero results are found.
2. Update web research provider resolver:
   - File: `packages/web-research/src/providers.ts`
     Support resolving model-native search provider when active.
     Maintain provider cache keyed by Brave key or model identifier.
3. Update gateway tool listing:
   - File: `packages/ai/src/gateway/gateway.ts`
     Omit `web.search` from assistant tools when the actor has model-native search active.
     Include `web.search` when Brave is the active engine.
     Hide `web.search` when no search engine is available.
4. Unit tests:
   - File: `tests/unit/web-research-model-native.test.ts`
     Assert structured search prompt formation, result parsing, and citation merging.
     Why it fails if broken: catches broken result mappings and missing citations.

Verification:

```bash
pnpm exec vitest run tests/unit/web-research-model-native.test.ts > /tmp/phase4-unit.log 2>&1; echo "EXIT=$?"
```

Expected exit code: 0.

## Phase 5: News Module Integration

### Tasks

1. Actor-aware web search dependency in News:
   - File: `packages/module-registry/src/index.ts`
     Pass actor-aware `hasWebSearch` implementation resolving through `resolveWebSearchEngine`.
   - File: `packages/news/src/personalization-routes.ts`
     Include `webSearchReason` in availability metadata.
2. Update prerequisite gate copy:
   - File: `packages/news/src/settings/describe-topics.tsx`
     When `reason === "model-has-no-search"`:
     Display "Your chat model has no built-in search. Pick one that does under Assistant & AI, or ask an admin to add a Brave key." with link to `/settings?section=assistant`.
     For other failure reasons, retain the link to AI providers.
3. Update News manifest features and remediations:
   - File: `packages/news/src/manifest.ts`
     Add described topics feature declaration and error remediation matching the new wording.
4. Unit tests:
   - File: `tests/unit/news-availability-web-search.test.ts`
     Assert that News availability correctly reports search readiness per actor chat model.
     Why it fails if broken: catches unauthorized access or incorrect gate text mapping.

Verification:

```bash
pnpm exec vitest run tests/unit/news-availability-web-search.test.ts > /tmp/phase5-unit.log 2>&1; echo "EXIT=$?"
```

Expected exit code: 0.

## Phase 6: User Interface and App Map Truthfulness

### Tasks

1. Update AI providers admin page:
   - File: `apps/web/src/settings/settings-web-search-key-group.tsx`
     Retitle group to "Web search".
     Add switch "Use your model's built-in web search" with default true.
     Show three distinct status lines:
     - "On, using Brave"
     - "On, using each person's chat model"
     - "Off. Add a Brave key or turn on built-in search."
       Describe Brave Search field as "Enhanced: consistent results for every model, including local ones."
2. Update Chat model picker:
   - File: `apps/web/src/settings/settings-ai-pane.tsx`
     Display "Web search" chip for models with the capability.
3. Render search sources in chat replies:
   - File: `apps/web/src/chat/markdown-message.tsx`
     Render compact citation row using `.source-chips` primitive when reply carries sources.
4. App map truthfulness:
   - File: `packages/shared/src/app-map-core.ts`
     Update `aiproviders` settings screen description to declare the new built-in search switch.
5. Verification of UI tokens and catalogue:
   - Run token and UI catalogue checks.

Verification:

```bash
pnpm check:design-tokens > /tmp/phase6-tokens.log 2>&1; echo "EXIT=$?"
pnpm check:ui-catalogue > /tmp/phase6-ui.log 2>&1; echo "EXIT=$?"
pnpm build:app-map > /tmp/phase6-appmap.log 2>&1; echo "EXIT=$?"
```

Expected exit code: 0.
