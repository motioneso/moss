# Connections redesign mockups

Design proposal for Settings > Connections > Apps & services and a connection's own screen. Nothing here is built. Ben approves the mockups before anyone builds them.

- Open `index.html` in a browser. It works from disk, with no server.
- Colours: dark and light switch at the top right. "Actual size" shows the frames at 1440 and 390 pixels.
- The section 2 buttons show each classifier state in place on the connection's screen. "Just added" shows the list while the sorting pass runs.
- Full critique: [critique.md](critique.md). Score today: 14 of 40.
- Data: the connections and tool names are the real ones on the dev account. Addresses are replaced with `.local` names.

## Findings and fixes

| # | Finding | Fix in the mockups | Mockup |
|---|---|---|---|
| 1 | Switches show the wrong state. Agentmail's "Other" group shows on but is really off; Home Assistant's group switches do nothing. | No group switches. Each group says "N of M on" and has a "Turn all off" button. The count and the switches come from one rule. | 2, 4 |
| 2 | The tool list never ends: 16 screens on Home Assistant, 47,000 pixels on Radarr. | Summary line, search, All/On/Off filter, six tools per group with "Show N more". Sections with nothing on fold into a three-column index. | 2, 4 |
| 3 | The classifier section is a review queue, lists every tool twice, and its only button is 7,000 pixels down. | Issue 2984's flow in a side rail: one switch, a one-time notice of what is sent and the cost, then automatic preparing. Risky tools show "Asks first" in the main list. | 2, 3 |
| 4 | Raw tool names are hard to read. | Readable name in bold, raw name small and faint underneath, still searchable. A free rule makes the name; the sorting pass can write a better one. | 5 |
| 5 | Jargon and four names for one place. | "Connections" everywhere, a "Back to connections" link, no tool-server or web-API badges in the list. | 1, 2 |
| 6 | Layout ignores the house style; content is 860 of 1440 pixels; phone rows wrap and overflow. | Numbered section heads, ruled index rows with a gold hover marker, a main column plus a 300-pixel rail. The phone row stacks: name and switch, then status, then one facts line. | 1, 2 |
| 7 | A broken connection shows a red badge and no next step. | The row says what broke and when, with a "Check again" button. | 1 |
| 8 | The note says "Refresh tools", the button says "Refresh". | One button, "Check for new tools", in the masthead and the rail. | 2 |
| 9 | Descriptions that only repeat the name ("Execute Home Assistant AddTaskWork intent"). | Hidden, with "No description from the app" in faint italics. | 2, 5 |

## Sorting tools, with the classifier off

Ben's answer to question 2. When a connection is added, Moss runs one cheap pass that sorts its tools by what they do. It runs whether or not the classifier is on.

- While it runs, the list shows A to Z with a "Sorting" note, and every tool works.
- Once it finishes, tools group into Looks things up, Changes things, Sends things out and Sensitive.
- The Connection block in the rail says when the tools were sorted.
- The same pass can write the readable names (question 4).
- Radarr keeps its own sections, because web services already say whether each tool reads, changes or deletes.

## Classifier states shown (issue 2984)

1. Off.
2. Turning it on: the one-time notice, using the shipped wording of what is sent, who reads it, the cost, and what is never sent.
3. Preparing, with progress. Quick requests use the default model until it finishes.
4. Ready: "74 of 75 tools can answer quick requests. 6 always ask you before they run."
5. A tool changed: it is prepared again by itself, and its row says "Preparing again".
6. Couldn't prepare, with "Try again".
7. Connection lost: paused, and it resumes by itself.

There is no Prepare button, no per-tool risk choice and no per-tool review row. Every tool that is on stays on; the user only switches tools off.

## Decided

1. One switch per tool, plus "Keep out of the classifier" in the tool's menu. The mockups already show it.
2. Run a cheap sorting pass that groups tools by what they do, even with the classifier off.
3. A connection's screen hides the settings list so the tools get the full width, with "Back to connections" at the top.

## Open questions for Ben

4. Is a model-written readable name worth having, given the free rule is decent?
5. Rename "classifier" to something plainer, such as "Quick answers"?
6. Sorting sends each tool's name and description to the default chat model, and to its provider if it is hosted. The classifier shows a notice before it sends the same kind of thing. Should adding a connection say this once too, or is the line in the Connection block enough?
