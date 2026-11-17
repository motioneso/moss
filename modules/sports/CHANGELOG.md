# Sports package

## 0.1.0

- Sports starts as a built-in package. It keeps the same six tables and saved data as before.
- Followed leagues and teams work through the same routes as before. Following a whole league twice returns the saved follow.
- Following a team, and choosing which team a saved follow means, wait for the provider's team list and are refused until then.
- The standings picker keeps the chosen leagues and the last view under the same saved settings as before.
- Account export and deletion cover all six tables.
- The overview, standings and latest-result routes read ESPN. Followed clubs appear as one card each across competitions, and ESPN days follow US Eastern time.
- Headlines, the gameday hero, news sources, source setup, the other chat tools and the Sports screens are not part of this package yet.
- A website with no news feed can get a recipe proposed by the person's AI model. A reply naming a site the person did not confirm is refused, and a recipe saves only after a real replay finds headlines. The module asks for a 30 second call limit so a real model can answer, and reads pages lightly to stay inside its processing budget.
- Sources are read again without a browser or article text, show healthy, drifted or missing states, and can be retried or rebuilt after a confirmed preview.
- Nine chat tools manage news sources: list, preview, confirm, change coverage, rebuild a recipe, retry and remove. Every change and the removal ask first, on a card built from the saved records, and run only if the source still matches what was shown.
- When a plain page gives no recipe, a source preview or rebuild from the screen may open the page in the sandboxed browser and try once more with what the browser sees. Chat tools, scheduled refreshes and machines that cannot run the browser safely keep plain reading.
- Source photos: a refresh now finds a photo for each source's newest stories from the feed, a saved page rule or the page's share picture. Pictures are re-encoded as JPEG without camera or location data and kept in the person's private folder for fourteen days. Stopping photos for a source forgets its page rule and clears its copies, and feed and share pictures come back at the next refresh. Deleting the source deletes them for good. Pictures over 768 KB are not used, and copies kept by the old app are fetched again.
