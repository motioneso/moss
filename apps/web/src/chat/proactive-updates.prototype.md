# Proactive updates — throwaway chat preview

Design-only preview for [#3102](https://github.com/motioneso/moss/issues/3102), part of
[#3096](https://github.com/motioneso/moss/issues/3096). Source brief: issue #3102;
product definition: #3097, revision `13cd364fe`.

Uses the accepted ordinary-message design from #3100 and the conversation shell from
`prototype/main-side-chat-navigation`: a 380px dock, closed three-line overlay, direct typing
in a new side chat, automatic titles and no main-chat update banners. One presentation is
intentional: earlier layout choices are already settled. The controls above the app are review
controls, not product UI.

All names, sources, findings and clocks are fictional. State lives only in browser memory and
resets on reload. No production entry imports this preview. This does not implement or verify
scheduling, connectors, permissions, persistence or backend concurrency. Keep this branch out
of main. Ben approved the complete preview on 8 October 2026; design task #3102 is complete.

## Run

From this throwaway branch:

```sh
pnpm install --frozen-lockfile --ignore-scripts
PROACTIVE_PREVIEW_PORT=$(devports claim proactive-update-design)
pnpm prototype:proactive-updates --port "$PROACTIVE_PREVIEW_PORT"
```

Open `/proactive-updates.prototype.html?example=useful`. Add `view=phone` for the narrow layout.
When finished, stop the server and release its port:

```sh
devports release "$PROACTIVE_PREVIEW_PORT"
```

The dedicated Vite config can also build this fictional preview. Its development-render flag
applies only to that config; the ordinary app build never includes the entry.

## Try

Choose a situation and press **Run sample**. **Next check** advances a sample with multiple
checks. **Start over** clears its state. Reply through the normal message composer.

| `example`    | Behavior shown                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `useful`     | Sourced assistant-only update; unchanged finding produces no duplicate                                   |
| `complete`   | Matching sender/subject email receipt fulfills the arrival goal; one stop explanation                    |
| `unread`     | Finding or opening the source does not prove reading; explicit “I’ve read it” completes the sample watch |
| `late`       | Reminder delivered once with original local time and clear lateness                                      |
| `expired`    | Passed deadline; zero send executions and zero new messages                                              |
| `recovery`   | One fresh check after downtime; next regular check stays quiet if unchanged                              |
| `quiet`      | Successful empty/unchanged checks produce no messages                                                    |
| `failures`   | Temporary read failures stay quiet; repeated failures explain reconnection                               |
| `write`      | Started archive with uncertain outcome is not rerun; inspect before continuing                           |
| `concurrent` | Typed live reply and background update coexist; finish updates the original reply                        |

For `concurrent`, type a message first, run the sample, then press **Finish live reply**. Try this
in AI reading as well: the update belongs to main chat and causes no side-chat banner, transcript
change or draft loss. Return to Main chat to see it. This is sample UI behavior only.

Email sources open sample Gmail webmail in a new tab. A real implementation must use the
connected provider’s webmail, rather than hardcoding Gmail. The release-note source is an
explicitly fictional example.com page. Arbitrary user text receives a short preview reply;
there is no real assistant behind this mockup.

## Review and verification

Ben approved all ten situations on 8 October 2026. The ordinary update, stop and failure
wording, quiet recovery behavior and visual coexistence of background/live replies are
accepted as the design reference. This approval covers the mockup; production implementation
remains separate work against the feature specification.

Scoped formatting and lint, web type checking, and existing design-token/UI-class checks
passed. Repeatable Firefox checks cover all ten situations, desktop/phone, 320/375/414/768px
widths, dark/Teal themes, reload reset, provider-link popup behavior, menu focus and fixed dock
geometry. Browser requests are local GET assets only; there are no API calls or browser storage.
The final hosted copy receives the same interaction checks. Evidence and private preview
addresses remain in the Moss vault, outside this public repository.

No production or database tests apply. Real watch read-state evidence remains an implementation
gap; this sample uses explicit user confirmation and makes no claim that a link click proves reading.
