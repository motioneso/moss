# Sports package

## 0.1.1

- Offer validated Rust chat tools and approval cards where actions ask first.

## 0.1.0

- Sports starts as a built-in package. It keeps the same six tables and saved data as before.
- Followed leagues and teams work through the same routes as before. Following a whole league twice returns the saved follow.
- Following a team, and choosing which team a saved follow means, wait for the provider's team list and are refused until then.
- The standings picker keeps the chosen leagues and the last view under the same saved settings as before.
- Account export and deletion cover all six tables.
- The overview, standings and latest-result routes read ESPN. Followed clubs appear as one card each across competitions, and ESPN days follow US Eastern time.
- Headlines, the gameday hero, news sources, source setup and the other chat tools are not part of this package yet.
- A website with no news feed can get a recipe proposed by the person's AI model. A reply naming a site the person did not confirm is refused, and a recipe saves only after a real replay finds headlines. The module asks for a 30 second call limit so a real model can answer, and reads pages lightly to stay inside its processing budget.
- Sources are read again without a browser or article text, show healthy, drifted or missing states, and can be retried or rebuilt after a confirmed preview.
- Nine chat tools manage news sources: list, preview, confirm, change coverage, rebuild a recipe, retry and remove. Every change and the removal ask first, on a card built from the saved records, and run only if the source still matches what was shown.
- When a plain page gives no recipe, a source preview or rebuild from the screen may open the page in the sandboxed browser and try once more with what the browser sees. Chat tools, scheduled refreshes and machines that cannot run the browser safely keep plain reading.
- Chat can follow or unfollow a league or team for the person, and it can also read the latest result, today's facts for followed teams, and the next followed fixtures.
- The daily briefing reads today's followed-team facts from Sports. The next-fixtures read uses stored scoreboards only and never calls the sports provider.
- Source photos: a refresh now finds a photo for each source's newest stories from the feed, a saved page rule or the page's share picture. Pictures are re-encoded as JPEG without camera or location data and kept in the person's private folder for fourteen days. Stopping photos for a source forgets its page rule and clears its copies, and feed and share pictures come back at the next refresh. Deleting the source deletes them for good. Pictures over 768 KB are not used, and copies kept by the old app are fetched again.
- The Sports screen is part of this package. It shows the gameday banner or the top-stories carousel, the followed-teams strip, the around-the-leagues scoreboard, the standings rail with its league picker, and the news band, and it refreshes every minute while a game is live. A Follow your teams start shows when nothing is followed, and a saved team that needs a choice asks which one was meant. The Sports desk page shows last night's scores, top stories, team cards and tonight's games. Story feedback is not part of this package yet, times use the browser's own zone, and pictures and links to other sites depend on the frame that hosts the screen.
- The Sports settings page is part of this package. It follows and unfollows teams and leagues with search (which says so when it covered only some leagues), browses leagues by confederation, chooses the standings leagues, and manages news sources: add after a preview, edit coverage, retry, rebuild, stop photos, remove. Story preferences are not part of this package yet, and crests and source icons show initials because the frame cannot load pictures from other sites.
