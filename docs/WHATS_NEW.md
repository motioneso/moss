# What's New in Moss

## 2026-08-21

### Added

- **A more useful Food day view.** See calories and macros at a glance, browse meals by time of day, and expand a meal to see the foods behind its estimate. Meals logged in Chat now appear here without a manual refresh. [PR #1744](https://github.com/motioneso/moss/pull/1744)
- **Food estimates you can control.** Nutrition estimates now run automatically, with a simple switch in Settings and no extra consent question in Chat. [PR #1751](https://github.com/motioneso/moss/pull/1751)
- **Daily targets and richer module settings.** Food can show daily targets, while module settings can include whole-number values as well as on/off switches. [PR #1767](https://github.com/motioneso/moss/pull/1767)
- **Settings for installed modules.** Your installed modules now appear in your personal settings, where you can manage your own sign-ins and jump straight to a module's settings when available. [PR #1764](https://github.com/motioneso/moss/pull/1764) · [PR #1765](https://github.com/motioneso/moss/pull/1765)

### Fixed

- **Food looks at home in Moss.** The Food day view now uses the same cards, totals, and visual building blocks as the rest of the app. [PR #1733](https://github.com/motioneso/moss/pull/1733)
- **No more phantom nutrition estimates.** When AI estimates are turned off, logging a meal no longer says an estimate is on the way. [PR #1771](https://github.com/motioneso/moss/pull/1771)
- **Private chat respects your latest choice.** A stale response can no longer undo the privacy setting you just selected. [PR #1781](https://github.com/motioneso/moss/pull/1781)
- **Chat actions are harder to double-submit.** Approve and reject cards now handle quick repeated clicks safely, and expired actions explain what happened more clearly. [PR #1649](https://github.com/motioneso/moss/pull/1649)
- **Clearer module error messages.** When a module input is rejected, the error now says which action needs attention so the problem is easier to understand. [PR #1645](https://github.com/motioneso/moss/pull/1645)
- **More resilient note memory.** Moss can now remember notes containing unusual characters that used to stop the process. [PR #1636](https://github.com/motioneso/moss/pull/1636)
- **Downloaded modules restart properly.** The Settings prompt now gives a command that actually applies a downloaded module update. [PR #1658](https://github.com/motioneso/moss/pull/1658)

### Changed

- **Settings are closer to where you need them.** Finance, Job Search, and News pages now link to their own settings, so changing a connection or preference takes fewer clicks. [PR #1772](https://github.com/motioneso/moss/pull/1772)

## Edge channel

Edge builds include the stable history below plus the user-facing changes already available in
the current edge image. This section is intentionally build-bundled so it never advertises a
feature that is not present in the image you are running.

### 2026-10-09

#### Fixed

- **Upgrades with saved News and Sports sources.** Updating Moss no longer fails to start when you already have custom News or Sports sources saved. [PR #3207](https://github.com/motioneso/moss/pull/3207)
- **Creating goals works again.** Adding a new goal, or adding progress notes to a goal, no longer fails. [PR #3206](https://github.com/motioneso/moss/pull/3206)
- **Finance screens refresh after actions.** Finance pages no longer get stuck on Loading after you sync, change a category, or set a budget. [PR #3203](https://github.com/motioneso/moss/pull/3203)
- **Bank transactions now sync.** Transactions from your connected banks now arrive even when the bank's live balance check fails, and a first sync runs as soon as you connect. [PR #3166](https://github.com/motioneso/moss/pull/3166)

### 2026-10-08

#### Fixed

- **Recover meeting audio after call changes.** A meeting recording now keeps going when you join a browser call such as Teams or Google Meet. It reconnects the audio by itself, and a few seconds may be missed while it does. [PR #3153](https://github.com/motioneso/moss/pull/3153)
- **Reduce speaker echo in meeting recordings.** Meeting recordings use the Mac’s voice processing to reduce speaker audio picked up by the microphone. [PR #3120](https://github.com/motioneso/moss/pull/3120)
- **Starting meeting recordings.** Meeting recording on Mac can recover from brief microphone startup hiccups without needing Resume. [PR #3119](https://github.com/motioneso/moss/pull/3119)
- **Cleaner meeting transcripts during silence.** Silent and near-silent recording chunks no longer create repeated transcript lines. [PR #3104](https://github.com/motioneso/moss/pull/3104)
- **Meeting recording on Mac.** Meeting recording on the mac no longer stops itself a moment after starting. [PR #3099](https://github.com/motioneso/moss/pull/3099)

### 2026-10-07

#### Fixed

- **Meeting summaries use your default model.** Meeting summaries use your default model, explain unavailable setups and timeouts clearly, and never switch to another model. [PR #3093](https://github.com/motioneso/moss/pull/3093)
- **Clearer action outcomes.** Unattended writes now show a quiet result line, expired requests stay in their original chat, and saved questions stay before replies in history and exports. [PR #3091](https://github.com/motioneso/moss/pull/3091)

#### Changed

- **Simpler meetings with your Mac.** Link your Mac once and start recording from a small pill on your screen; the meeting page now shows just the transcript and your notes, and a summary is written when you stop. [PR #3056](https://github.com/motioneso/moss/pull/3056)
- **Clearer action approvals.** Deleting a note now always asks first, even when note changes are trusted, and approval cards explain corrections, show clearer keyboard focus, and keep completed choices quiet. [PR #3094](https://github.com/motioneso/moss/pull/3094)

### 2026-10-06

#### Changed

- **Moss can do much more of the app from chat.** Moss can now find and use many more of the app's own actions from chat, such as reviewing memory suggestions, and it shows you a card to approve before deleting anything. Existing chats ask before every change, even in YOLO, until you start a new chat. New chats still ask before every change when they use an outside agent or tools someone else installed, and ask after reading outside content; tools from integrations and add-ons you connected yourself no longer make them ask. Memory suggestions now have clear labels instead of raw labels. [PR #3071](https://github.com/motioneso/moss/pull/3071)

### 2026-10-05

#### Added

- **Choose your decision model.** You can now use Cloudflare's Clef, or any service compatible with Jev, to sort mail and judge focus. [PR #3059](https://github.com/motioneso/moss/pull/3059)
- **Meeting drafts, notes and data export.** Create meeting drafts, keep personal notes, find meetings in History and include retained meeting data in your account export; recording is not available yet. [PR #2982](https://github.com/motioneso/moss/pull/2982)

#### Changed

- **Loading screen matches your colours.** The loading screen now follows your light or dark setting and shows a gently animated Moss logo instead of a spinning circle. [PR #3052](https://github.com/motioneso/moss/pull/3052)

#### Fixed

- **Timed-out quick checks now appear in Activity.** When a quick check runs past its time limit, the activity log now says so instead of showing nothing. [PR #3064](https://github.com/motioneso/moss/pull/3064)
- **Connection classifier counts only tools that can answer.** The classifier panel on a connection page no longer counts look-up tools that it can never offer. [PR #3062](https://github.com/motioneso/moss/pull/3062)
- **Repeated notices keep their own cards.** When two notices arrive with the same title, each one now keeps its own card with its own details. [PR #3063](https://github.com/motioneso/moss/pull/3063)
- **Small settings screen fixes.** Admin menu labels now meet the minimum text size, and the Activity filter row wraps instead of running off the edge on narrow phones. [PR #3060](https://github.com/motioneso/moss/pull/3060)

### 2026-10-04

#### Fixed

- **Classifier trial counts connected tools correctly.** The classifier trial report now counts a correct pick of a connected tool as a match instead of a miss. [PR #3050](https://github.com/motioneso/moss/pull/3050)
- **Model filter list on Activity looks right again.** The list of models you can filter by on the Activity page now shows tidy single-line rows with normal-size checkboxes. [PR #3048](https://github.com/motioneso/moss/pull/3048)
- **Kept-out tools left out of trial comparisons.** Trial comparisons no longer identify kept-out tools as the tool chat used; the original message text is still saved. [PR #3037](https://github.com/motioneso/moss/pull/3037)
- **Moss no longer stalls for minutes on some requests.** Moss stays responsive while it indexes your notes and memory in the background, and checking your email no longer hangs for minutes. [PR #3030](https://github.com/motioneso/moss/pull/3030)
- **Top bar readable in custom themes.** The top bar stays readable when you make a custom theme while dark mode is on. [PR #3018](https://github.com/motioneso/moss/pull/3018)
- **Task window close button back in the corner.** The close button on the task details window now sits in the top-right corner, and the title lines up with the rest of the form. [PR #3007](https://github.com/motioneso/moss/pull/3007)
- **Clearer notice about what is shared when preparing tools.** The notice shown before preparing a connection's tools now says plainly that text from the service, such as tool descriptions, is sent as written and is not checked for secrets. [PR #2996](https://github.com/motioneso/moss/pull/2996)

#### Changed

- **Moss now runs tools it is sure about by itself.** With the Classifier switched on, Moss can now run a tool it is confident about without asking, and the confidence needed for tools that send things out or delete things is slightly lower. [PR #3045](https://github.com/motioneso/moss/pull/3045)
- **Clearer classifier controls on each connection.** Each connection now shows whether its safety check is off, getting ready, ready or needs attention, lets you keep a single tool out of it with an undo, and shows tools by a readable name. [PR #3033](https://github.com/motioneso/moss/pull/3033)
- **Your assistant's name now shows everywhere.** The name you give your assistant now appears throughout the app, including the loading screen, menu and settings, instead of the word Moss. [PR #3032](https://github.com/motioneso/moss/pull/3032)
- **Catch-up shows the emails worth your attention.** The catch-up section on Today now lists each email worth knowing about, who it is from and what it says, with buttons to open it, reply, turn it into a task, or dismiss it. [PR #3031](https://github.com/motioneso/moss/pull/3031)
- **A clearer page for each connection.** Opening a connection now uses the full width, groups its tools by what they do, marks the ones that ask before running, and lets you allow sending tools to send without asking. [PR #3014](https://github.com/motioneso/moss/pull/3014)
- **Today header contour lines are back.** The faint contour lines behind the Today header are back. [PR #3017](https://github.com/motioneso/moss/pull/3017)
- **Connection tools get ready for the classifier on their own.** When you turn on the classifier for a connection, Moss now prepares that connection's tools in the background, and again whenever you switch a tool back on, so you no longer review each tool by hand before it can be used. [PR #3009](https://github.com/motioneso/moss/pull/3009)
- **Safe connected tools run without asking.** When a connected service's tool is sorted as only looking things up or changing things, Moss now uses it in chat without asking you first, while sensitive tools, tools that send things out and tools not yet sorted still ask. [PR #3011](https://github.com/motioneso/moss/pull/3011)
- **Same date line on every page.** Every page now shows today's date under its title, the way Wellness does. [PR #3008](https://github.com/motioneso/moss/pull/3008)
- **Connected tools are sorted by what they do.** When you add or refresh a connection, Moss now asks your chat model to sort each of its tools by what it does, which uses some of your model allowance and shows up in your activity history. [PR #3006](https://github.com/motioneso/moss/pull/3006)
- **One activity history for everything Moss does.** Your Activity page now shows every kind of work Moss did for you, with what happened, how long it took, and the details of each step. Filter by time, module, or model; your choices are remembered. [PR #2976](https://github.com/motioneso/moss/pull/2976)

#### Added

- **Choose your page header colour.** Custom themes can now set the colour of the header at the top of every page. [PR #3021](https://github.com/motioneso/moss/pull/3021)
- **A redesigned theme editor with a nav bar color.** Your own color themes can now set the color of the navigation bar, pick from a pasted palette in every color box, and change a color by clicking that part of the preview. [PR #3004](https://github.com/motioneso/moss/pull/3004)

### 2026-10-03

#### Changed

- **A refreshed Tasks page.** Tasks now pairs a park-inspired layout with a visible list index, keeping quick capture and both task views close at hand. [PR #2972](https://github.com/motioneso/moss/pull/2972)
- **Small text on Today is easier to read.** The smallest labels and notes on the Today screen are a little larger, and the layout looks the same. [PR #2948](https://github.com/motioneso/moss/pull/2948)
- **Cleaner docked chat panel.** The chat panel beside your page now sits flush against the edge with a single divider, and the message box has one outline instead of two. [PR #2958](https://github.com/motioneso/moss/pull/2958)
- **Simpler tool switches.** Each tool in a connection now has a single on/off switch, and Moss no longer refuses to repeat the same request to a connected tool. [PR #2953](https://github.com/motioneso/moss/pull/2953)

#### Fixed

- **Tool group switches.** Turning a group of tools on or off in a connection now switches every tool in that group, and the group switch shows the right state. [PR #2992](https://github.com/motioneso/moss/pull/2992)
- **Account menu is easier to reach on phones.** The account area in the navigation now shows just your name and picture, and its menu is fully visible on a phone without scrolling. [PR #2988](https://github.com/motioneso/moss/pull/2988)
- **Readable model name in chat.** The model button above the chat box now shows the model's readable name instead of a long technical code. [PR #2980](https://github.com/motioneso/moss/pull/2980)
- **Trail Marker focus checks now expire after 30 days.** Trail Marker's focus checks are now deleted after 30 days as promised, and they are included in your data export and removed when your account is deleted. [PR #2977](https://github.com/motioneso/moss/pull/2977)
- **Starting a new chat stops the current reply.** Starting a new chat now stops the reply that was still being written, so it can no longer leak into the new chat. [PR #2963](https://github.com/motioneso/moss/pull/2963)
- **Refreshing your nudges on Today works again.** Refreshing the "On your radar" nudges on Today no longer fails with an error. [PR #2967](https://github.com/motioneso/moss/pull/2967)
- **Chat box no longer disappears while typing.** If no chat model is connected, the message box stays put while you type instead of vanishing, and your draft is never lost when the connection status loads. [PR #2965](https://github.com/motioneso/moss/pull/2965)

#### Added

- **Expand button for chat.** You can now expand the chat to fill the whole screen beside the menu, and History and private chat are in a new More menu. [PR #2961](https://github.com/motioneso/moss/pull/2961)
- **Temporary classifier shadow report.** Admins can open a temporary Shadow report from the Classifier row while the gate runs in Shadow, showing how often the classifier agreed with the main chat model over the last 7, 30 or 90 days. [PR #2964](https://github.com/motioneso/moss/pull/2964)

### 2026-10-02

#### Fixed

- **Easier tapping on Today for phones.** Small links and buttons on the Today screen, such as the section links under the headline, the add-medication plus and the team story links, are now easier to tap on a phone. [PR #2947](https://github.com/motioneso/moss/pull/2947)
- **No more blank page while Moss loads.** If Moss is slow to start, you now see the loading screen right away instead of an empty page. [PR #2944](https://github.com/motioneso/moss/pull/2944)
- **Sports no longer says "a quiet night" during a game.** The Tonight section on Today no longer claims a quiet night while one of your teams is playing or has already played. [PR #2945](https://github.com/motioneso/moss/pull/2945)
- **Easier-to-read text in a few places.** Some small notes on Today, faint labels in dark mode, the Delete account button and a warning number are now easier to read. [PR #2946](https://github.com/motioneso/moss/pull/2946)
- **Chat no longer says it is ready when no AI model is connected.** When no AI model is connected, the chat panel now says so and offers a Connect a provider button instead of a message box that goes nowhere. [PR #2926](https://github.com/motioneso/moss/pull/2926)
- **Today header shows the right time of day and why a briefing is missing.** The Today header no longer says "Morning briefing" in the afternoon, and when your briefing is not ready it now tells you why or when it will run. [PR #2929](https://github.com/motioneso/moss/pull/2929)
- **Your own sent emails no longer show as needing you.** Emails you sent yourself no longer appear in your briefings as waiting for your decision. [PR #2880](https://github.com/motioneso/moss/pull/2880)

#### Changed

- **Chat now sits beside the page on wide screens.** On a wide screen, opening chat now makes room for it next to what you are looking at, so you can see your day while you ask about it. [PR #2941](https://github.com/motioneso/moss/pull/2941)
- **Settings has a new look and one Connections page.** Settings now matches the rest of the app, your connected accounts, notes folder and services live together on one Connections page, and on phones you pick a section from a menu. [PR #2935](https://github.com/motioneso/moss/pull/2935)
- **Chat panel works better with the keyboard.** Opening the chat puts the cursor in the message box, Escape closes it and takes you back to where you were, and on a phone the Tab key no longer wanders off behind the chat. [PR #2938](https://github.com/motioneso/moss/pull/2938)
- **Quieter Today on empty days.** When your briefing, priorities and evening review are all empty, Today now shows a single short line instead of three separate empty messages. [PR #2931](https://github.com/motioneso/moss/pull/2931)
- **Model activity log now lists every model call.** The admin Model activity page now also shows chat replies, background jobs, memory embeddings, and account checks, not just some of the calls Moss makes. [PR #2904](https://github.com/motioneso/moss/pull/2904)
- **Settings fills the screen and reads more plainly.** Settings now uses the full width of your screen, the Activity page describes what Moss did in plain words, and a few Settings pages have clearer names: Your assistant, AI providers and What's new. [PR #2930](https://github.com/motioneso/moss/pull/2930)
- **The sorting model is now the classifier.** The assistant settings screen calls the sorting model the classifier and adds the new classifier gate choice, which stays off until a tool is approved. [PR #2897](https://github.com/motioneso/moss/pull/2897)

#### Added

- **Ask Moss to delete your classifier trial records.** You can now ask Moss in chat to delete the private trial records the classifier keeps about your messages; Moss asks you to confirm before it deletes anything. [PR #2937](https://github.com/motioneso/moss/pull/2937)
- **Choose which connected tools the classifier may use.** The connected-service screen now lets you review each tool before the classifier may use it, with a clear risk choice, a preview of what is sent, and a switch that never turns tools on by itself. [PR #2902](https://github.com/motioneso/moss/pull/2902)
- **Model activity log.** Administrators can review the model calls the assistant makes, with the time, kind, model and result, without exposing any chat content. [PR #2900](https://github.com/motioneso/moss/pull/2900)

### 2026-10-01

#### Changed

- **Steadier morning briefing order.** Your morning briefing now lists timed events in clock order before open-ended tasks, folds quiet events into the opening, and always gives sports its own heading. [PR #2849](https://github.com/motioneso/moss/pull/2849)

#### Fixed

- **Evening review stays on your day.** The evening review no longer adds made-up remarks about your email or account setup. [PR #2877](https://github.com/motioneso/moss/pull/2877)
- **Morning briefing keeps the day in time order.** The morning briefing now lists timed items in clock order and no longer adds a section that only repeats an event's name. [PR #2859](https://github.com/motioneso/moss/pull/2859)
- **Admins keep access to shared AI providers.** When an admin who set up a shared AI provider is later demoted, the remaining admins can still see and manage it. [PR #2855](https://github.com/motioneso/moss/pull/2855)
- **All-day events stay on the right day.** All-day calendar events now show on their own date in Today and in your briefings, instead of one day early when you are west of UTC. [PR #2852](https://github.com/motioneso/moss/pull/2852)
- **Today page jump links.** Jumping to a section on the Today page now leaves a gap below the top bar instead of tucking the section underneath it. [PR #2851](https://github.com/motioneso/moss/pull/2851)
- **Quote marks in chat tool steps.** Expanding a step in the chat now shows quote marks and ampersands as normal characters instead of strange codes. [PR #2848](https://github.com/motioneso/moss/pull/2848)

### 2026-09-30

#### Added

- **Tool updates are tested before they are used.** When a newer version of the Claude or Codex tools is available, Moss now tries it out first and keeps the current one if the test fails, and the AI providers screen tells you what happened and lets you try again. [PR #2836](https://github.com/motioneso/moss/pull/2836)
- **Provider cards show the installed AI tool version.** Each AI provider card now shows which version of its helper tool is installed, and a clear message appears when the tool is too old for the chosen model. [PR #2818](https://github.com/motioneso/moss/pull/2818)
- **Favorite models in the chat model picker.** The chat model picker now groups models by provider, and you can star models to keep them at the top. [PR #2812](https://github.com/motioneso/moss/pull/2812)

#### Fixed

- **Admins see models on shared AI providers.** When one admin sets up an AI provider, other admins now see its list of models instead of an empty list. [PR #2845](https://github.com/motioneso/moss/pull/2845)
- **Briefings skip finished commitments.** Your morning and evening briefings now only mention commitments that are still open, instead of ones you have already finished or dropped. [PR #2846](https://github.com/motioneso/moss/pull/2846)
- **Refresh models on a shared AI provider.** An administrator can now refresh or add models on an AI provider that another administrator set up, instead of getting an error. [PR #2840](https://github.com/motioneso/moss/pull/2840)
- **Fresher email, clearer sync errors.** New mail shows up sooner during long catch-ups, a failed sync now says why in plain words, and a message that keeps failing stops being retried forever. The Email extraction setting is now called Email reading. [PR #2819](https://github.com/motioneso/moss/pull/2819)

#### Changed

- **Clearer task blocks on Today.** Task blocks on your Today schedule now show a Flexible tag, say Proposed when Moss is suggesting one, and note which meeting a preparation block is for. [PR #2799](https://github.com/motioneso/moss/pull/2799)

### 2026-09-29

#### Fixed

- **Evening planning shows the evening report with headings.** When you plan tomorrow, the evening report now shows its sections with proper headings and paragraphs instead of one long block of text. [PR #2815](https://github.com/motioneso/moss/pull/2815)
- **Evening briefing links open the full report.** On Today in the evening, "Read the full evening briefing" and "What informed this?" now open the full evening report instead of doing nothing. [PR #2813](https://github.com/motioneso/moss/pull/2813)
- **Moss stays up when its database restarts.** Moss no longer shuts down briefly when its database restarts. [PR #2803](https://github.com/motioneso/moss/pull/2803)
- **Email sync no longer re-checks sorted mail.** Moss no longer re-reads email it has already sorted every time it syncs, and new mail now arrives on schedule even while an older catch-up is still running. [PR #2806](https://github.com/motioneso/moss/pull/2806)
- **Clearer sources in the morning report.** The list of what informed your report now shows plain names for each source, with what each contributed. [PR #2791](https://github.com/motioneso/moss/pull/2791)
- **Cleaner Today header.** The Today header no longer has a faint line pattern behind it, and "Prepared at" now shows am or pm. [PR #2795](https://github.com/motioneso/moss/pull/2795)

#### Added

- **Re-run a briefing from chat.** You can ask Moss in chat to re-run one of your briefings, and it tells you when the new one is ready. [PR #2811](https://github.com/motioneso/moss/pull/2811)
- **Notes on finished items and tomorrow's plan.** Your evening recap now shows a short note under each finished task, and the plan for tomorrow points out real free time and tucks away task blocks already on your calendar. [PR #2802](https://github.com/motioneso/moss/pull/2802)
- **Morning Today shows where your next errand is.** The morning Today page now adds a short note naming a later event today that has a place, with its time, and shows nothing when no event has one. [PR #2801](https://github.com/motioneso/moss/pull/2801)
- **News note on Today.** The news section on your Today page now has a short "Your news, in context" note under the smaller stories. [PR #2798](https://github.com/motioneso/moss/pull/2798)

#### Changed

- **Smarter email sorting.** Moss can now sort your email with your chosen sorting model, and it keeps receipts, confirmations and account notices out of your briefings while leaving them in your mail and search. [PR #2808](https://github.com/motioneso/moss/pull/2808)
- **Evening open loops offer choices.** In the evening, each open item now says why it is still open and lets you move it to tomorrow, pick another day, or let it go. [PR #2800](https://github.com/motioneso/moss/pull/2800)
- **Morning side column shows what moved overnight.** The morning Today page now tells you when a block in your plan moved since your morning report was prepared, and no longer repeats your counts and agenda beside the schedule. [PR #2797](https://github.com/motioneso/moss/pull/2797)

### 2026-09-28

#### Fixed

- **Evening Today no longer repeats the day's schedule.** The evening version of the Today page no longer shows a second copy of your schedule after the open loops. [PR #2794](https://github.com/motioneso/moss/pull/2794)
- **Sports on Today no longer comes up empty when the page loads.** Sports scores and headlines on the Today page now load reliably even when many things on the page are fetching at once. [PR #2780](https://github.com/motioneso/moss/pull/2780)
- **Sports live browser helper works in the packaged install.** Sports can use its live browser helper again to find game sources in the packaged install. [PR #2778](https://github.com/motioneso/moss/pull/2778)
- **Cleaner morning briefing text.** The morning briefing no longer shows stray "Headline:" and "Lead:" labels, and the full briefing now opens with a clear lead paragraph followed by lighter, easier-to-scan sections. [PR #2769](https://github.com/motioneso/moss/pull/2769)
- **Evening briefing mentions your email again.** The evening briefing now covers email that arrived today, including mail that may need you, suggested commitments and worth-knowing updates, instead of always saying there was no email. [PR #2772](https://github.com/motioneso/moss/pull/2772)
- **Morning briefing shows the right email and tasks.** The morning briefing now mentions email that may need you, suggested commitments and worth-knowing updates, and lists only tasks you finished since the last briefing instead of every task you ever completed. [PR #2768](https://github.com/motioneso/moss/pull/2768)
- **Evening briefing no longer repeats itself on Today.** The evening view on Today now shows each part of your evening briefing once, in the section it belongs to, instead of repeating the whole briefing three times. [PR #2762](https://github.com/motioneso/moss/pull/2762)

#### Changed

- **Fuller morning briefing.** Your morning briefing now walks through the day's events in order with their times and places, includes today's forecast, and says plainly what to prepare. [PR #2773](https://github.com/motioneso/moss/pull/2773)

### 2026-09-27

#### Fixed

- **Wrapped Tonight rows align with the section edge.** The first game on each row of the Sports Tonight list now lines up with the rest instead of sitting indented behind a stray divider line. [PR #2754](https://github.com/motioneso/moss/pull/2754)
- **News no longer repeats one story across outlets.** The news area on the Today screen no longer shows the exact same story more than once when several outlets carry it. [PR #2750](https://github.com/motioneso/moss/pull/2750)
- **The full morning briefing is properly formatted.** Headings, emphasis and lists in the morning briefing now display as formatting instead of stray symbols. [PR #2741](https://github.com/motioneso/moss/pull/2741)
- **Chat shows action results after a slow start.** Chat now shows what it did, and asks for approvals, even when chat finished setting up after the page opened. [PR #2740](https://github.com/motioneso/moss/pull/2740)

#### Changed

- **Morning report names what each source added.** The full morning briefing lists each source with its time and what it contributed to the report. [PR #2756](https://github.com/motioneso/moss/pull/2756)
- **Live game cards show the quarter, period, or inning.** A followed team's card that shows a live score now also shows where the game is (like "Q3 4:12"), and the card is the same height as when it shows the team's next game. [PR #2755](https://github.com/motioneso/moss/pull/2755)
- **Needs You includes at-risk tasks.** Today now groups overdue and at-risk tasks under Needs You and includes them in the count. [PR #2719](https://github.com/motioneso/moss/pull/2719)
- **A clearer full morning briefing.** The full morning briefing explains the day in more detail while Today stays focused on actions. [PR #2726](https://github.com/motioneso/moss/pull/2726)

#### Added

- **First-meeting card shows real preparation time.** Today's first-meeting card now tells you about a real preparation block before the meeting, when one exists, and links straight to that meeting instead of just the calendar. [PR #2758](https://github.com/motioneso/moss/pull/2758)
- **Open time and breaks in the day's schedule.** The Today page's schedule now shows the gaps between your task blocks and appointments — a short break, or open time — and tells you when the day's commitments are done. [PR #2751](https://github.com/motioneso/moss/pull/2751)

### 2026-09-26

#### Fixed

- **Persona preview hint for free-text personas.** The Assistant settings preview now invites you to press Preview to hear how your assistant actually sounds, instead of showing a made-up sample or an old one after you make changes. [PR #2725](https://github.com/motioneso/moss/pull/2725)
- **Assistant response preview works with connected agents.** Preview response now shows a real answer when your assistant uses a connected command-line agent. [PR #2739](https://github.com/motioneso/moss/pull/2739)
- **AI chats use selected provider.** Chats now use the AI assistant selected by an administrator. [PR #2727](https://github.com/motioneso/moss/pull/2727)
- **Removing this device fully turns off its push notifications.** Removing the device you are using from notification settings now also asks that browser to cancel its push registration, and turning notifications back on afterwards no longer leaves a duplicate device behind. [PR #2723](https://github.com/motioneso/moss/pull/2723)
- **Standings say when they could not be updated.** When the latest standings cannot be fetched, the standings area now says so instead of looking empty or out of date without explanation. [PR #2722](https://github.com/motioneso/moss/pull/2722)
- **Use newly available Codex models.** Codex chat can use newer models offered after refreshing the model list without requiring a new sign-in or installation. [PR #2721](https://github.com/motioneso/moss/pull/2721)
- **Old assistant activity history cleared out again.** Old assistant activity history is now cleared out on schedule again, instead of piling up forever. [PR #2724](https://github.com/motioneso/moss/pull/2724)
- **Clearer morning briefing recovery.** The morning briefing now explains when email may be behind, what informed the report when no evening plan was available, and when a retry needs attention. [PR #2711](https://github.com/motioneso/moss/pull/2711)
- **YOLO approvals for Codex tools.** Codex command requests now honor your active YOLO setting while retaining blocked-path checks. [PR #2718](https://github.com/motioneso/moss/pull/2718)
- **Newer Codex models.** Moss can now show newer models available through your Codex account. [PR #2716](https://github.com/motioneso/moss/pull/2716)

#### Added

- **Refresh stale email before the morning briefing.** When email has not synced in over a day, you can refresh it and see a new morning briefing once syncing completes. [PR #2715](https://github.com/motioneso/moss/pull/2715)

### 2026-09-25

#### Fixed

- **Clearer Today follow-up count.** Today’s follow-up count now includes visible loose ends, and email catch-up appears as a short informational summary. [PR #2710](https://github.com/motioneso/moss/pull/2710)
- **Keep the morning briefing open when today's plan is unavailable.** Your morning briefing stays open when today's task plan is unavailable, with a clear message. [PR #2704](https://github.com/motioneso/moss/pull/2704)
- **Codex works for everyone once an administrator connects it.** When an administrator connects Codex, everyone on the same Moss instance can now chat and run background tasks with it, without signing in themselves. [PR #2694](https://github.com/motioneso/moss/pull/2694)
- **Background AI tasks sign in reliably for every user.** Background tasks such as email sorting now sign in to Claude correctly for each person on a shared Moss instance. [PR #2693](https://github.com/motioneso/moss/pull/2693)

#### Changed

- **More control over tomorrow.** Moss previews placement edits before you save and uses your day-capacity choice to plan more or fewer task blocks. [PR #2712](https://github.com/motioneso/moss/pull/2712)

### 2026-09-24

#### Fixed

- **Background AI tasks work again with the newest Claude models.** Job scoring, briefings and email reading stopped working when Moss used the newest Claude model, and now run again. [PR #2688](https://github.com/motioneso/moss/pull/2688)
- **Moss knows where every setting lives.** Moss now points you to the right settings page when you ask it where to change something. [PR #2677](https://github.com/motioneso/moss/pull/2677)
- **Background AI jobs keep working after heavy use.** Background AI jobs like briefing writing and email sorting no longer stop working after heavy use. [PR #2675](https://github.com/motioneso/moss/pull/2675)
- **Sports scores are back.** Scores, results and schedules show up again on the Sports page and the Today card, and the Sports page now tells you when it could not get fresh scores. [PR #2684](https://github.com/motioneso/moss/pull/2684)
- **Briefings are written by your AI subscription.** Morning and evening briefings are now written by the AI model you signed in with, instead of arriving as a plain list. [PR #2665](https://github.com/motioneso/moss/pull/2665)
- **Backup briefing text no longer takes over Today.** When Moss cannot write your briefing, the Today page now keeps its normal header instead of showing a raw list of counts. [PR #2664](https://github.com/motioneso/moss/pull/2664)
- **Clearer chat error when per-user mode is off.** Chat now explains how to fix it when the server is set up without per-user mode, instead of showing a generic unavailable message. [PR #2544](https://github.com/motioneso/moss/pull/2544)
- **National team follows no longer pull in the whole World Cup.** Following a national team now shows that team's own news and keeps its tournament's standings out of the way unless the tournament is running. [PR #2663](https://github.com/motioneso/moss/pull/2663)
- **Morning briefings no longer fail when you follow sports teams.** Morning briefings now finish even if one source has a problem, and they can include your followed teams again. [PR #2658](https://github.com/motioneso/moss/pull/2658)
- **Readable account name in the sidebar.** The account name in the sidebar is readable again, and the Settings entry in the account menu no longer spills out of its box. [PR #2656](https://github.com/motioneso/moss/pull/2656)
- **Photos and team logos stay on Today.** Sports photos and team logos no longer disappear until a hard refresh, and more news stories on Today now show their photo. [PR #2654](https://github.com/motioneso/moss/pull/2654)
- **No false warning after saving tomorrow's plan.** Saving tomorrow's plan in the evening no longer shows a warning that the plan changed. [PR #2650](https://github.com/motioneso/moss/pull/2650)

#### Changed

- **Sports page team cards match Today.** The team cards along the top of the Sports page now use the same clean look as the sports cards on Today, with the next game shown as text at the bottom of each card. [PR #2667](https://github.com/motioneso/moss/pull/2667)
- **Chat skill suggestions use the normal font.** The skill suggestions that pop up while you type in chat now use the same font as the rest of the app. [PR #2668](https://github.com/motioneso/moss/pull/2668)
- **Next game lines up across your team cards on Today.** On Today, each team's next game now sits at the bottom of its card, so they line up neatly across the row. [PR #2666](https://github.com/motioneso/moss/pull/2666)
- **Faster News and Sports filters.** Your News and Sports filters now remember which stories they have already checked, so refreshing the page is quicker. [PR #2662](https://github.com/motioneso/moss/pull/2662)
- **Faster story filters with a sorting model.** When you set a sorting model, News and Sports use it to check stories against your saved preferences, so refreshes are much faster. [PR #2627](https://github.com/motioneso/moss/pull/2627)
- **Smoother dark mode details.** In dark mode, divider lines are easier to see and hover highlights now use a soft tint of your theme color instead of a bright block. [PR #2655](https://github.com/motioneso/moss/pull/2655)
- **Dark mode keeps your theme colors.** In dark mode every color theme now keeps its real accent color instead of switching to a pale version, and Sage looks right again. [PR #2653](https://github.com/motioneso/moss/pull/2653)
- **Cleaner followed teams on Today.** Your followed teams and leagues on the Today page now appear as newspaper-style columns with their logos and colors. [PR #2652](https://github.com/motioneso/moss/pull/2652)
- **Trail-map texture on the Today header.** The Today header now has a faint trail-map pattern behind it. [PR #2651](https://github.com/motioneso/moss/pull/2651)

#### Added

- **More women's leagues and standings that remember where you were.** Sports now covers more women's competitions and the Women's Pro Baseball League, and the standings picker opens the league and division you last looked at. [PR #2669](https://github.com/motioneso/moss/pull/2669)
- **Artwork for news stories without a photo.** When the lead story on Today has no photo, Moss now shows a drawn contour print in the story's topic colors instead of an empty space. [PR #2657](https://github.com/motioneso/moss/pull/2657)

### 2026-09-23

#### Changed

- **Pause All and a Focus switch.** The Trail Marker menu now has Pause All, plus a switch to pause just Focus, in Moss's forest green. [PR #2645](https://github.com/motioneso/moss/pull/2645)
- **Pause and Resume in the Trail Marker menu.** The Trail Marker menu now has one Pause / Resume button that stops everything, replacing Disconnect and Pause Focus. [PR #2635](https://github.com/motioneso/moss/pull/2635)
- **Simpler Trail Marker menu.** The Trail Marker menu no longer has Judge Now or Check for Updates; Trail Marker checks your focus on its own, and updates are in Settings. [PR #2631](https://github.com/motioneso/moss/pull/2631)

#### Fixed

- **Trail Marker privacy fixes.** Trail Marker now only ever looks at the window you're using, stops everything while paused, and forgets its settings when you log out. [PR #2644](https://github.com/motioneso/moss/pull/2644)
- **Trail Marker approval page styling.** The page where you approve a Mac for Trail Marker now uses Moss's usual heading style. [PR #2632](https://github.com/motioneso/moss/pull/2632)

#### Added

- **Choose apps Trail Marker never watches.** You can now pick apps, like your banking app, that Trail Marker never looks at, even when it watches your whole screen. [PR #2634](https://github.com/motioneso/moss/pull/2634)

### 2026-09-22

#### Fixed

- **Next match for soccer teams.** Soccer teams you follow now show their next match on the Sports page. [PR #2614](https://github.com/motioneso/moss/pull/2614)
- **Better email reviews for non-Gmail mailboxes.** Email arriving over a standard mail account is now reviewed using its message text instead of only its subject line. [PR #2598](https://github.com/motioneso/moss/pull/2598)
- **Assistant knows where settings live again.** The assistant no longer points at settings pages that no longer exist, and now describes Wellness, Memory, Notes, Tasks, Chat and connected accounts according to what they really do today. [PR #2622](https://github.com/motioneso/moss/pull/2622)
- **Host details show the app version and commit.** The Environment, Version, Commit and Deploy mode fields under Settings > Host > Technical details now show real values instead of being blank, and on a pinned release Moss tells you when a newer version is available. [PR #2601](https://github.com/motioneso/moss/pull/2601)

#### Changed

- **Clearer Mac linking; Trail Marker can now judge focus with Jev.** When you link a Mac, the approval page now lists exactly what that Mac will be able to do, and Settings explains how to connect it. Trail Marker's focus judgment can now use TypeSafe's Jev model, in addition to any other model you've configured. [PR #2584](https://github.com/motioneso/moss/pull/2584)
- **Marketing mail sorted straight away.** Marketing mail from senders you do not know is now left out sooner, without the extra review. [PR #2600](https://github.com/motioneso/moss/pull/2600)

#### Added

- **Trail Marker focus check-ins.** While a focus block you scheduled in Moss is on, Trail Marker can check which app you are in, and — when the title alone isn't enough to tell — can look at the screen once to describe it, then nudge you if you've drifted off task. [PR #2578](https://github.com/motioneso/moss/pull/2578)
- **Sorting model.** Pick a small, fast model to sort and filter your news and sports stories. If it does not answer, Moss tries your main model instead. [PR #2623](https://github.com/motioneso/moss/pull/2623)

### 2026-09-20

#### Added

- **Trail Marker for Mac (early build).** A Mac menu-bar app can now link to your account and show up under Active sessions; it does not observe your activity. [PR #2568](https://github.com/motioneso/moss/pull/2568)
- **Link a Mac to your account.** You can now approve a Mac companion app from your browser and see or sign out each linked Mac from Active sessions. [PR #2564](https://github.com/motioneso/moss/pull/2564)

#### Changed

- **Trail Marker menu and setup window redesign.** The Trail Marker menu-bar card and setup window now follow the approved design. [PR #2573](https://github.com/motioneso/moss/pull/2573)

### 2026-09-15

#### Changed

- **Today schedule reads as an editorial timeline.** The Today schedule now shows numbered head, legend and timeline rows with committed and proposed blocks visibly distinct, and the right rail leads with quick actions. No page behavior changes; section links and dialogs behave as before. [PR #2512](https://github.com/motioneso/moss/pull/2512)
- **Today opens with a hero band.** The Today page now opens with a dark green hero carrying Moss's assessment headline, summary, prepared time and weather, with the section links directly below. No page behavior changes; section links behave as before. [PR #2511](https://github.com/motioneso/moss/pull/2511)
- **Design-fidelity token foundation.** Adds the two missing Archivo weights and the shared theme-aware palette tokens later design slices build on. Nothing visible moves except semibold text now uses the true face. [PR #2504](https://github.com/motioneso/moss/pull/2504)
- **A prepared day, from evening to morning.** Today now plans tomorrow in the evening and reports overnight changes in the morning briefing. [PR #2502](https://github.com/motioneso/moss/pull/2502)

#### Added

- **Collapsible desktop navigation rail.** The sidebar now collapses to an icon-only rail on desktop via a Collapse navigation button, and remembers the choice across reloads. Phones keep the existing navigation drawer unchanged. [PR #2509](https://github.com/motioneso/moss/pull/2509)

### 2026-09-12

#### Added

- **Save a day-plan draft.** You can save evening intent and draft blocks on an existing saved day plan with revision protection. [PR #2471](https://github.com/motioneso/moss/pull/2471)
- **Save a day plan.** You can create an empty saved day plan for a chosen day and timezone. [PR #2469](https://github.com/motioneso/moss/pull/2469)

### 2026-09-11

#### Fixed

- **Shared CLI startup repair.** Moss automatically repairs older shared CLI installations so separate accounts can use the pinned software without reinstalling. [PR #2458](https://github.com/motioneso/moss/pull/2458)
- **Clarify Codex sign-in recovery.** Moss now distinguishes an account without a usable Codex sign-in from a provider failure and explains the administrator-only recovery path. [PR #2456](https://github.com/motioneso/moss/pull/2456)

### 2026-09-07

#### Changed

- **Workshop project list cleanup.** The Workshop project list page is tidier: renaming a project now lives in its menu, pressing Enter sends a chat message, and the page header and row highlighting got small visual polish. [PR #2405](https://github.com/motioneso/moss/pull/2405)

### 2026-09-06

#### Changed

- **Clearer message when an action is not approved.** When Moss does not approve an action, it now says so in plain words and asks the agent to tell you instead of trying again. [PR #2382](https://github.com/motioneso/moss/pull/2382)
- **A cleaner Workshop home page.** The Workshop home page now shows your projects in a simple list with a clear title bar, instead of a grid of cards, and drops an old, unused page. [PR #2364](https://github.com/motioneso/moss/pull/2364)
- **Email summaries that take too long are now dropped instead of arriving late.** If summarising an email takes longer than the allowed time, you now get no summary for that email instead of getting a correct summary a bit later than usual. [PR #2355](https://github.com/motioneso/moss/pull/2355)
- **A new display typeface and a lighter page colour across the app.** Headings use a new typeface and pages sit on a lighter background across the app. [PR #2333](https://github.com/motioneso/moss/pull/2333)
- **The assistant no longer asks permission every time it reads a web page.** When the assistant reads a web page for you, it now just does it, the same way it already does for a web search, instead of stopping to ask you to approve every single page it looks at. [PR #2331](https://github.com/motioneso/moss/pull/2331)

#### Fixed

- **Assistant chat home folder mismatch.** Fixed a problem that could make the assistant take a long time to answer, or fail with a confusing error, because of where its answer was being saved. [PR #2358](https://github.com/motioneso/moss/pull/2358)
- **Fresh accounts get working chat tools automatically.** A brand-new account running from source now gets a chat-tools folder it can actually write to, instead of silently failing because the old default pointed at a folder only the Docker image could create. [PR #2354](https://github.com/motioneso/moss/pull/2354)
- **A private module you are still building can now actually run.** A private module the owner is still building can now run and save its own data while it is still a draft, and nobody else can see or use it. [PR #2353](https://github.com/motioneso/moss/pull/2353)
- **App no longer sticks on the loading screen on slow days.** The app used to get stuck on its loading screen when one startup check was slow, and now it waits for the answer instead of asking again until nothing responds. [PR #2344](https://github.com/motioneso/moss/pull/2344)

#### Added

- **Project workspace with top bar trail.** Workshop projects now open as a chat window with the project name in the top bar, starting a project needs no form, Moss replies show formatting instead of raw marks, and you can rename a project from the top bar or delete it from the More button. [PR #2376](https://github.com/motioneso/moss/pull/2376)
- **Moss replies in Workshop projects.** When you save a message in a Workshop project, Moss now writes back a reply in the same conversation instead of leaving it waiting forever. [PR #2365](https://github.com/motioneso/moss/pull/2365)
- **Workshop projects.** You can now start a Workshop project, give it a name and a first request, and come back to it later with everything you have written saved. [PR #2307](https://github.com/motioneso/moss/pull/2307)

### 2026-09-05

#### Fixed

- **Chat can use its tools again.** Chat could answer questions but could not actually do anything with your information; it can now use its tools again. [PR #2318](https://github.com/motioneso/moss/pull/2318)
- **Email stops filling your day with things that are not really tasks.** Moss now decides for itself whether an email actually asks something of you, instead of turning ordinary mail into task suggestions, so your day view stays about real commitments. [PR #2279](https://github.com/motioneso/moss/pull/2279)
- **Publisher icons no longer touch the headline text.** In the news list on the Today page, the small publisher icon now has a little space between it and the headline instead of being pressed right up against it. [PR #2311](https://github.com/motioneso/moss/pull/2311)
- **Complete first-run setup.** New installations now generate all required credential keys and keep the selected release version during setup. [PR #2299](https://github.com/motioneso/moss/pull/2299)
- **News publisher icons.** Publisher icons on the Today news card now show for NPR and read clearly in both light and dark mode. [PR #2294](https://github.com/motioneso/moss/pull/2294)
- **Sports search results grouped by league.** Searching for a team in Sports settings now shows results grouped under their own league or sport, so teams with the same name in different sports are no longer mixed together. [PR #2281](https://github.com/motioneso/moss/pull/2281)
- **Chat settings "Set up" link opens Assistant & AI.** The Set up link under Voice input in Chat settings now opens the Assistant & AI page instead of Account & preferences. [PR #2220](https://github.com/motioneso/moss/pull/2220)

#### Added

- **Encryption keys screen covers all three key families.** Owners can now generate and rotate all three encryption keys from the Settings screen, and fresh installs start with a banner that walks them through setup instead of needing hand-edited secret files. [PR #2323](https://github.com/motioneso/moss/pull/2323)
- **Encryption keys screen in Admin settings.** Admins can now set up missing encryption keys from a new Encryption keys page instead of editing server files, and Moss tells them when a key needs attention. [PR #2315](https://github.com/motioneso/moss/pull/2315)
- **Push notifications.** You can now turn on browser push notifications so you see notifications from Moss even when the tab isn't open, from Settings -> Notifications. [PR #2234](https://github.com/motioneso/moss/pull/2234)
- **Web search is now on by default for chat.** Chat can now search the web automatically using your AI model's own built-in search, or a Brave Search key if you add one, so answers can include current information with sources shown. [PR #2280](https://github.com/motioneso/moss/pull/2280)
- **Sports settings shows whether each source has photos.** Each of your own sports sources now shows whether its stories are getting photos, and lets you stop using photos Moss found for it. [PR #2273](https://github.com/motioneso/moss/pull/2273)

#### Changed

- **News settings now say "sources" instead of "publications".** In the news settings, wording that used to say "publications" now says "sources", since a source can be a subreddit as well as a publication. [PR #2298](https://github.com/motioneso/moss/pull/2298)

### 2026-09-04

#### Changed

- **Verification codes never become a task.** A login or verification code email is now always left out of your task suggestions and daily summary, so a temporary sign-in code never shows up as something to act on. [PR #2257](https://github.com/motioneso/moss/pull/2257)
- **Today's news list shows publisher icons.** The News desk widget on Today now shows each story's publisher as a small icon instead of just the name, with the name still available if you hover over it. [PR #2252](https://github.com/motioneso/moss/pull/2252)

#### Fixed

- **Mode bindings now pick the newest model in the tier.** When several models share a tier (for example two Sonnets), the assistant now uses the most recently released one by default instead of whichever happened to register last. [PR #2219](https://github.com/motioneso/moss/pull/2219)
- **Settings search finds module settings.** Searching settings (for example, typing News) now also finds a module's own settings and takes you straight there. [PR #2254](https://github.com/motioneso/moss/pull/2254)

### 2026-09-01

#### Added

- **Modules Moss builds can add new things it can do.** When Moss finishes building a module with a new chat ability, that ability is [PR #2101](https://github.com/motioneso/moss/pull/2101)
- **Connect Moss to external tools.** You can now connect Moss to services that speak MCP or publish an OpenAPI spec from Settings, and use their features from chat. [PR #2171](https://github.com/motioneso/moss/pull/2171)

### 2026-08-31

#### Added

- **Moss can check the exact current time.** When Moss needs to know exactly what time it is, it can now check a live clock instead of relying only on stale context. [PR #2150](https://github.com/motioneso/moss/pull/2150)

#### Fixed

- **Timezone-safe meal logging.** Meals logged with a local time are now saved on the correct calendar day. [PR #2155](https://github.com/motioneso/moss/pull/2155)
- **More reliable memory and notes actions.** The assistant now looks for Moss's built-in tools first when saving or changing your information, instead of reporting a false failure after trying an unrelated tool. [PR #2144](https://github.com/motioneso/moss/pull/2144)
- **Show useful safe messages when note changes fail.** When a note change is blocked for a known safe reason, Moss now explains the reason instead of showing only a generic failure message. [PR #2148](https://github.com/motioneso/moss/pull/2148)

### 2026-08-30

#### Fixed

- **Chat action labels now say what actually happened.** the small label next to an assistant action now reports Executed, Allowed, Failed, or Denied instead of guessing whether something changed. [PR #2116](https://github.com/motioneso/moss/pull/2116)
- **Self-hosted HTTPS now works reliably from Firefox.** Fixed a bug where visiting your self-hosted server's address directly by its numeric network address in Firefox (rather than a name) could fail to load over a secure connection. [PR #2105](https://github.com/motioneso/moss/pull/2105)
- **Standings dropdown now updates immediately when you follow or unfollow a team.** Following or unfollowing a team in Settings now updates the standings dropdown on the Sports page right away, instead of showing outdated followed status until you navigated away and back. [PR #2094](https://github.com/motioneso/moss/pull/2094)
- **Removed the story feedback control from the sports Followed-teams strip.** The "More like this / Less like this" option no longer appears on the team cards in the Followed strip on the Sports page. It still appears everywhere else, including the same team cards on the Today page. [PR #2076](https://github.com/motioneso/moss/pull/2076)

#### Changed

- **Assistant always knows the current date and time.** The assistant now checks the real current date and time at the start of every message, so its answers about "today," "now," or elapsed time stay accurate even in long conversations. [PR #2129](https://github.com/motioneso/moss/pull/2129)

### 2026-08-29

#### Added

- **Curated sports standings leagues.** Users can choose which leagues appear in standings and quickly reach leagues connected to teams they follow. [PR #2069](https://github.com/motioneso/moss/pull/2069)

#### Changed

- **GitHub removed from Connected accounts.** The GitHub option no longer appears when you add a connected account, since GitHub support is not planned. [PR #2070](https://github.com/motioneso/moss/pull/2070)

### 2026-08-28

#### Added

- **Workflow approvals.** You can approve or reject a workflow step in chat, and approved steps continue safely. [PR #2065](https://github.com/motioneso/moss/pull/2065)

#### Fixed

- **Email sync and medication updates stay reliable.** Moss now preserves contact details when optional Google email extraction is unavailable and immediately shows newly added medications. [PR #2059](https://github.com/motioneso/moss/pull/2059)

#### Changed

- **Release notes stay grouped by date.** What's New now keeps updates together by the day they were released. [PR #1896](https://github.com/motioneso/moss/pull/1896)

### 2026-08-27

#### Added

- **Sports story preferences.** You can now tell Sports which stories you want to see more or less of and manage those choices in Sports Settings. [PR #2052](https://github.com/motioneso/moss/pull/2052)
- **Ask Moss about its health.** Moss can explain its current service health and request a news refresh when you ask. [PR #2056](https://github.com/motioneso/moss/pull/2056)
- **News story feedback.** You can now ask News for more or less of a story and manage those choices in News Settings. [PR #2049](https://github.com/motioneso/moss/pull/2049)
- **Chat with Google's Gemini.** You can now sign in to Google's Gemini and pick it for chat, alongside Claude and Codex. [PR #2048](https://github.com/motioneso/moss/pull/2048)
- **Sign in to Gemini from Settings.** You can now sign in to Google's Gemini command-line tool from Settings or the first-run wizard, the same way you already sign in to Claude and Codex. [PR #2042](https://github.com/motioneso/moss/pull/2042)
- **Install the Gemini command-line tool.** You can now install the Gemini command-line tool from the app, pinned to a known, verified version. [PR #2039](https://github.com/motioneso/moss/pull/2039)
- **Archiving status in Settings.** Settings now shows a short message if the daily chat archive to Notes couldn't run, so you know when it needs attention. [PR #1995](https://github.com/motioneso/moss/pull/1995)
- **Edit a saved medication.** You can now edit a medication's name, dose, or schedule after saving it, instead of removing it and adding it again. [PR #1989](https://github.com/motioneso/moss/pull/1989)
- **Add medications on any schedule.** You can now set up a medication on any schedule the app supports - every day, only on certain days of the week, every few days or weeks or months, monthly, or in a cycle of days on and days off - and see in plain words what you picked, along with the next three doses, before you save it. [PR #1985](https://github.com/motioneso/moss/pull/1985)
- **Save your chats to Notes.** You can now turn on a setting that saves a daily written copy of your chats into your notes, off by default, in a folder you choose. [PR #1980](https://github.com/motioneso/moss/pull/1980)
- **See your module build progress and get notified when it's done.** When you ask Moss to build you a new page and approve the plan, you're now taken straight to the Workshop page where you can watch it build, and you get a notification the moment it finishes or fails. [PR #1966](https://github.com/motioneso/moss/pull/1966)
- **Sports news source coverage.** Choose ESPN or custom publishers for entire sports, leagues, and teams to build a mixed news feed. [PR #1967](https://github.com/motioneso/moss/pull/1967)
- **Throw away a draft module.** If a module Moss built for you is not what you wanted, you can now delete it from the draft banner. [PR #1942](https://github.com/motioneso/moss/pull/1942)
- **Ask Moss for a new module right in chat.** Tell Moss what you want a new module to do and it will come back with a plan you can read and approve before any work starts. [PR #1940](https://github.com/motioneso/moss/pull/1940)
- **Fleet launcher and overnight viewer.** Start the fleet from one terminal screen, follow its lanes, pause work safely, and preview a rescue before starting it. [PR #1911](https://github.com/motioneso/moss/pull/1911)

### 2026-08-22

#### Added

- **Choose your weather place and temperature units.** You can choose the place used for your weather and switch temperatures between Celsius and Fahrenheit. [PR #1826](https://github.com/motioneso/moss/pull/1826)
- **Custom sports news sources.** You can now add your own sports news sources by URL in Sports settings, preview what Moss found, and assign them to your followed teams and leagues. [PR #1825](https://github.com/motioneso/moss/pull/1825)
- **Workshop page.** Admins now have a Workshop page showing which modules Moss is building, has finished, or has made live, with anything waiting on a decision from you called out first. [PR #1804](https://github.com/motioneso/moss/pull/1804)
- **Log a meal from the Food page.** The Food page now has its own Log a meal button, so you can
  add a meal without going through chat. [PR #1788](https://github.com/motioneso/moss/pull/1788)
- **Food tracking (Phase 1).** Log meals, get an estimated nutrition breakdown, and review what
  you've eaten so far today. [PR #1716](https://github.com/motioneso/moss/pull/1716)
- **More reliable calendar changes.** Creating, rescheduling, and deleting calendar events now
  goes through a more reliable lookup step, so the assistant confirms it has the right event
  before changing it. [PR #1703](https://github.com/motioneso/moss/pull/1703)
- **Recently Released.** Settings now includes a read-only release history so you can see what
  Moss has added, fixed, and changed. [PR #1630](https://github.com/motioneso/moss/pull/1630)
- **Recall relevant notes before answering.** Chat can use relevant notes as context before it
  answers, making note-backed conversations more useful. [PR #1619](https://github.com/motioneso/moss/pull/1619)
- **Threaded chat routing.** Chat sends now preserve the active thread surface so replies stay
  attached to the conversation you started. [PR #1574](https://github.com/motioneso/moss/pull/1574)
- **Vault ingestion.** Notes and other approved vault content can be ingested through the new
  allowlisted ingestion path. [PR #1606](https://github.com/motioneso/moss/pull/1606)
- **Approval-card summaries.** Action cards now prefer a module's user-facing action label when
  one is available. [PR #1492](https://github.com/motioneso/moss/pull/1492)

### 2026-08-27

#### Fixed

- **Workshop module builds start reliably.** Moss no longer submits a module-build step twice, so modules can be created reliably from the Workshop. [PR #2060](https://github.com/motioneso/moss/pull/2060)
- **Workshop build activity.** Workshop builds now keep moving after they start and show the last time the builder was confirmed active. [PR #2009](https://github.com/motioneso/moss/pull/2009)
- **ESPN images and stale page reloads.** Some ESPN game and team images were being blocked from loading, and a browser holding an old version of the page could get a confusing blank response instead of a clean "not found" when trying to reload; both are fixed. [PR #1996](https://github.com/motioneso/moss/pull/1996)
- **Workshop builds recover visibly.** Workshop builds now start reliably, show useful progress and failures, allow failed attempts to be discarded, and no longer show unreliable cost or time estimates. [PR #1991](https://github.com/motioneso/moss/pull/1991)
- **Chat archive now includes the whole day.** When you turn on chat archiving partway through the day, today's archived note now includes everything you chatted about earlier that day, not just messages sent after you turned it on. [PR #1988](https://github.com/motioneso/moss/pull/1988)
- **Readable chat archive headings, and no more backfilling old messages.** Each conversation in your daily chat archive note now shows a local time and the conversation's title instead of a raw computer timestamp. Also, turning archiving on partway through the day no longer pulls in messages you sent earlier that day before you turned it on. [PR #1984](https://github.com/motioneso/moss/pull/1984)
- **Workshop builds finish and respond.** The Workshop now completes builds, opens finished drafts, and responds when you stop, discard, revise, or share a module. [PR #1981](https://github.com/motioneso/moss/pull/1981)
- **Workshop buttons now work.** The Stop, Ask for a change, and Turn on for everyone buttons on the Workshop page now actually do something. [PR #1978](https://github.com/motioneso/moss/pull/1978)
- **Sports source assignment reviews.** Sports source coverage changes now work with existing feeds, and source cards show clean team and league badges instead of feed URLs. [PR #1977](https://github.com/motioneso/moss/pull/1977)
- **Workshop module builds.** Module builds no longer stall, and the Workshop only shows modules created by the signed-in user. [PR #1964](https://github.com/motioneso/moss/pull/1964)
- **Sports source setup and status layout.** Custom sports sources now recover legacy feed assignments and show clearer controls, team labels, status details, and errors. [PR #1956](https://github.com/motioneso/moss/pull/1956)
- **Custom sports sources now stay current.** Custom sports sources now refresh into Sports and Today, show accurate health, and offer clear recovery actions in Settings and through Moss. [PR #1929](https://github.com/motioneso/moss/pull/1929)
- **Polished everyday app screens.** Settings, tasks, navigation, notifications, and several module pages now use clearer labels, cleaner layouts, and more consistent controls. [PR #1938](https://github.com/motioneso/moss/pull/1938)
- **Latest releases appear first.** Recently Released now shows the newest Edge updates at the top, ahead of older weekly history. [PR #1908](https://github.com/motioneso/moss/pull/1908)
- **Clearer error messages when a built-in tool's connection breaks.** When a built-in assistant tool (like note search) fails because it can't reach something it depends on, the chat now shows a short, specific reason instead of a generic error. Note search also no longer fails outright when the built-in text-matching engine is in use. [PR #1892](https://github.com/motioneso/moss/pull/1892)

### 2026-08-22

#### Fixed

- **Photos and logos recover on their own.** A news photo or sports logo that failed to load because of a brief network hiccup now recovers on its own, instead of staying broken until you refresh the page. [PR #1874](https://github.com/motioneso/moss/pull/1874)
- **Job board shows a count when some roles can't be displayed.** The job-search board now tells you if it couldn't show some roles instead of leaving them out with no explanation. [PR #1844](https://github.com/motioneso/moss/pull/1844)
- **Activity log now shows failed actions as failed.** When the assistant tried to do something and the relevant app said it could not (for example, updating a task that no longer exists), the activity log used to record it as a success. It now correctly shows it as failed. [PR #1654](https://github.com/motioneso/moss/pull/1654)
- **Nav bar now switches color in dark mode.** The left navigation bar used to stay the same green shade when you switched to dark mode, out of step with the rest of the app. It now switches to match, like every other part of the interface. [PR #1810](https://github.com/motioneso/moss/pull/1810)
- **Private chat now stays closed correctly if the browser refocuses mid-close.** Fixed a rare case where switching away from the app while closing a private chat, then switching back, could leave the app showing the chat as closed even if the close didn't actually finish on the server. [PR #1801](https://github.com/motioneso/moss/pull/1801)
- **All-day events are seen when checking your calendar.** Availability is now checked a whole day
  at a time, so all-day entries are no longer missed when the assistant looks for free
  time. [PR #1786](https://github.com/motioneso/moss/pull/1786)
- **The assistant no longer says it did something when it only asked permission.** Granting a
  permission is reported as a permission grant, not as a finished action. [PR #1783](https://github.com/motioneso/moss/pull/1783)
- **Meals are logged on the right day.** Logging a meal late in the evening no longer files it under the next day. The assistant now uses your own timezone rather than guessing. [PR #1790](https://github.com/motioneso/moss/pull/1790)
- **All-day events no longer block scheduling.** Holidays, reminders, and other all-day calendar
  entries no longer make the assistant think a day is fully booked. [PR #1717](https://github.com/motioneso/moss/pull/1717)
- **Clearer, more accurate settings descriptions.** The assistant now gives better answers to
  "what can I do here" and explains errors more accurately across email, notes, memory, news,
  goals, tasks, wellness, weather, web research, AI, briefings, calendar, chat, commitments, and
  connectors settings. [PR #1726](https://github.com/motioneso/moss/pull/1726) · [PR #1727](https://github.com/motioneso/moss/pull/1727) · [PR #1728](https://github.com/motioneso/moss/pull/1728)
- **Data exports resume correctly.** Navigating away from Account & preferences and back no longer
  loses track of an in-progress export or starts a duplicate one. [PR #1653](https://github.com/motioneso/moss/pull/1653)
- **UI polish.** Clearer sidebar contrast, friendlier empty-state messages, improved spacing, and
  better hover feedback. [PR #1688](https://github.com/motioneso/moss/pull/1688)
- **Stale module backups no longer get stuck.** Old backup copies of a module are cleaned up
  properly instead of getting wedged or showing up as if they were real installed modules.
  [PR #1657](https://github.com/motioneso/moss/pull/1657)
- **Module version pins are honored exactly.** Updating a module now respects an exact version
  pin even when a different version is already on disk. [PR #1656](https://github.com/motioneso/moss/pull/1656)
- **Additional security hardening.** Further tightening of outbound network requests, external
  module input handling, and chat action validation. [PR #1601](https://github.com/motioneso/moss/pull/1601) · [PR #1613](https://github.com/motioneso/moss/pull/1613) · [PR #1663](https://github.com/motioneso/moss/pull/1663) · [PR #1690](https://github.com/motioneso/moss/pull/1690) · [PR #1691](https://github.com/motioneso/moss/pull/1691)
- **Safer external-module validation.** Patterned input validation now stays bounded and keeps
  the host responsive even for hostile input. [PR #1608](https://github.com/motioneso/moss/pull/1608)
- **Weather location overrides.** A manually selected weather location now remains authoritative
  instead of being replaced by an automatic lookup. [PR #1535](https://github.com/motioneso/moss/pull/1535)
- **Chat availability and approval recovery.** Chat now waits for the selected model route and
  restores approval cards reliably after the drawer is reopened. [PR #1482](https://github.com/motioneso/moss/pull/1482) · [PR #1494](https://github.com/motioneso/moss/pull/1494)

### 2026-08-27

#### Changed

- **Sports honours your story preferences.** The Sports page now takes account of the stories you have asked to see more or less of, while still showing you a genuinely major story on a subject you muted. [PR #2050](https://github.com/motioneso/moss/pull/2050)
- **Workshop page shows your real builds.** The Workshop page now shows your actual in-progress and finished module builds instead of a placeholder. [PR #1948](https://github.com/motioneso/moss/pull/1948)
- **One image for Sports source previews.** Moss now includes Sports public-source previews in its existing download while keeping browser discovery isolated. [PR #1947](https://github.com/motioneso/moss/pull/1947)
- **Weather chip now shows a 5-day forecast with hover detail.** The weather chip at the top of the Today page now shows a 5-day forecast strip instead of just current conditions. Hover or tab to any day to see humidity, dew point, wind, and high/low, and click a day to open the full forecast for your location in a new tab. [PR #1939](https://github.com/motioneso/moss/pull/1939)

### 2026-08-22

#### Changed

- **A new look for the weekly What's New page.** The weekly summary of what shipped now has a new design and is published again every Friday morning. [PR #1830](https://github.com/motioneso/moss/pull/1830)
- **The Food page uses the full width.** The Food page now lines up with the Finance and Job Search pages instead of sitting in a narrower column. [PR #1793](https://github.com/motioneso/moss/pull/1793)

## v0.1.16 — 2026-08-05

### Added

- **Guided Job Search onboarding.** Job Search now opens as a guided flow inside Moss, with
  dedicated search screens and an embedded assistant. Reloading restores the profile step you were
  on instead of sending you back to the start. [PR #1204](https://github.com/motioneso/Jarv1s/pull/1204) · [PR #1209](https://github.com/motioneso/Jarv1s/pull/1209) · [PR #1212](https://github.com/motioneso/Jarv1s/pull/1212) · [PR #1214](https://github.com/motioneso/Jarv1s/pull/1214) · [PR #1215](https://github.com/motioneso/Jarv1s/pull/1215)
- **Attach files and screenshots in chat.** You can attach files or paste screenshots directly into
  the chat drawer, keeping supporting material with the conversation instead of describing it
  separately. [PR #1156](https://github.com/motioneso/Jarv1s/pull/1156)
- **Finance reports that understand transfers.** The Finance module now produces spending,
  cash-flow, and net-worth reports and automatically pairs transfers so moving money between
  accounts does not look like income or spending. [PR #1163](https://github.com/motioneso/Jarv1s/pull/1163) · [PR #1173](https://github.com/motioneso/Jarv1s/pull/1173)
- **Weekly delivery reports.** A scheduled weekly report now summarizes what shipped, giving you a
  compact record of recent product changes without manually reviewing individual pull requests.
  [PR #1129](https://github.com/motioneso/Jarv1s/pull/1129)
- **App-grounded help.** Moss can now look up shipped screens, settings, prerequisites, and named
  fixes from the app's build artifact. The generated app map remains the authority for behavior and
  remediation.
- **Your timezone, everywhere (first slice).** Dates and times in chat answers, wellness history,
  and briefings now render in your configured timezone instead of UTC. More display surfaces are
  in progress. [PR #596](https://github.com/motioneso/Jarv1s/pull/596) · [#579](https://github.com/motioneso/Jarv1s/issues/579)
- **Delete calendar events.** Moss can now remove events from your calendar, not just read them.
  Ask it to cancel a meeting, clear a block, or tidy up stale events and it will handle the deletion
  directly. [PR #569](https://github.com/motioneso/Jarv1s/pull/569) · [#557](https://github.com/motioneso/Jarv1s/issues/557)
- **Automatic commitment extraction.** Moss now notices commitments in email, calendar events, and
  notes and surfaces what you have agreed to do or attend. [PR #570](https://github.com/motioneso/Jarv1s/pull/570) · [#537](https://github.com/motioneso/Jarv1s/issues/537)
- **Source-backed answers.** Moss answers now cite the specific messages, meetings, and notes they
  came from so you can verify the reasoning. [PR #571](https://github.com/motioneso/Jarv1s/pull/571) · [#539](https://github.com/motioneso/Jarv1s/issues/539)
- **Data freshness indicator.** The chat footer now shows how current the data behind each answer
  is, making it clear when a manual refresh would help. [PR #572](https://github.com/motioneso/Jarv1s/pull/572) · [#541](https://github.com/motioneso/Jarv1s/issues/541)
- **Automation audit log.** Every action Moss takes on your behalf is now recorded for review and
  export. [PR #573](https://github.com/motioneso/Jarv1s/pull/573) · [#540](https://github.com/motioneso/Jarv1s/issues/540)
- **People knowledge graph.** Moss now links the same person across emails, calendar events, and
  notes and provides tools to query their shared context. [PR #574](https://github.com/motioneso/Jarv1s/pull/574) · [#538](https://github.com/motioneso/Jarv1s/issues/538)

### Fixed

- **More resilient live chat.** Live chat now recovers from stale sessions, and multiline pasted
  messages no longer trigger false delivery failures or attachment-turn errors. [PR #1160](https://github.com/motioneso/Jarv1s/pull/1160) · [PR #1172](https://github.com/motioneso/Jarv1s/pull/1172) · [PR #1175](https://github.com/motioneso/Jarv1s/pull/1175)
- **Mobile menu always reachable.** The user menu no longer scrolls off screen on smaller
  viewports. [PR #591](https://github.com/motioneso/Jarv1s/pull/591) · [#524](https://github.com/motioneso/Jarv1s/issues/524)
- **Wellness notes reach Moss.** Free-text wellness check-in notes are now available when you ask
  about your wellbeing or patterns, and wellness exports work correctly. [PR #582](https://github.com/motioneso/Jarv1s/pull/582) · [#505](https://github.com/motioneso/Jarv1s/issues/505) · [#509](https://github.com/motioneso/Jarv1s/issues/509)
- **Cleaner chat actions.** Approve and reject controls now have correct spacing and labels, and the
  Today view no longer shows an irrelevant medication nudge. [PR #581](https://github.com/motioneso/Jarv1s/pull/581) · [#480](https://github.com/motioneso/Jarv1s/issues/480) · [#512](https://github.com/motioneso/Jarv1s/issues/512)

### Changed

- **Moss knows which screen you are viewing.** Moss can now use the current page and app context
  when answering, so in-app help needs less explanation. [PR #1126](https://github.com/motioneso/Jarv1s/pull/1126)
- **Easier module setup.** Settings now shows credential controls for registry-installed modules,
  making required connections visible where you manage the module. [PR #1178](https://github.com/motioneso/Jarv1s/pull/1178)
- **Cleaner Evening review.** The Sources freshness list has been removed from the Evening review
  so it no longer appends data-staleness details most people skip. [PR #595](https://github.com/motioneso/Jarv1s/pull/595) · [#586](https://github.com/motioneso/Jarv1s/issues/586)
- **Briefings list their actual sources.** Briefings settings now names the email accounts,
  calendars, and note folders feeding each briefing instead of showing only a count. [PR #594](https://github.com/motioneso/Jarv1s/pull/594) · [#506](https://github.com/motioneso/Jarv1s/issues/506)
- **Paste a Coolors palette to stage it immediately.** Pasting a Coolors URL or colour list in
  Appearance settings now updates the preview without a separate staging step. [PR #598](https://github.com/motioneso/Jarv1s/pull/598)
