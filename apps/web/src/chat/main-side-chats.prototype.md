# Main and side chat navigation — throwaway design preview

Question: how should users move between one continuous main conversation and optional topic side chats?

This is the first design comparison for [spec #3096](https://github.com/motioneso/moss/issues/3096), documented in [PR #3097](https://github.com/motioneso/moss/pull/3097). The user selected A; no production behavior is changed. All conversation content and the displayed account are fictional samples.

## Three options

- **A — Collapsible conversation menu:** a three-line button opens main chat, the topic list, and New side chat over the conversation. It is closed by default on desktop and phones; the menu never widens or pushes the chat. New side chat appears only inside the menu.
- **B — Compact tabs:** main chat and topic tabs across the top; the row scrolls when needed.
- **C — Conversation picker:** a main-chat shortcut alongside a topic picker, leaving the conversation width open.

Each option has an Alongside Today view, an Expanded view, and a Phone view. The Alongside Today chat uses the existing 380px docked width. Add `menu=open` to an option A URL to preview its open overlay. The comparison controls are outside the proposed product interface. Left/right arrow keys switch options except when typing, using the topic tabs, or working in a dialog.

## Run

From the isolated prototype worktree:

```sh
pnpm install --frozen-lockfile --ignore-scripts
CHAT_PREVIEW_PORT=$(devports claim moss-chat-design)
pnpm prototype:chat --port "$CHAT_PREVIEW_PORT"
```

Open the printed server address with `/chat-navigation.prototype.html?variant=A&view=docked`. Use `variant=B` or `variant=C` to share another option. Use `view=expanded` or `view=phone` for the other layouts.

After stopping the preview server, release its port:

```sh
devports release "$CHAT_PREVIEW_PORT"
```

## Try

Switch to a side chat, start a new topic from the menu, type a message, and return to main chat. Drafts and transcripts stay with their conversation. Use Add an update to main chat while viewing a side chat, then return through navigation to read it. Updates use the navigation unread indicator; there is no update banner in any conversation. The sample email link opens a sample source. The theme button previews the dark theme without changing user preferences.

The separate Vite preview entry uses the actual Moss fonts, tokens, shared chat renderer, and UI primitives inside a populated app-frame example. It does not start the application or an API proxy. This allows layout review without a connected account or another session's services. The regular app entry and its authentication/data loading are untouched. Neither the preview entry nor its comparison controls are imported by the production entry; rendering is guarded by the development build flag.

All interactions remain in browser memory. This demonstrates navigation, not scheduling, permissions, real memory sharing, or background delivery. Production implementation must follow the approved spec and reviewed single-session task breakdown after screen decisions are agreed. Keep future chat/status and handoffs in plain English.

## Design status

The user accepted A with a collapsed three-line menu over the chat and the existing default width preserved. The requested refinements put New side chat inside the menu and remove main-chat update banners entirely. Existing-thread migration, task Settings, task approval, and notification controls remain separate design work. Keep this prototype on its throwaway branch as a primary source; update the spec with the agreed decisions rather than merging prototype code into the app.
