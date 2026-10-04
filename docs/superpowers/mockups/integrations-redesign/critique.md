# Critique: Connections list and a connection's screen

Method: two independent reviews, merged. A did a design review in the browser. B ran the impeccable detector on the source and a browser overlay on the live pages. Both ran on a private dev server against the shared dev database, on the connections already on the dev account (Home Assistant, Agentmail, Radarr). No data was faked.

Screens: Settings > Connections > Apps & services, and Configure for each connection, at 1440x900 and 390x844.

## Score: 14 of 40

| # | Heuristic | Score | Main problem |
|---|---|---|---|
| 1 | Shows what is going on | 2 | Agentmail's row says 22 tools are on while 31 switches show on. The classifier switch shows on while its status says nothing is prepared. |
| 2 | Speaks the user's language | 1 | "MCP" and "API" badges, raw names such as get_api_v3_alttitle_id, web addresses as descriptions, "schema", "classifier". |
| 3 | User control | 2 | Remove asks first, but there is no undo, and Home Assistant's group switches do nothing. |
| 4 | Consistency | 1 | One place has four names: Connections, Apps & services, Integrations, "Back to integrations". A group switch reads off over tools that all read on. |
| 5 | Prevents mistakes | 2 | Tools that delete or send look the same as tools that only read, though the app already knows which is which. |
| 6 | Recognise, don't recall | 1 | Risk never shows in the tool list. Home Assistant's explaining note sits above the 75 rows it explains. |
| 7 | Speed for frequent users | 1 | No search, filter or folding. Radarr shows 237 tools in 71 groups. |
| 8 | Nothing extra | 1 | Every group is always open. Home Assistant is 14,592 pixels tall; Radarr is 47,186. |
| 9 | Helps recover from errors | 2 | The last error shows beside a Refresh button. Classifier failures are explained, but in long technical sentences. |
| 10 | Help where needed | 2 | Six notes stack up before any content, mostly in jargon. |

## Verdict on the look

Generic. Without the logo this is any admin panel's integrations page: names with coloured pills, then one switch per tool, top to bottom. It borrows hairline rules and Archivo headings, but none of Today's structure. There are no numbered section heads, no ruled index rows with facts on the right, and no gold markers. The content column is about 860 pixels of a 1440 window.

## Priority problems

### P0. Switches that do not tell the truth

- Agentmail's "Other" group (send, reply, forward and six more) shows its group switch and all nine tool switches on. Moss never enables that group, so it really has 22 tools on, not 31. Someone trying to let Moss send email sees it on, and it still cannot send.
- Home Assistant's nine group switches all show off while all 75 tools are on, and flipping a group switch changes nothing.
- Fix: draw every switch from the same rule as the count. Replace group switches with "N of M on" and a "Turn all on/off" button.
- This is a bug in the shipped screen, worth fixing on its own before the redesign lands.

### P1. A tool list that never ends

- No summary, search or folding. Home Assistant is about 16 screens tall; on a phone it is 15,537 pixels.
- Fix: open on a summary line, add search and an on/off filter, show six tools per group and fold the rest. On very big connections, fold the sections with nothing on into a compact index.

### P1. The classifier section is a review queue

- It lists all 75 tools a second time as "Not reviewed yet", under six notes, and the only button sits about 7,000 pixels down.
- Issue 2984 removes the reason for most of it: the manual Prepare step, per-tool risk picks and per-tool review rows.
- Fix: one switch in a side rail, a one-time notice of what is sent and what it costs, a progress line while tools are prepared, and "Asks first" marks on the risky tools in the main list.

### P2. Jargon, and four names for one place

- Fix: call it Connections everywhere. Drop the plumbing badges from the list. Show a readable tool name with the raw name small underneath.

### P2. The layout ignores the house style and wraps on phones

- On a phone each list row's status line spills 35 to 52 pixels out of its box, and "22 tools on" breaks into three one-word lines.
- Fix: Today's numbered section heads and ruled index rows; a stacked phone row with a single facts line; a main column plus a rail on the connection's screen.

## How different people get stuck

- A power user on Radarr faces 308 switches across 47,000 pixels. Turning on every tool that only reads takes about 100 clicks.
- A keyboard or screen-reader user tabs through 308 stops on Radarr and hears "Enable get_api_v3_alttitle_id".
- A phone user scrolls 15,537 pixels on Home Assistant to reach the only classifier action.
- A household member sees "MCP", "classifier" and "schema", and cannot tell which switch lets Moss unlock a door.

## Smaller things

- Radarr's heading sits about 4 pixels from its badge.
- The note says "Refresh tools" but the button says "Refresh".
- The connection screen's Status row repeats the list row.
- Agentmail descriptions run up to 541 characters.
- Switches are 40x23, just under a 24-pixel tap target.

## Detector evidence

- The impeccable detector found nothing in the screen's source files or the shared settings parts. The repo's own class and token checks pass.
- The detector reads markup only, so it cannot see wrapping. The browser overlay found the three phone overflows above; its other findings were on the dev review toolbar, the menu, or other panes.
- On the phone list the page also scrolls sideways by 11 pixels, caused by the notes folder card, which is outside this screen.

## What works

- The privacy notice is honest about what leaves the box, where it goes and that it may cost money. The mockups keep its wording.
- Remove asks before deleting.
- The detail sections already use hairline rules, not boxed cards.
