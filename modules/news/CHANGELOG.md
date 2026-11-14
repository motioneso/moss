# News package

## 0.1.0

- News starts as a built-in package. It keeps the same eight tables and saved data as before.
- News choices, excluded publishers, added-source removals and topic changes work through the same routes as before.
- Topic discovery and source checks wait for web search and are refused until then.
- Account export and deletion cover all eight tables.
- Fetching articles, refreshing, setup of new sources, chat tools and the News screens are not part of this package yet.
- The News page now compiles from the active sources. Stories are filtered, ranked by the person's model with a fixed-order fallback, stored as a snapshot for seven days, and served by the overview route. Refresh jobs and source health updates are not part of this package yet.
