# Sports: more women's leagues, and the standings the viewer last opened (#2661)

Date: 2026-09-24. Owner: Ben. Issue: #2661.

## The problem

Two gaps:

1. The sports catalog covers few women's competitions. Ben asked for NWSL (already there),
   WPBL for sure, and women's soccer in Europe.
2. The standings picker always starts on its own derived default. Ben asked for it to reopen
   whatever standings the viewer last looked at, on any device.

## What we build

### 1. More women's competitions

Added to the catalog, each probed live on 2026-09-24 (ESPN's site API `/teams` returns 200 with a
roster):

| Key             | Competition                        | Kind             |
| --------------- | ---------------------------------- | ---------------- |
| eng.w.1         | English Women's Super League       | league           |
| esp.w.1         | Spanish Liga F                     | league           |
| fra.w.1         | French Premiere Ligue              | league           |
| ned.w.1         | Dutch Vrouwen Eredivisie           | league           |
| aus.w.1         | Australian A-League Women          | league           |
| uefa.wchampions | UEFA Women's Champions League      | tournament       |
| uefa.weuro      | UEFA Women's European Championship | tournament       |
| concacaf.w.gold | Concacaf W Gold Cup                | tournament       |
| fifa.w.olympics | Women's Olympic Soccer Tournament  | tournament       |
| wpbl            | Women's Pro Baseball League        | news-only league |

NWSL (`usa.nwsl`) was already in the catalog and is unchanged. The men's and women's tournaments
share the rule from #2660: a tournament only sits under **Following** in the standings picker
while its season is running, and is always reachable under its sport.

The Women's World Cup (`fifa.wwc`, added in #2660) was missing from the knockout-tournament set,
so a finished group table could still show a league-position line. It joins the new tournaments in
that set, and all the new soccer competitions read a scoreline home-first like the rest of the
sport.

Deliberately absent, because ESPN has no data for them under any key tried: the German
Frauen-Bundesliga (`ger.w.1`, `ger.frauen.1`), Italian Serie A Femminile (`ita.w.1`), Liga MX
Femenil (`mex.w.1`, zero teams), and the PWHL. No invented ESPN keys.

### 2. WPBL is a news-only league

ESPN has no WPBL league at all. The Women's Pro Baseball League's official RSS feed is added to
its catalog entry as a fixed feed URL, and the Sports news refresh reads it through the same safe
fetch, RSS parse and cache path the custom news sources already use. Following WPBL shows its
site's stories. There is no roster, score or standings source, so:

- The four clubs (Boston, New York, Los Angeles, San Francisco) are not followable until a
  reliable roster source exists. The league is followable for news.
- The standings picker shows WPBL under Following, and its standings area says no standings are
  available. No ESPN call is made for the league, because ESPN has nothing to return.

### 3. The standings the viewer last opened

The standings picker saves the competition the viewer picks, plus the inner division/group view if
they pick one, under the existing per-owner standings preferences (a second preference key beside
the selected-league list, so the two never overwrite each other). It is owner-only like the rest of
that row, and carries across devices, verified under row-level security.

On load, the picker opens the remembered competition when it is still in the picker. An explicit
remembered pick beats the finished-tournament rule, so a viewer who last opened the finished World
Cup sees it again. If the remembered competition is gone (unfollowed or hidden) or was never set,
the picker falls back to its derived default, which still skips finished tournaments. The
remembered inner view is matched by label first, then by key, and falls back quietly to the
competition's default view when it no longer exists.

No new database column is needed: the preferences row stores JSON, so no migration is added.

## Tests

- Catalog: every new competition exists with the right kind, ESPN key, region and confederation;
  WPBL is the news-only entry; the absent competitions stay absent.
- News-only feed: stories from the WPBL feed are filed under WPBL with the right publisher and
  sport, a second read is served from cache, and a failed or non-feed response yields no stories.
- Overview: a followed WPBL gets its feed story and makes no ESPN request for the league; its
  standings route answers empty without an ESPN call.
- Remembered standings: unit tests for remembered, remembered-but-gone and never-set, and for the
  inner view falling back; an integration test saves and reads the preference back under row-level
  security, and confirms each owner only sees their own.
- Preference route: saving the last view never touches the selected-league list, and a bad
  competition or view is rejected before any write.

## Out of scope

- No WPBL team follows, scores or standings until a reliable roster source exists.
- No German, Italian or Mexican women's league, and no PWHL, while ESPN carries none of them.
- No new provider, no new news-source type, and no new migration.
