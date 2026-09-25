# Chat UI component libraries: design inspiration survey

Date: 2026-09-07
Context: small desktop web build-assistant chat, React 19, bespoke hand-authored design system, no purple-gradient AI-slop looks.
Method: primary sources only (official docs, live demos, source repos). One citation link per claim.

## 1. Vercel AI Elements

- What it is: a component registry built on top of shadcn/ui for AI-native apps, not an npm dependency but copy-in code ([docs](https://elements.ai-sdk.dev/docs)).
- Targets React 19 with no forwardRef usage, plus Tailwind CSS 4 ([docs](https://elements.ai-sdk.dev/docs)).
- Installs one component at a time into your own tree (default `@/components/ai-elements/`) via its CLI or the shadcn CLI, so you own and can restyle every file ([setup](https://elements.ai-sdk.dev/docs/setup)).
- Thread piece: `Conversation` wraps messages, auto-scrolls to bottom, and ships a scroll-to-bottom button plus empty state and download ([Conversation](https://elements.ai-sdk.dev/components/conversation)).
- Message piece: `Message` suite with user/assistant styling, response branching, action buttons (retry, copy, like), and attachment display ([Message](https://elements.ai-sdk.dev/components/message)).
- Composer piece: `PromptInput` with textarea, file attachments, model picker, action menu, and submit button ([PromptInput](https://elements.ai-sdk.dev/components/prompt-input)).
- Typing/loading piece: no classic three-dot typing indicator; loading states use `Shimmer` animated text and reasoning/status components ([Shimmer](https://elements.ai-sdk.dev/components/shimmer)).
- Markdown + code: `MessageResponse` renders Markdown with GFM tables, math, and smart streaming, and requires a Streamdown stylesheet import in globals.css ([Message](https://elements.ai-sdk.dev/components/message)).
- Code blocks: dedicated `CodeBlock` with Shiki syntax highlighting, optional line numbers, copy button, and light/dark switching via CSS variables ([CodeBlock](https://elements.ai-sdk.dev/components/code-block)).
- Streaming: examples wire components directly to the AI SDK `useChat` hook (`messages`, `sendMessage`, `status`), rendering `message.parts` as tokens arrive ([chatbot example](https://elements.ai-sdk.dev/examples/chatbot)).
- Theming fit: inherits your shadcn/Tailwind theme automatically since the code lives in your repo; weakest fit for a bespoke non-Tailwind token system because styling assumes Tailwind utilities and CSS variables ([setup](https://elements.ai-sdk.dev/docs/setup)).
- Live demo: [chatbot example with live preview](https://elements.ai-sdk.dev/examples/chatbot).

## 2. assistant-ui (headless + Radix/Base UI flavors)

- What it is: headless React primitives for AI chat (thread, composer, message) plus a styled registry; the runtime that talks to your backend is separate from the UI ([docs](https://www.assistant-ui.com/docs/runtimes/pick-a-runtime)).
- Ships `ThreadPrimitive` (scrollable viewport, auto-scroll, empty states, suggestions) with code-level examples ([Thread primitive](https://www.assistant-ui.com/docs/primitives/thread)).
- Viewport auto-scrolls on new streamed content only when the user has not scrolled up manually, and can anchor the turn to top or bottom ([Thread primitive](https://www.assistant-ui.com/docs/primitives/thread)).
- Ships `ComposerPrimitive` (Root form, Input textarea, Send/Cancel, attachment state, keyboard shortcuts, focus management) ([Composer primitive](https://www.assistant-ui.com/docs/primitives/composer)).
- Same composer primitives handle new-message and edit-message modes depending on whether they sit inside a Thread or a Message ([Composer primitive](https://www.assistant-ui.com/docs/primitives/composer)).
- Ships `MessagePrimitive` with a parts pipeline (text, image, file, tool calls, reasoning, sources) and hover/error state ([Message primitive](https://www.assistant-ui.com/docs/primitives/message)).
- Text parts render with a built-in streaming indicator by default ([Message primitive](https://www.assistant-ui.com/docs/primitives/message)).
- Styling escape hatch: every primitive accepts `asChild` to merge its behavior onto your own design-system element ([Composer primitive](https://www.assistant-ui.com/docs/primitives/composer)).
- Component registry offers Radix UI and Base UI flavored versions of each styled component ([docs index](https://www.assistant-ui.com/)).
- Runtimes: first-party adapters for Vercel AI SDK, LangGraph, LangChain, Google ADK, plus custom Local/ExternalStore runtimes for your own state store ([pick a runtime](https://www.assistant-ui.com/docs/runtimes/pick-a-runtime)).
- Markdown + code: markdown and code highlighting ship in the styled default theme per the project README ([repo](https://github.com/assistant-ui/assistant-ui)).
- Theming fit: best headless fit for a bespoke token system, since primitives render plain divs/forms and `asChild` lets your tokens own all visuals ([Composer primitive](https://www.assistant-ui.com/docs/primitives/composer)).
- Live demo: docs pages carry interactive previews; start at the [Thread primitive page](https://www.assistant-ui.com/docs/primitives/thread).

## 3. Base UI (pure headless primitives, no chat kit)

- What it is: unstyled, accessible React primitives from the Radix/Floating UI/Material UI lineage, with zero visual opinions ([homepage](https://base-ui.com/)).
- Ships around 40 primitives (Dialog, Popover, Select, Combobox, Scroll Area, Tooltip, Toast, etc.) and no message, thread, typing-indicator, or composer components ([quick start](https://base-ui.com/react/overview/quick-start)).
- Ships no CSS at all and works with Tailwind, CSS Modules, CSS-in-JS, or plain CSS ([styling handbook](https://base-ui.com/react/handbook/styling)).
- Styling hooks are className (including state functions), data attributes like `data-checked`, and exposed CSS variables ([styling handbook](https://base-ui.com/react/handbook/styling)).
- Markdown + code: none shipped; you render your own markdown inside your own message bubbles.
- Streaming: nothing chat-specific; you would drive updates through your own state.
- Theming fit: excellent for a bespoke token system (unstyled by design, data-attribute selectors map cleanly onto tokens), but you build 100 percent of chat UX yourself ([styling handbook](https://base-ui.com/react/handbook/styling)).
- Live demo: every component docs page has a live demo, e.g. the [Dialog page](https://base-ui.com/react/components/dialog).

## 4. Stream Chat React

- What it is: official React SDK for the Stream Chat hosted service, full multi-user chat UI kit ([overview](https://getstream.io/chat/docs/sdk/react/)).
- Core pieces: `Chat`, `Channel`, `MessageList` plus virtualized list, `Message`, and message input components ([overview](https://getstream.io/chat/docs/sdk/react/)).
- Typing indicator: dedicated `TypingIndicator` component with a customization guide using channel state and typing contexts ([typing indicator guide](https://getstream.io/chat/docs/sdk/react/guides/customization/typing-indicator/)).
- Markdown: messages render markdown by default through the `renderText` function with customizable remark/rehype plugins and per-element renderers ([renderText docs](https://getstream.io/chat/docs/sdk/react/components/message-components/render-text/)).
- Code blocks: no dedicated code-block component with highlighting/copy; code rendering is whatever your markdown renderer outputs.
- Streaming/threading model targets human multi-user chat (channels, presence, read receipts), not single-session LLM token streaming.
- Theming: v2 theming built on palette, component, and global CSS variables ([theming](https://getstream.io/chat/docs/sdk/react/theming/themingv2/)).
- Theming fit: decent token mapping via CSS variables, but the visual language is classic team-chat and the kit assumes the Stream backend service ([theming](https://getstream.io/chat/docs/sdk/react/theming/themingv2/)).
- Live demo: [Stream chat demos](https://getstream.io/chat/demos/).

## 5. react-chat-elements

- What it is: classic WhatsApp-style React chat widget set by Detaysoft ([homepage](https://detaysoft.github.io/docs-react-chat-elements/)).
- Ships MessageBox, ChatList, MessageList, ChatItem, Input, Button, Popup, Sidebar, Navbar, Dropdown, Avatar, and meeting components ([getting started](https://detaysoft.github.io/docs-react-chat-elements/docs/intro)).
- Thread piece: ChatList/ChatItem sidebar plus MessageList for the conversation column ([getting started](https://detaysoft.github.io/docs-react-chat-elements/docs/intro)).
- Composer piece: a basic Input component with send button, no attachment shelf or model picker ([getting started](https://detaysoft.github.io/docs-react-chat-elements/docs/intro)).
- Typing indicator: none as a named component; loading spinners appear only inside media/file message types.
- MessageBox types cover text, location, photo, video, audio, file, system, meeting, meetingLink, and spotify, with no markdown or code-block type ([MessageBox](https://detaysoft.github.io/docs-react-chat-elements/docs/messagebox/)).
- Streaming: no streaming story; messages are discrete immutable items with position/title/date props ([MessageBox](https://detaysoft.github.io/docs-react-chat-elements/docs/messagebox)).
- Theming: single bundled stylesheet imported via `react-chat-elements/dist/main.css`, customized by overriding its CSS, with no token system ([getting started](https://detaysoft.github.io/docs-react-chat-elements/docs/intro)).
- React 19 risk: peer dependencies pin React `^18.2.0`, so a React 19 build inherits a peer-warning or fork burden ([package.json](https://raw.githubusercontent.com/Detaysoft/react-chat-elements/master/package.json)).
- Live demo: [official live demo](https://detaysoft.github.io/docs-react-chat-elements/demo/).

## 6. shadcn-chatbot-kit (shadcn chat example)

- What it is: community shadcn/ui chatbot kit (Blazity fork lineage) of copy-paste components wired to the Vercel AI SDK ([repo](https://github.com/Blazity/shadcn-chatbot-kit)).
- Ships Chat, MessageInput, MessageList, ChatMessage, MarkdownRenderer, PromptSuggestions, TypingIndicator, CopyButton, FilePreview, and AudioVisualizer ([Chat docs](https://shadcn-chatbot-kit.vercel.app/docs/components/chat)).
- Typing indicator is a first-class component alongside the message list ([Chat docs](https://shadcn-chatbot-kit.vercel.app/docs/components/chat)).
- Markdown: dedicated MarkdownRenderer powered by react-markdown plus remark-gfm, styling tables, lists, and code blocks ([MarkdownRenderer](https://shadcn-chatbot-kit.vercel.app/docs/components/markdown-renderer)).
- Streaming: Chat takes `useChat` state directly and keys loading off `status === "submitted" || status === "streaming"`, with stop-generation and auto-scroll with manual override ([Chat docs](https://shadcn-chatbot-kit.vercel.app/docs/components/chat)).
- Empty-state pattern: prompt suggestion chips that append via the `append` function ([Chat docs](https://shadcn-chatbot-kit.vercel.app/docs/components/chat)).
- Theming: shadcn CSS-variable system with a visual theme customizer; maps well onto any token set that can be expressed as CSS variables ([repo](https://github.com/Blazity/shadcn-chatbot-kit)).
- Caveat: community-maintained, tracks older `ai/react` `useChat` API, so expect adaptation to current AI SDK versions ([Chat docs](https://shadcn-chatbot-kit.vercel.app/docs/components/chat)).
- Live demo: [official demo](https://shadcn-chatbot-kit.vercel.app/demo).

## 7. Chakra UI (composed chat, no chat kit)

- What it is: general component library, not a chat library; there is no message, thread, typing-indicator, or composer component in its catalog ([components overview](https://v2.chakra-ui.com/docs/components)).
- Chat UIs are composed from generic primitives (Input, Textarea, Button, Avatar, Spinner, layout) plus your own state.
- Theming: `extendTheme` overrides design tokens (colors, font sizes, spacing) and per-component base styles, sizes, and variants ([customize theme](https://v2.chakra-ui.com/docs/styled-system/customize-theme)).
- Theming fit: token model is close in spirit to a bespoke token system, but adopting Chakra means adopting its styled-system runtime rather than hand-authored CSS ([customize theme](https://v2.chakra-ui.com/docs/styled-system/customize-theme)).
- Markdown + code, streaming: nothing shipped; bring your own renderer and stream handling.
- Value here is narrow: study its theme-token layering (foundations, semantic tokens, component variants) as a design reference, not its components.
- Live demo: none for chat; component demos live under the [components catalog](https://v2.chakra-ui.com/docs/components).

## Cross-cutting notes

- AI-builder chats and human team chats are different products: AI Elements, assistant-ui, and shadcn-chatbot-kit model streaming parts, reasoning, and tool calls, while Stream and react-chat-elements model discrete human messages with presence and read state ([chatbot example](https://elements.ai-sdk.dev/examples/chatbot); [overview](https://getstream.io/chat/docs/sdk/react/)).
- Only assistant-ui and Base UI let your own elements own the DOM via headless behavior merge (`asChild` / unstyled primitives); the rest ship styled markup you override ([Composer primitive](https://www.assistant-ui.com/docs/primitives/composer); [styling handbook](https://base-ui.com/react/handbook/styling)).
- Only AI Elements ships build-assistant-specific pieces (plan, task, terminal, file tree, web preview) beyond plain chat ([homepage](https://elements.ai-sdk.dev/)).

## Verdict

- Steal from assistant-ui first: its headless thread/composer/message split fits a bespoke token system without fighting anyone's CSS.
- Steal from Vercel AI Elements second: its part-based streaming message and build-task pieces match a build assistant, but only as patterns to re-skin, not as code to adopt.
- Skip Stream and react-chat-elements for this build: one assumes a hosted human-chat backend, the other pins React 18 and has no markdown or streaming story.
