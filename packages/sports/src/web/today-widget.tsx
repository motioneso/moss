import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";

import { getSportsOverview } from "./sports-client.js";
import { sportsQueryKeys } from "./query-keys.js";
import { hasLiveGame, LIVE_REFETCH_INTERVAL_MS } from "./sports-page.js";
import { orderFollowedCards, TickerLeague, TickerTeam } from "./sports-ticker.js";
import { type StoryFeedbackChange } from "./story-feedback-menu.js";

/**
 * Today "Sports desk" widget (#799 module-web-registry Phase A).
 *
 * Reuses the same `getSportsOverview()` query as the `/sports` page (identical
 * `sportsQueryKeys.overview` key, so it shares the React Query cache).
 *
 * The cards ARE the desk page's ticker cards (live feedback mrb4mhxt): the widget's old
 * bespoke FollowedCard had drifted a full redesign behind the desk — status-tag pills the
 * desk cut (mratgoq4), no story thumbnails, bottom-docked form row (superseded by mrawlzb7),
 * raw server order. Rendering `TickerTeam` in a grid keeps both surfaces in lockstep by
 * construction; `.sp-tkgrid` restyles the cards from scroll-strip segments into /today's
 * bordered-card idiom. Same reader-priority order as the desk: live, then in-season, then
 * idle — the widget's 4-card cap should spend itself on teams that matter today.
 */
export function SportsTodayWidget(): ReactNode {
  const queryClient = useQueryClient();
  const [hiddenStoryRefs, setHiddenStoryRefs] = useState<ReadonlySet<string>>(new Set());
  const onStoryChanged = useCallback<StoryFeedbackChange>(
    (storyRef, kind) => {
      if (kind === "less_like_this") {
        setHiddenStoryRefs((current) => new Set(current).add(storyRef));
      }
      void queryClient.invalidateQueries({ queryKey: sportsQueryKeys.overview });
    },
    [queryClient]
  );
  const overviewQuery = useQuery({
    queryKey: sportsQueryKeys.overview,
    queryFn: () => getSportsOverview(),
    refetchInterval: (query) => (hasLiveGame(query.state.data) ? LIVE_REFETCH_INTERVAL_MS : false),
    refetchIntervalInBackground: false
  });
  const data = overviewQuery.data;
  // League/tournament cards (Ben 2026-07-09): the service only emits these for followed
  // competitions that are active right now, so this is already the "when the league is active"
  // gate — no client-side season check needed. They join the team cards in the same grid.
  const leagueCards = data?.followedLeagueCards ?? [];
  const teamCards = data ? orderFollowedCards(data.followed, Date.now()).slice(0, 4) : [];
  // World-of-sport stories (Ben 2026-07-09): the desk now opens like the News desk — a broadsheet
  // "main story" lead + a few other top sport headlines BEFORE the followed-team cards. topStories
  // is the same personalized ranking the /sports page leads with; already toPublicHeadline'd, so
  // every url is scheme-sanitized. lead = the editorial #1, briefs = the next three.
  const topStories = (data?.topStories ?? []).filter(
    (story) => !hiddenStoryRefs.has(story.storyRef ?? "")
  );
  const lead = topStories[0] ?? null;
  const briefs = topStories.slice(1, 4);
  // Show the desk if there's ANY content: top stories, followed teams, or an active league.
  if (!data || (topStories.length === 0 && teamCards.length === 0 && leagueCards.length === 0)) {
    return null;
  }

  const cardsLabel =
    teamCards.length > 0 && leagueCards.length > 0
      ? "Your teams & leagues"
      : leagueCards.length > 0
        ? "Your leagues"
        : "Your teams";

  return (
    <section className="jds-brief" aria-label="Sports desk">
      <div className="jds-brief__head">
        <span className="jds-brief__kicker">Sports desk</span>
      </div>
      {/* Main story + brief list, mirroring the News desk layout (Ben: "we should have a main story
          and then some other top stories from the world of sport before we see the your teams
          section"). Sports-local .sp-lead/.sp-brief classes match the news lead visually while
          keeping module isolation — sports never reaches into news's .nw-* CSS. The competition
          label ("NFL", "Premier League") is the source tag; never the raw key (#765 M4). */}
      {lead ? (
        <>
          <div className="jds-brief__title">Top stories</div>
          <a className="sp-lead" href={lead.url} target="_blank" rel="noreferrer">
            {lead.imageUrl ? (
              <img className="sp-lead__photo" src={lead.imageUrl} alt="" loading="lazy" />
            ) : null}
            <span className="sp-lead__tag">
              {lead.competitionLabel} · {lead.publisherLabel}
            </span>
            <span className="sp-lead__title">{lead.title}</span>
            {lead.summary ? <span className="sp-lead__dek">{lead.summary}</span> : null}
          </a>
          {briefs.length > 0 ? (
            <ul className="sp-brief">
              {briefs.map((story) => (
                <li className="sp-brief__item" key={story.id}>
                  <a className="sp-brief__link" href={story.url} target="_blank" rel="noreferrer">
                    <span className="sp-brief__tag">
                      {story.competitionLabel} · {story.publisherLabel}
                    </span>
                    <span className="sp-brief__title">{story.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {/* Followed-team/league cards below the world-of-sport stories, under their own subhead so
          the two zones read as distinct desk sections (Ben: "before we see the your teams card
          section"). Subhead is dropped when there are no cards (top-stories-only desk). */}
      {teamCards.length > 0 || leagueCards.length > 0 ? (
        <>
          <div className="sp-tksub">{cardsLabel}</div>
          <div className="sp-tkgrid">
            {teamCards.map((card) => (
              <TickerTeam
                key={`${card.competitionKey}:${card.teamKey}`}
                card={card}
                hiddenStoryRefs={hiddenStoryRefs}
                onStoryChanged={onStoryChanged}
              />
            ))}
            {/* League cards after teams: a follower's own clubs lead, the wider competition
                follows. Cap at 3 so a many-league follower can't crowd out the team cards. */}
            {leagueCards.slice(0, 3).map((card) => (
              <TickerLeague
                key={card.competitionKey}
                card={card}
                hiddenStoryRefs={hiddenStoryRefs}
                onStoryChanged={onStoryChanged}
              />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
