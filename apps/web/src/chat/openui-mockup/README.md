# Moss visual chat targets — throwaway prototype

## Live interactive version

The LAN preview now opens a live conversation at its root URL. Start with a day plan, weekly budget, or travel comparison, or type your own request. Replies can contain metrics, charts, comparison tables, timelines, choices, and sliders. Choosing an option or applying a slider sends that value into the next model turn. Conversation history stays in the current browser tab's memory; reload or New conversation clears it. Stop cancels a pending reply and returns its message to the composer.

Run on Linux with Python 3, bubblewrap, and an installed Codex CLI already logged in through ChatGPT. No additional packages or API key are needed:

```bash
moss_preview_port=$(devports claim moss-openui-targets)
python3 apps/web/src/chat/openui-mockup/serve.py --port "$moss_preview_port"
```

Open the printed port on this machine's LAN address. The server binds to all interfaces. This is an unauthenticated local prototype: reachable clients can make model requests using this machine's Codex login. It allows two concurrent replies with a two-minute timeout. Stop the server and run `devports release "$moss_preview_port"` when finished. Optional `MOSS_CHAT_MODEL` chooses a CLI model; otherwise the CLI chooses its default.

This is a **separate conversation**, not a connection to the coding agent's current thread or production Moss. Example data is invented; pasted values become part of the conversation sent to the model. There are no Moss credentials, database connections, bookings, task writes, or account actions. The bridge invokes an ephemeral Codex process with user config, plugins, hooks, web search, shell execution, code-mode host, and browser/computer tools disabled. Bubblewrap mounts only the executable, its login file, the response schema, system certificates/DNS files, and temporary process devices; the checkout and the rest of the home directory are not mounted. The browser receives response data, not the login file. The bridge does not log prompts or replies.

The visual runtime is a small native HTML catalog with structured JSON generation, **not the OpenUI package**. This lets us test whether real conversation-driven visuals feel useful before deciding on the production renderer. Model content is placed with `textContent`; it cannot supply executable HTML, scripts, URLs or arbitrary actions. Controls only send conversational follow-ups. There is no token streaming; a pending state appears until a complete structured response arrives.

Browser verification exercised real budget generation, a slider change to $499 and the recalculated chart, a later free-text recall of $499, a generated travel choice and adapted timeline, theme/width changes, cancellation, reset, and connection-error recovery. Both live browser runs finished without page errors; the original mockups route still works.

`live.html` contains the same Moss shell, embedded styles and fonts as the original targets, plus `live.js` and `live.css`. It needs the bridge for model replies. Rebuild both HTML artifacts with the command below. `/mockups` preserves the original scripted visual targets.

## Original visual targets

Open `index.html` directly in a browser. It is self-contained, including fonts, styles, controls, and example data; it needs no server or account. Source is kept on `prototype/openui-chat-targets`, outside the production application.

Question: what should richer replies look like inside Moss chat?

Context: [OpenUI assessment, PR #3580](https://github.com/motioneso/moss/pull/3580). This branch preserves visual options for review and is not intended to merge into the application.

- **A · Inline summary:** a visual passage alongside prose, with minimal containment.
- **B · Visual card:** a contained snapshot with metrics and a chart, agenda, or option cards.
- **C · Compact dashboard:** a headline insight followed by detail and a supporting rail. The rail stacks at narrow widths.

Switch between day planning, everyday spending, and travel comparison. The same data appears in all three treatments. Width controls show expanded chat, the 404px drawer, and a 390px phone. Theme controls show forest light, forest dark, and sage light. The bottom arrows and keyboard Left/Right switch layouts; focused form controls keep their normal keyboard behavior.

The URL records `scenario=plan|money|compare`, `variant=A|B|C`, `view=expanded|drawer|phone`, and `theme=light|dark|sage`. These parameters work when opening the local file too. Sources expand an explanation; follow-up chips and the composer show a scripted example. Replay reveal demonstrates a staged entrance, not real token streaming.

In the original targets, all people, amounts, schedules, and travel options are invented. No data is read or changed, and no model or OpenUI runtime is installed or invoked by `index.html`. The preview uses rendered Moss shared components and tokens plus prototype-only compositions. This establishes a visual target; future approved implementation would define the required shared visual primitives, generation contract, citations, persistence, and action behavior.

Rebuild from `~/Jarv1s` after the normal workspace dependency setup:

```bash
pnpm exec tsx apps/web/src/chat/openui-mockup/build.tsx
```

Browser checks covered all nine example/layout combinations at desktop and phone widths, with no page errors or horizontal overflow. Switcher URL updates, source disclosure, and scripted follow-up were exercised. Light, dark, and sage views were checked. These checks validate the mockup, not production OpenUI integration.

Decision remains open: no winning variant has been selected and no product implementation is approved. The inline treatment is the starting recommendation for everyday replies; contained visuals suit denser comparisons, and the dashboard treatment is a deliberate upper bound on visual density.
