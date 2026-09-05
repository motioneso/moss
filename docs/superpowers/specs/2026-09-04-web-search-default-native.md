# Web Search by Default: Model Built-in Search, Brave as the Enhanced Option

**Status:** approved design (Ben, 2026-09-04 live session; answers 1, 2, 1, 1 to the four
questions below). Next step: a `task` issue and a plan-build plan before any code.

**Related:** `packages/web-research` (the `web.search` tool and its Brave provider),
`packages/ai` (capability routing, provider adapters, gateway), `packages/news` (described
topics and source-by-name both gate on web search), spec `2026-09-01-2175-tool-call-discipline`.

## 1. Context

Today web search on an instance means exactly one thing: an admin pasted a Brave Search API key
on the AI providers page (`web.brave_search_api_key`, encrypted at rest). Without it, the
`web.search` assistant tool is unavailable, the News page hides described topics and
source-by-name behind a "Web search needed" gate, and the assistant cannot answer anything
current. Meanwhile every hosted model provider Moss supports for chat (Anthropic, OpenAI, Google)
ships a built-in web search that costs nothing to set up and roughly a cent per search. A fresh
install with one Anthropic key should be able to search the web on day one.

## 2. Goals

- An instance with any Anthropic, OpenAI or Google model configured has web search on with no
  extra key and no admin step.
- Brave stays available as the enhanced option and wins whenever a key is saved.
- Chat uses the model's built-in search inline, and shows sources.
- Features that need a list of links (news described topics, source-by-name, the `web.search`
  tool) keep working unchanged in shape, backed by whichever engine is active.
- One instance-wide switch lets an admin turn built-in search off.

## 3. Non-Goals (v1)

- Search on Ollama or custom OpenAI-compatible endpoints (no built-in search exists there).
- Per-user engine choice, per-user cost caps, or search usage metering.
- Search inside CLI-backed providers (claude, gemini, codex CLI adapters). Chat turns only ever
  run through a CLI engine (`packages/chat/src/live/engine-selection.ts`), and the CLI's own
  search is blocked there: the Claude engines allow only the jarvis MCP tools plus vault reads and
  the permission hook denies everything else. So "the model searches inside its own process" is
  not a path that exists in chat, and this spec does not try to open one. (Amended in fix round
  1 of PR #2280; the original text assumed the CLI could search on its own.)
- New search engines beyond Brave (Google News RSS, GDELT and the like are a separate spec).
- Changing how `web.read` works.

## 4. Resolved Decisions

1. **Brave wins whenever a key is saved** (Ben, question 1, answer 1). No engine picker. The AI
   providers page reports which engine is active in plain words.
2. **Only the user's own chat model counts for built-in search** (Ben, question 2, answer 2).
   The router does not shop around other configured models for one that can search. If the
   user's effective chat model (default, or their override) has no built-in search and there is
   no Brave key, web search is off for that user and the existing "Web search needed" states
   show.
3. **Chat searches through the `web.search` tool, whichever engine is active** (Ben, question
   3, answer 1, amended in fix round 1 of PR #2280). Ben's answer was "chat searches inline",
   meaning the chat request itself carries the provider's search tool. That path is unreachable:
   chat turns run only through a CLI engine, never through the HTTP adapters that carry the
   provider's search tool, and the CLI's own search is denied by the permission hook (non-goal
   3). Offering nothing in that case would leave a user with the Web search chip on and zero
   search happening, a dark feature. So the `web.search` tool is the chat search path for both
   engines: when the engine is Brave it calls the Brave API as today; when the engine is built-in
   search it runs the model-native provider (decision 6) against the actor's own chat model. The
   gateway withholds `web.search` only when the engine is none. The `nativeSearch` request option
   on the HTTP adapters stays for list-shaped callers (decision 6) and for any future non-CLI
   chat path.
4. **On by default with one instance-wide switch** (Ben, question 4, answer 1). A new instance
   setting `web.native_search_enabled` (boolean, default true) lives on the AI providers page as
   "Use your model's built-in web search". Off means only Brave counts. This is a setting in the
   app, not an env var (Ben's 2026-09-01 ruling).
5. **Built-in search is a model capability, not a provider flag.** A new `web-search` value joins
   the capability enum. Model discovery marks it per provider model family (see 5.2), the admin
   can see it on the model row like the other capabilities, and everything downstream asks
   "does this model have web-search" rather than "is this provider Anthropic".
6. **List-shaped callers get a structured search request.** For callers that need links, the
   web-research module gains a second provider, `model-native`, which runs one structured
   request through the router: the model's search tool enabled, a schema asking for up to N
   results with title, url and snippet, plus the provider's own citations merged in as the
   ground truth for urls. Output shape is identical to the Brave provider's, so News and the
   `web.search` tool do not change.
7. **Prompts and results never leave the data context.** Search queries and snippets are private
   content; they are never logged in full, never put in a job payload, and the search tool's
   snippets stay marked as untrusted external content as today.

## 5. Architecture

### 5.1 Settings (`packages/settings`)

- New instance setting key `web.native_search_enabled`, boolean, default `true`, read through the
  existing instance-settings helpers next to `WEB_SEARCH_API_KEY_SETTING`.
- A single resolver `resolveWebSearchEngine(scopedDb, actorChatModel)` returns one of
  `{ engine: "brave" }`, `{ engine: "model-native", model }`, or `{ engine: "none", reason }`,
  in that precedence: Brave key saved; else switch on and the model has `web-search`; else none.
  `reason` is one of `no-key-no-native-model`, `native-disabled`, `model-has-no-search`, and
  drives the settings copy and the News gate text.
- `hasInstanceWebSearchKey` stays for Brave; every caller of "is web search configured" moves
  to the resolver so the answer becomes per user (their chat model) rather than per instance.

### 5.2 AI module (`packages/ai`)

- `aiModelCapabilitySchema` gains `"web-search"`. `RECOGNIZED_CAPABILITIES` and the capability
  route map accept it, but it is never a routed capability on its own (it always rides on the
  chat model, decision 2).
- Model discovery sets `web-search` on: Anthropic Claude 3.5 and later chat models; OpenAI
  models that accept the `web_search` tool on the Responses API (gpt-4.1 family, gpt-4o family,
  o-series and later; the discovery list is data, not code, so new families are one row);
  Google Gemini 2 and later. Ollama, custom and CLI providers never get it. Existing rows are
  re-marked by the next discovery run; an admin can also toggle it on the model row like
  `vision` today, so a mis-detected model is a click, not a release.
- Provider adapters (`adapters/http-api.ts`, `http-api-structured.ts`) accept an optional
  `nativeSearch: true` on a request and add the provider's search tool:
  Anthropic `web_search_20250305` with `max_uses` 5; OpenAI: the Responses API with a
  `web_search` tool (the adapter switches endpoint for that request only, since chat
  completions does not carry the tool); Google: `google_search` grounding. Each adapter maps the
  provider's citations into one normalized `sources: { title, url }[]` on the response.
- The chat path (amended, see decision 3): the gateway asks the resolver per actor and
  withholds `web.search` only when it says `none`. For `brave` and `model-native` the tool is
  offered and its call is audited like any other tool call (metadata only, never the query).
  No chat request sets `nativeSearch`, because no chat turn reaches the HTTP adapters.

### 5.3 Web-research module (`packages/web-research`)

- `providers.ts` gains `createModelNativeProvider(router)` implementing `WebSearchProvider`
  through one structured request (decision 6). `resolveWebSearchProvider(scopedDb, actor)`
  picks Brave or model-native from the resolver; cache stays keyed by Brave key as today plus
  the model id for model-native.
- `web.search` tool availability (its `assistantTools` entry) is computed per actor from the
  resolver, so a user whose model cannot search and who has no Brave key sees the tool absent
  rather than failing.
- Rate limiting: the existing per-host limiter applies to `web.read` only; model-native search
  is limited by `max_uses` per request and the chat rate limits already in the gateway.

### 5.4 News module (`packages/news`)

- `dependencies.availability.hasWebSearch(db)` becomes actor-aware by calling the resolver with
  the actor's effective chat model. No route or DTO shape changes; `webSearchConfigured` keeps
  its name. The "Web search needed" badge and the PrereqGate copy read from `reason`:
  `model-has-no-search` says "Your chat model has no built-in search. Pick one that does under
  Assistant & AI, or ask an admin to add a Brave key." and links to the Chat model picker;
  `native-disabled` and `no-key-no-native-model` keep pointing at AI providers.

### 5.5 Web (`apps/web`)

- AI providers page (admin): the existing Brave key group is retitled "Web search". Its first
  row is the switch "Use your model's built-in web search" (default on). Its status line says one
  of: "On, using Brave" (key saved); "On, using each person's chat model" (switch on, no key);
  "Off. Add a Brave key or turn on built-in search." The Brave key field stays below it,
  described as "Enhanced: consistent results for every model, including local ones."
- Chat: a reply that carries `sources` renders them as a compact source list under the message,
  the same way tool results show a citation row today (reuse the existing citation primitive; no
  new `jds-*` class). Nothing changes for replies without sources.
- Assistant & AI (personal): the Chat model picker shows a "Web search" chip on models that have
  the capability, using the existing capability chip pattern.
- App map: the new switch is declared under the AI providers screen in
  `packages/shared/src/app-map-core.ts`, and the news manifest's `features` entry for described
  topics lists the new remediation wording.

### 5.6 Error handling

- Provider search errors (quota, tool not permitted on this model) are mapped by the adapter to
  a normal model failure with a plain message; the chat reply still returns whatever text the
  model produced, minus sources. The failure increments nothing and disables nothing; a wrong
  capability flag is fixed by the admin toggle in 5.2.
- Model-native provider returning zero urls for a list-shaped caller returns an empty result
  list, which every caller already handles.
- If the switch is turned off while a chat request is in flight, that request completes; the
  next request re-resolves.

## 6. Testing

- Unit: the resolver precedence table (all three outcomes and every `reason`); capability
  marking per provider family; each adapter's request body with `nativeSearch` and its citation
  mapping from a recorded provider response; the model-native provider's schema round trip;
  News availability per actor with and without a searching chat model.
- Integration (scoped test DB, run only through the verify-gate skill): the AI providers switch
  saves and reads back; the `web.search` tool is offered or withheld per actor; News
  personalization reports `webSearchConfigured` per actor.
- e2e: AI providers "Web search" group status lines for the three states; chat reply renders a
  source list from a stubbed provider response; described topics unlocks without a Brave key
  when the fixture model has `web-search`.
- Live proof on dev, recorded on the PR: with no Brave key and an Anthropic chat model, ask the
  assistant something from this week and see sources; add a described topic; then paste a
  Brave key and confirm the status line flips and `web.search` returns to the tool list.

## 7. Exit criteria

- Fresh instance with only an Anthropic (or OpenAI, or Google) key: chat answers a current
  question with sources; News described topics and source-by-name are unlocked.
- Saving a Brave key switches every search path to Brave with no restart; removing it switches
  back.
- The admin switch off leaves Brave-only behaviour identical to today.
- No provider or model name is hardcoded in feature code; `web-search` is data on the model row.
- App map entries for the switch and the new remediation wording ship in the same PR.

## 8. Hard invariants honored

- Provider-agnostic AI: features ask for the `web-search` capability; adapters translate.
- Secrets never escape: the Brave key stays where it is; no new secret is introduced.
- Private by default: search queries and results stay inside the actor's data context and out
  of logs and job payloads.
- No new required env var or hand-edited file: the switch and the key are app settings.
- Module isolation: News reaches search only through the availability dependency it already
  declares; web-research reaches models only through the router.
