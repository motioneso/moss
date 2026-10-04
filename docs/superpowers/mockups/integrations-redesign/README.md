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
- The Connection block says when the tools were sorted, and that the default chat model (and its provider, if hosted) read each tool's name and description. There is no one-time notice (question 6).
- The same call replaces the free rule's names with better model-written ones (question 4).
- Radarr keeps its own sections, because web services already say whether each tool reads, changes or deletes.

## Classifier states shown (issue 2984)

1. Off.
2. Turning it on: the one-time notice, using the shipped wording of what is sent, who reads it, the cost, and what is and is not sent.
3. Preparing, with progress. Quick requests use the default model until it finishes.
4. Ready: "74 of 75 tools can answer quick requests. 12 always ask you before they run." The count covers Sensitive tools and Sends things out tools you have not allowed. A line under it says YOLO mode skips the asking.
5. A tool changed: it is prepared again by itself, and its row says "Preparing again".
6. Couldn't prepare, with "Try again".
7. Connection lost: paused, and it resumes by itself.

There is no Prepare button, no per-tool risk choice and no per-tool review row. Every tool that is on stays on; the user only switches tools off.

## Sending without asking (issue 2984, slice R2.5)

Added for Ben's sign-off before the screen is built. Spec section 8.3 has the rules.

- Sends things out tools now show "Asks first" in section 2, like Sensitive ones.
- Section 2 shows one tool, "Ring my phone", already allowed. Its "Asks first" chip gives way to a faint "Sends without asking" note.
- A Sends things out tool's menu gains "Send without asking" above "Keep out of the classifier". Once chosen, the item reads "Ask before sending".
- The group header gains "Send all without asking", which confirms once, inline: "Let chat send with these 7 tools without checking with you?" with Allow and Cancel.
- While any tool in the group is allowed, the header shows "Ask first for all". When some tools are allowed and some still ask, it shows both links.
- New section 6 draws the group close up in four states, at the tools column's width and at phone width: asking with the menu open, one tool allowed with its menu open, the confirm open, and all allowed.
- Sensitive tools never get the choice.

Other spec 8.3 and 8.6 gaps filled at the same time:

- The always-ask count in the classifier rail and the list screen now includes sending tools that ask, so it reads 12, not 6.
- The tools intro and the Ready state each say YOLO mode skips the asking.
- The sorting line says the model read each tool's name, description and inputs, as the spec says. It said name and description.

## Decided

1. One switch per tool, plus "Keep out of the classifier" in the tool's menu. The mockups already show it.
2. Run a cheap sorting pass that groups tools by what they do, even with the classifier off.
3. A connection's screen hides the settings list so the tools get the full width, with "Back to connections" at the top.
4. Both names. The free rule gives an instant readable name, and the sorting pass replaces it with a better model-written name in the call it already makes.
5. Keep the name "classifier". No rename.
6. No one-time notice for the sorting pass. A line in the Connection block says what it sends and who reads it.

All six questions are answered. The mockups are ready for Ben's review.
