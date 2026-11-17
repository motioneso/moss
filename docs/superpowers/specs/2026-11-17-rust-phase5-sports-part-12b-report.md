# Sports part 12b: overview stories and live parts

Companion to `2026-11-13-rust-phase5-news-sports-weather-report.md`, which is at its line limit.
The report holds a pointer to this file under the heading "Sports overview stories (part 12b)".

## What was built

- Headlines for the overview come from ESPN's league and club news, limited to what each person's coverage allows. A tournament followed only by its clubs reads those clubs' feeds.
- The top stories lead with each competition's first story, then stories about followed clubs, six at most. A story already on a club card is not repeated.
- The league news band lists the rest, each link once. One story is featured: the heaviest with art, a summary and a followed club.
- The featured story's body is read from ESPN's article page. Only a number of four or more digits is ever put in the address. The text is the first three paragraphs, markup removed, at most 900 characters, cut at a word. A failed read shows the summary and marks the page as partly out of date, and is not saved.
- The hero shows gameday slides from fifteen minutes before a game until it ends, live games first, one slide per game. With no followed game on, it shows the lead story.
- Club cards carry up to three stories. The tonight band is drawn on the screen and has no server part.
- The news cache holds at most 40 feeds and the article cache 60 bodies, because each is read whole on every request. The overview reads the news cache once and writes it once.

## Proof

| Claim                            | Check                                                                                              | Result                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body is cleaned and clipped      | Recorded article with markup, entities, photo placeholders and a very long text                    | Plain text, 900 characters at most, ends with an ellipsis                                                                                                        |
| A bad id never reaches the fetch | Short ids, non-number ids and path tricks, with a control id that does fetch                       | Nothing fetched for the bad ones                                                                                                                                 |
| A failed read shows the summary  | ESPN article page made to fail                                                                     | Summary shown, page not marked out of date, failure remembered for ten minutes                                                                                   |
| Same answers as the old code     | 12 recorded scenarios against the old handlers, stories included                                   | Matched                                                                                                                                                          |
| Other person shut out            | Second person's overview with row security on and off                                              | Seen failing with it off                                                                                                                                         |
| Private text stays out           | Planted text, every table, the shared cache and every outgoing address                             | Found nowhere outside the owner's rows                                                                                                                           |
| Native and WebAssembly           | 10 new native tests and the whole native suite; 10 real-database tests against the built component | All passed                                                                                                                                                       |
| Real server                      | Real server, real ESPN, a person following nothing but the NFL; nothing rewritten                  | Hero showed the lead story, 1 top story, 5 band stories, and the featured story's real body (240 characters) loaded. A second read answered from the shared copy |

## Found while proving it

- The overview in the real WebAssembly host costs about 110 million fuel cold for one club and about 170 million for an NHL club, against a limit of 250 million. Before this part the same calls cost about 100 and 137 million.
- The leak check ran out of fuel only after earlier tests had left follows in the database, because with row security off it read all of them. The check now clears other people's follows first.

## Not proven

- The overview has no chat tool yet (part 12c), so the live run used the real overview route over HTTPS and not the chat route.
- Stories from custom sources and catalog feeds, and the less-of-this filter, are not built. A person's saved less-of-this choices do not yet change the stories.
- The cost of an overview for a person following many clubs was not measured. Ten clubs may pass the 250 million fuel limit. The first thing to try is reading fewer feeds per request.
- The live run reached the server on this machine only, not from a phone.
- The tonight band and the screens were not built here.
