# Moss visual chat targets — throwaway prototype

Open `index.html` directly in a browser. It is self-contained, including fonts, styles, controls, and example data; it needs no server or account. Source is kept on `prototype/openui-chat-targets`, outside the production application.

Question: what should richer replies look like inside Moss chat?

Context: [OpenUI assessment, PR #3580](https://github.com/motioneso/moss/pull/3580). This branch preserves visual options for review and is not intended to merge into the application.

- **A · Inline summary:** a visual passage alongside prose, with minimal containment.
- **B · Visual card:** a contained snapshot with metrics and a chart, agenda, or option cards.
- **C · Compact dashboard:** a headline insight followed by detail and a supporting rail. The rail stacks at narrow widths.

Switch between day planning, everyday spending, and travel comparison. The same data appears in all three treatments. Width controls show expanded chat, the 404px drawer, and a 390px phone. Theme controls show forest light, forest dark, and sage light. The bottom arrows and keyboard Left/Right switch layouts; focused form controls keep their normal keyboard behavior.

The URL records `scenario=plan|money|compare`, `variant=A|B|C`, `view=expanded|drawer|phone`, and `theme=light|dark|sage`. These parameters work when opening the local file too. Sources expand an explanation; follow-up chips and the composer show a scripted example. Replay reveal demonstrates a staged entrance, not real token streaming.

All people, amounts, schedules, and travel options are invented. No data is read or changed, and no model or OpenUI runtime is installed or invoked. The preview uses rendered Moss shared components and tokens plus prototype-only compositions. This establishes a visual target; future approved implementation would define the required shared visual primitives, generation contract, citations, persistence, and action behavior.

Rebuild from `~/Jarv1s` after the normal workspace dependency setup:

```bash
pnpm exec tsx apps/web/src/chat/openui-mockup/build.tsx
```

Browser checks covered all nine example/layout combinations at desktop and phone widths, with no page errors or horizontal overflow. Switcher URL updates, source disclosure, and scripted follow-up were exercised. Light, dark, and sage views were checked. These checks validate the mockup, not production OpenUI integration.

Decision remains open: no winning variant has been selected and no product implementation is approved. The inline treatment is the starting recommendation for everyday replies; contained visuals suit denser comparisons, and the dashboard treatment is a deliberate upper bound on visual density.
