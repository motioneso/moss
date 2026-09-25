# Things for Ben to verify on dev (2026-09-04)

Checked off only when Ben says so in chat. Each line names the PR, the agentation note id if there is one, and what to try.

## On dev now (not yet merged)

- [x] PR 2248 settings fixes (notes mtnal4sy area): Assistant settings shows the response style setting; the time zone search does not get stuck; the setup guide says enabling a voice-to-text model turns on the chat microphone button.
- [ ] PR 2242 expired AI login: when the Claude login expires, chat says so and asks you to log in again instead of failing silently. (Needs an API restart on dev before it is live; you must sign in again after.)
- [x] PR 2220 settings setup link (note mtn9pmoj): the "Set it up in Assistant settings" link under Described topics lands on the right settings section.

## Waiting on a fix or review before they reach dev

- [x] PR 2244 email processing: after a Google sync, emails get signals and suggested tasks appear on Today. Proven on dev 22:13 UTC: 91 of 94 emails processed, 8 suggested tasks; open Today and look for email items and suggested tasks.
- [ ] PR 2251 NPR hero image (your live report): NPR stories in the news carousel show a picture. On dev now, re-review running.
- [ ] PR 2246 news source redirects: adding a source whose site redirects to a sister domain adopts the destination and shows a plain note; an unrelated destination is refused.
- [x] PR 2247 carousel refill: thumbs-down on a story keeps the carousel full, and the dismissed story stays gone after a later refresh.
- [ ] PR 2249 scratchpad slice 1 (note mtnaooaz): Moss can read and append to your scratchpad in chat; the pencil button and rich text window come in a later slice.
- [ ] PR 2245 sports photos from custom sources (note mtnajoas): a custom sports source with pictures shows them in the hero carousel.
- [ ] Sync status slice 1 (note mtnd1ay9): Connected accounts shows when the last sync ran and what it brought in.
- [ ] PR 2255 sports team identity: two teams sharing a short name (for example two clubs called United) show their own scores and standings; your existing follows still work. Also the pinned-Reddit-posts settings note is gone.
- [ ] PR 2234 web push: a browser notification arrives for a test push.
- [x] PR 2252 (note mtng9piy): Today news list shows each publisher's favicon instead of its name, name on hover. On dev now, fixing 2 review blockers.
- [ ] PR 2253 (note mtngdbou, review approved, on dev, needs your tick): sports result ticker has both logos centered, home on the left, scorers on the outer sides (soccer and hockey).
- [ ] PR 2256 (note mtndgqkw): the chat feedback menu closes when you click outside it or press Escape.
- [ ] PR 2256 (note mtnew4dj): the chat history panel opens on the most recent conversation, lists newest first, and looks finished.
- [x] PR 2254 (note mtnex8fc): searching settings for "News" finds the news module settings and takes you there.

## Already merged, still to confirm

- [ ] PR 2250: no user-visible change (private reply text no longer written to the error log). Nothing to try.
- [ ] PR 2231 / 2233 / 2243 (news source preview, provider login double-begin, StrictMode login): adding a news source previews correctly; provider login works first time.
