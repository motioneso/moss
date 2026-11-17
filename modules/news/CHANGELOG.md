# News package

## 0.1.0

- News starts as a built-in package. It keeps the same eight tables and saved data as before.
- News choices, excluded publishers, added-source removals and topic changes work through the same routes as before.
- Topic discovery and source checks wait for web search and are refused until then.
- Account export and deletion cover all eight tables.
- Fetching articles, refreshing, setup of new sources, chat tools and the News screens are not part of this package yet.
- The News page now compiles from the active sources. Stories are filtered, ranked by the person's model with a fixed-order fallback, stored as a snapshot for seven days, and served by the overview route. Refresh jobs and source health updates are not part of this package yet.
- Refreshing now works in the background. A change to choices, sources, topics or exclusions records a new request, and one queued job rebuilds the page. A page that is missing or out of date also queues one job when it is read, instead of building on the spot.
- Each person has a refresh record with the last success, the last failure and why. A failed refresh keeps the previous page.
- People who added a source or topic get a daily check of those sources at 04:43 UTC. The check updates each source's health, and one notice says "News sources need attention" when something newly needs it.
- Sources checked under another model setting are checked once more automatically.
- Chat tools: top headlines, the headline feed for the heartbeat, source status for keyed publishers, source preview, and a refresh that queues one job. Briefings reads the same top five stories. Nothing is fetched while a briefing is built.
- Story pictures and publisher icons load through the package after the shell re-checks type, signature and size. A picture only loads for a story on the person's own stored page, and an icon only for a publisher they already see. A picture is limited to about 700 KB.
- The approval card for refresh and for picture and icon loads is built from the stored record.
- Story feedback: mark a story on your page "more like this" or "less like this", with an optional reason, change the reason, or undo it. A story marked less is left out of the overview, chat tools and briefings until undone. News keeps these choices in its own table; they do not change ranking yet.
