# Sports: following a national team without following its tournament (#2660)

Date: 2026-09-24. Owner: Ben. Issue: #2660.

## The problem

Ben follows the USA national team but not the World Cup. Three things go wrong:

1. The standings picker lists "FIFA World Cup" under **Following** and opens it by default,
   even though the tournament is long over. The picker builds **Following** from every follow's
   competition, and the USA follow is filed under `fifa.world`.
2. Sports news pulls the whole World Cup feed because of that follow, so a general FIFA story
   with no US tag can lead the page.
3. There is no way to follow the US women's national team, because the catalog has no women's
   national-team competition.

## What we build

### 1. A tournament is only "Following" while it is running

A follow in a **tournament** competition (World Cup, Champions League) does not put that
tournament in **Following** unless the tournament is in progress. When it is not in progress the
tournament stays browsable under its sport as before, and the picker no longer opens it by
default. Club-league follows (Premier League, MLS and the rest) are unchanged.

**Where the active signal comes from.** ESPN's standings response for a competition carries a
`season` object plus a `seasons` list. The top-level `season.endDate` is not trustworthy —
ESPN pads the 2026 World Cup season to 31 December even though the final was in July. The
season's stage list (`seasons[0].types`) does carry the real last stage: for the World Cup 2026
the last stage ("Final") ends 1 August 2026, and for the 2026-27 Champions League it ends
1 July 2027. So the smallest reliable signal is the season window (start of the newest season to
the end of its last stage). A tournament is in progress when now falls inside that window.

The standings dataset already fetches this payload for every followed competition, so we read the
window from it and hand the client the list of followed competition keys that are in progress
(`activeCompetitionKeys` on the overview response). No extra network call.

### 2. A team-only tournament follow pulls only that team's stories

When a tournament has only team follows (nobody follows the whole tournament), the server no
longer fetches the tournament-wide league feed. It uses each followed team's own feed and keeps
only stories tagged with that team. A whole-tournament follow still gets the whole feed. US team
stories still appear on the team cards and in the news band; untagged World Cup stories do not.

### 3. The US women's national team is followable

ESPN files the US women's national team under the Women's World Cup competition (`fifa.wwc`,
team id 2765). We add that competition to the catalog so team search finds "United States"
under it, alongside the men's team in `fifa.world`. Following the women's team then behaves like
any other team-only tournament follow: its own news feed is used, and the Women's World Cup does
not appear under **Following** while it is not running.

## Tests

- Picker: a finished tournament with only a team follow is not under **Following**; an in-progress
  one is.
- News: a team-only tournament follow pulls only team-tagged stories.
- Catalog: the US women's team is findable (the Women's World Cup entry exists and carries the
  team).
- Season window: the standings parser reads the real end of the season from the stage list, not
  the padded `season.endDate`.

## Out of scope

- Club-league follows are untouched.
- No new migration, table, or stored setting.
