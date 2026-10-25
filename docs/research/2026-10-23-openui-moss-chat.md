# OpenUI for visual Moss chat responses

Research date: 2026-10-23. Scope: upstream source and documentation plus Moss checkout integration analysis; no runtime evaluation, dependency installation, or Moss implementation. Source snapshot: [`c9f93b6e57d05b19b9781846769da530c6741dc4`](https://github.com/thesysdev/openui/commit/c9f93b6e57d05b19b9781846769da530c6741dc4). Released `@openuidev/react-lang@1.0.1` tag points to [`eb20708b9cc41afced5625e99e6ce8ec2f8a5435`](https://github.com/thesysdev/openui/tree/eb20708b9cc41afced5625e99e6ce8ec2f8a5435). Main contains changes beyond that release; pin and validate a published version before adopting.

## Assessment

OpenUI is a promising presentation layer for selectively richer chat responses. Its useful unit for Moss is `@openuidev/react-lang` and a small Moss-owned component catalog. It can render inside an existing message bubble without adopting OpenUI's chat shell, storage, backend routing, or hosted gateway. This is an integration recommendation based on the interfaces below, not verified Moss compatibility.

A sensible first experiment would render budget comparisons, option comparisons, and daily-plan summaries using a small set of cards, metrics, tables, charts, and timelines. Keep normal prose, citations, copy/export, and a readable fallback. Start with presentation of data Moss has already retrieved; add actions and editable forms only after persistence and authorization semantics are designed.

## How it works

1. Application authors register React components with `defineComponent`, a name, a description, and a Zod v4 prop schema.
2. `createLibrary` combines them; the library generates model instructions from the allowed component signatures.
3. A model emits OpenUI Lang, a compact declarative language with positional arguments and named statements.
4. `<Renderer library={...} response={text} isStreaming={...} />` parses and progressively renders that text using registered components.

The renderer API takes a string, rather than a required provider-specific network stream. Existing streaming transport can feed accumulated text into it. The framework-independent `@openuidev/lang-core` provides parsing and prompt generation without importing React components into the backend. Sources: [React quick start/API](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/packages/react-lang/README.md), [Renderer interface and component lookup](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/packages/react-lang/src/Renderer.tsx), [library implementation](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/packages/lang-core/src/library.ts).

## Fit and implementation implications

| Area                   | Verified upstream capability                                                                                                                                  | Implication for Moss                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing design system | React render functions are supplied by the app; official shadcn example wraps existing primitives.                                                            | Define a narrow catalog backed by Moss primitives and tokens. OpenUI's own visual styling is optional.                                      |
| Streaming              | Incremental parser caches completed statements; forward references resolve as chunks arrive.                                                                  | Exercise incomplete cards, cancellation, reconnects, and mobile layout; keep prose readable while UI fills in.                              |
| Plain text plus UI     | Prompt option `inlineMode` allows text with fenced OpenUI Lang blocks; parser extracts fenced code.                                                           | Preserve/render prose separately around visual blocks; do not assume the standalone renderer renders surrounding Markdown.                  |
| Providers              | Backend prompt generation works with the caller's model API; hosted Gateway is another path.                                                                  | Existing model routing can remain. Actual language-following reliability must be measured on Moss's configured models.                      |
| State and persistence  | `onStateUpdate` emits form state; `initialState` restores it. `buildMessage`/`parseMessage` wrap content, context, and library attributes in a stored string. | Host owns durable storage and versioning. Raw program replay is possible, but interactive state does not persist automatically.             |
| Actions                | `onAction` receives conversation, link, and custom-action events. `Query`/`Mutation` can use a supplied `toolProvider`.                                       | Keep actions in Moss's existing authorization/approval path; a visual button is not authorization. Renderer-only experiment can omit tools. |
| Failures               | Structured parse/runtime/tool errors reach `onError`; parser is permissive and renders usable portions.                                                       | Supply fallback content and bounded recovery; schema-described output is not guaranteed valid.                                              |

Sources: [custom design-system example](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/docs/content/integrations/shadcn-ui.mdx), [renderer behavior](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/docs/content/docs/openui-lang/renderer.mdx), [runtime state/parser](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/packages/react-lang/src/hooks/useOpenUIState.ts), [prompt options](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/docs/content/docs/openui-lang/system-prompts.mdx), [message protocol](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/docs/content/docs/openui-lang/message-protocol.mdx), [actions](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/docs/content/docs/openui-lang/actions.mdx).

## Dependencies, maturity, and limitations

- MIT license permits use, modification, and distribution with its notice retained. The source snapshot reports `react-lang` 1.0.1 and `react-ui` 0.18.1. The React runtime and full UI package are separate maturity/version surfaces. [License](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/LICENSE), [runtime manifest](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/packages/react-lang/package.json), [UI manifest](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/packages/react-ui/package.json).
- Compatibility docs differ: React runtime README says React >=19, but the current and 1.0.1-tag manifests accept `react: "*"`; monorepo catalog uses React 18.3.1 or 19. Schemas must use Zod v4 APIs, available through Zod 3.25+ as `zod/v4`. Verify the exact published package with Moss rather than inferring compatibility from one declaration. [README](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/packages/react-lang/README.md), [release manifest](https://github.com/thesysdev/openui/blob/eb20708b9cc41afced5625e99e6ce8ec2f8a5435/packages/react-lang/package.json), [catalog](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/pnpm-workspace.yaml).
- The built-in UI package includes tables, charts, forms, layout and numerous Radix/D3/Markdown dependencies. A custom catalog using only `react-lang` avoids adopting that whole styling/component stack, although final bundle impact still needs measurement. [built-in catalog](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/packages/react-ui/src/genui-lib/openuiLibrary.tsx), [UI dependencies](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/packages/react-ui/package.json).
- Restricted action slots currently affect the prompt and JSON Schema only, and are explicitly **not runtime-enforced**. Do not treat component/action schemas as authorization. [upstream warning](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/docs/content/docs/openui-lang/actions.mdx#slots-that-take-only-some-actions).
- Model output can still name unknown components, omit required props, or truncate the program. Upstream explicitly discusses those failure modes and offers hosted Gateway/Autofix/monitoring, but those services are optional integrations rather than a requirement of basic parsing/rendering. [production guidance](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/docs/content/docs/production.mdx).
- The headline “up to 67% fewer tokens” is upstream's seven-scenario output-format benchmark, not an end-to-end Moss latency, total prompt-token, cost, or reliability measurement. Its reported combined output saving is approximately 53% versus one JSON format. [benchmark table and method link](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/README.md#token-efficiency-benchmarks).
- Network behavior requires explicit review. The React web entry auto-mounts devtools under `NODE_ENV=development`; its loader dynamically imports a jsDelivr bundle pinned to major `0`. This behavior is present at the 1.0.1 release tag too. The base observability package is an in-process event bus, while cloud telemetry uses a separate initialized package. Do not describe adopting the runtime as automatically making no external network requests in every mode. [web entry](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/packages/react-lang/src/index.ts), [release bootstrap](https://github.com/thesysdev/openui/blob/eb20708b9cc41afced5625e99e6ce8ec2f8a5435/packages/react-lang/src/devtoolsBootstrap.ts), [CDN loader](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/packages/devtools/src/cdn.ts), [base bus](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/packages/observability/src/observability.ts), [cloud setup](https://github.com/thesysdev/openui/blob/c9f93b6e57d05b19b9781846769da530c6741dc4/packages/observability-cloud/README.md).

## Fit with Moss today

> 🧠 **From Hindsight memory (Component map)** — Moss has an authored visual system and separate chat/AI infrastructure. Current source and design documentation were checked before using that context below.

Moss source inspected at `8814c9b43101e40619cf1e89055cf4eab2a6ce04`; this is a checkout snapshot, not a claim about the latest deployed app.

- The web app already uses React 19 and `@moss/ui` ([manifest](../../apps/web/package.json)). The design system requires authored shared primitives and semantic tokens ([design reference](../design-system.md)). Registering curated Moss components is a better fit than importing OpenUI's whole visual kit.
- `RecordRow` separates assistant replies from action-request and workflow approval cards. Replies render through `MarkdownMessage`, which uses GFM Markdown and source chips ([message row](../../apps/web/src/chat/message-row.tsx), [Markdown renderer](../../apps/web/src/chat/markdown-message.tsx)). An optional visual reply block could sit alongside that existing presentation.
- `ChatMessageDto` exposes `body`; live `TranscriptRecord` exposes `text`. Neither currently declares a general visual-response field. `serializeMessage` explicitly reconstructs known metadata ([shared contracts](../../packages/shared/src/chat-api.ts), [history serializer](../../packages/chat/src/route-serializers.ts)). A deliberate output contract and streaming/history integration are required; adding a renderer alone does not make Moss generate visual responses or preserve them on reload.
- Existing meeting replies disable remote images, scheduled task reports have a special text path, and citations/freshness/feedback live around reply content. Any eventual integration must preserve those behaviors rather than replacing the whole message row.

## Recommendation and bounded next experiment

**Proceed to a small prototype proposal.** The compelling capability is letting Moss choose a useful visual representation from a curated vocabulary while preserving the app's own style.

| User asks                       | Candidate visual response                                   |
| ------------------------------- | ----------------------------------------------------------- |
| “What does tomorrow look like?” | Timeline of meetings, tasks, and open gaps                  |
| “Where did my money go?”        | Category breakdown, amounts, and one clear comparison chart |
| “Help me compare these options” | Side-by-side comparison with explicit criteria              |

Suggested first scope: renderer-only, read-only visual answers, a small set of Moss-authored components, ordinary prose alongside them, and no generated arbitrary HTML/CSS/JavaScript. Existing tool/data access would supply the facts. Keep actions/forms for a later slice through validated host actions and existing approval mechanisms. This is a recommendation, not an approved product spec or implementation commitment.

Proposed acceptance checks for a future prototype:

1. The same answer streams acceptably and survives a refresh/reopen without losing its visual block or prose.
2. Phone and desktop layouts, themes, keyboard use, and text/table equivalents remain usable.
3. Unknown components, malformed/truncated output, and model refusal fall back to useful text without exposing raw DSL as the normal chat experience.
4. Citations and freshness remain attributable to displayed facts; remote assets and links obey the same relevant restrictions as current replies.
5. Test the user's configured model paths for format reliability and prompt/token overhead. Documentation-level model independence does not prove every configured CLI/provider route will produce correct DSL.

A spec and task issue are required before product implementation under `CLAUDE.md`. No dependency installation, application changes, runtime tests, or live integration were performed for this research.
