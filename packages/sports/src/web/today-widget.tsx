import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { EMPTY_FOLLOWED_TEAMS, followedTeamIndex } from "../news-ranking.js";
import { formatDate, formatTimeZoneShort, useUserLocale } from "./locale.js";
import { getSportsOverview } from "./sports-client.js";
import { sportsQueryKeys } from "./query-keys.js";
import { hasLiveGame, LIVE_REFETCH_INTERVAL_MS } from "./sports-page.js";
import { orderFollowedCards, TickerLeague, TickerTeam } from "./sports-ticker.js";
import { StoryFeedbackMenu, type StoryFeedbackChange } from "./story-feedback-menu.js";
import {
  QUIET_NIGHT_LINE,
  ScoreRow,
  TonightRow,
  selectScoreRows,
  selectTonightRows
} from "./today-scores.js";
import "./styles/sports-7-sidelines.css";
import "./styles/sports-8-clippings.css";

type RecapStory = {
  readonly storyRef?: string;
  readonly url: string;
  readonly imageUrl: string | null;
  readonly competitionLabel: string;
  readonly publisherLabel: string;
  readonly title: string;
  readonly summary: string | null;
};

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
 * construction; `.sp-tkgrid` lays the cards out as flat newspaper columns
 * (sports-8-clippings.css). Same reader-priority order as the desk: live, then in-season, then
 * idle — the widget's 4-card cap should spend itself on teams that matter today.
 */
export function SportsTodayWidget(): ReactNode {
  const queryClient = useQueryClient();
  const locale = useUserLocale();
  const [hiddenStoryRefs, setHiddenStoryRefs] = useState<ReadonlySet<string>>(new Set());
  const [failedLeadPhoto, setFailedLeadPhoto] = useState<string | null>(null);
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
  useEffect(() => {
    if (!data) return;
    const responseStoryRefs = new Set([
      ...data.topStories.flatMap((story) => (story.storyRef ? [story.storyRef] : [])),
      ...data.followed.flatMap((card) =>
        card.stories.flatMap((story) => (story.storyRef ? [story.storyRef] : []))
      ),
      ...data.followedLeagueCards.flatMap((card) =>
        card.stories.flatMap((story) => (story.storyRef ? [story.storyRef] : []))
      )
    ]);
    setHiddenStoryRefs((current) => {
      const next = new Set([...current].filter((storyRef) => responseStoryRefs.has(storyRef)));
      return next.size === current.size ? current : next;
    });
  }, [data]);
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
  const cardStories: RecapStory[] = (data?.followed ?? []).flatMap((card) =>
    card.stories
      .filter((story) => !hiddenStoryRefs.has(story.storyRef ?? ""))
      .map((story) => ({
        storyRef: story.storyRef,
        url: story.url,
        imageUrl: story.imageUrl,
        competitionLabel: card.competitionLabel,
        publisherLabel: story.publisherLabel,
        title: story.title,
        summary: null
      }))
  );
  const recapStories = [...topStories, ...cardStories].filter(
    (story, index, stories) =>
      stories.findIndex((candidate) => candidate.url === story.url) === index
  ) as RecapStory[];
  const lead = recapStories.find((story) => story.imageUrl !== null) ?? recapStories[0] ?? null;
  const briefs = recapStories.filter((story) => story !== lead).slice(0, 3);
  // Scores and Tonight come from the same response through the pure T11 selectors: finals and
  // live games split followed-first, tonight by the actor's local day. Phase helpers never see
  // teamKey — followed marking is always the provider's permanent id via isFollowed.
  const now = new Date();
  const followedPairs = data ? followedTeamIndex(data.followedTeams) : null;
  const scoreGroups =
    data && followedPairs ? selectScoreRows(data, followedPairs, now, locale.timezone) : null;
  const tonightGroups =
    data && followedPairs ? selectTonightRows(data, followedPairs, now, locale.timezone) : null;
  const followedRows = scoreGroups?.followedRows ?? [];
  const elsewhereRows = scoreGroups?.elsewhereRows ?? [];
  const tonightRows = tonightGroups?.tonightRows ?? [];
  const postponedRows = tonightGroups?.postponedRows ?? [];
  const hasScores = followedRows.length > 0 || elsewhereRows.length > 0;
  const hasTonight = tonightRows.length > 0 || postponedRows.length > 0;
  // Show the desk if there's ANY content: scores, tonight games, top stories, followed teams,
  // or an active league. The quiet-night line below needs this gate — it renders only when the
  // band is empty and the desk is up for another reason.
  if (
    !data ||
    (!hasScores &&
      !hasTonight &&
      topStories.length === 0 &&
      teamCards.length === 0 &&
      leagueCards.length === 0)
  ) {
    return null;
  }

  const cardsLabel =
    teamCards.length > 0 && leagueCards.length > 0
      ? "Your teams & leagues"
      : leagueCards.length > 0
        ? "Your leagues"
        : "Your teams";
  const followingLine = followingSummary(
    data?.followedTeams.length ?? 0,
    data?.followedLeagues.length ?? 0
  );

  return (
    <section className="jds-brief jds-brief--sports" aria-label="Sports desk">
      <div className="desk-head">
        <span className="desk-number">03</span>
        <h2 className="desk-title">From the sidelines</h2>
        <span className="desk-meta">Sports desk</span>
      </div>
      {hasScores ? (
        <div className="desk-scores" aria-label="Scores">
          <div className="desk-scores__head">
            <div className="jds-brief__title">Last night</div>
            <span>
              {formatDate(now, locale, { weekday: "long", month: "long", day: "numeric" })}
            </span>
          </div>
          {followedRows.length > 0 ? (
            <>
              <div className="sp-tksub">
                <span className="sp-tksub__morning-star">★ </span>Your followed teams
              </div>
              <ul className="sp-scores">
                {followedRows.map((row) => (
                  <ScoreRow
                    key={row.game.id}
                    row={row}
                    followed={followedPairs ?? EMPTY_FOLLOWED_TEAMS}
                  />
                ))}
              </ul>
            </>
          ) : null}
          {elsewhereRows.length > 0 ? (
            <>
              <div className="sp-tksub">Elsewhere worth a look</div>
              <ul className="sp-scores">
                {elsewhereRows.map((row) => (
                  <ScoreRow
                    key={row.game.id}
                    row={row}
                    followed={followedPairs ?? EMPTY_FOLLOWED_TEAMS}
                  />
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
      {/* Main story + brief list, mirroring the News desk layout (Ben: "we should have a main story
          and then some other top stories from the world of sport before we see the your teams
          section"). Sports-local .sp-lead/.sp-brief classes match the news lead visually while
          keeping module isolation — sports never reaches into news's .nw-* CSS. The competition
          label ("NFL", "Premier League") is the source tag; never the raw key (#765 M4). */}
      {lead ? (
        <div className="desk-stories" aria-label="Top stories">
          {/* Feedback dots sit in the story's top-right corner (over the photo when there is one)
              and only appear while the story is hovered or focused — same placement as the News
              desk (Ben 2026-09-03: "the dots hovering on the image like news does in the top
              right ... only show up when the user hovers over that story"). .sp-fbhost carries
              the hover rule; see sports-4-grid.css. */}
          <div className="sp-lead-wrap sp-fbhost">
            <a className="sp-lead" href={lead.url} target="_blank" rel="noreferrer">
              {lead.imageUrl && lead.imageUrl !== failedLeadPhoto ? (
                <img
                  className="sp-lead__photo"
                  src={lead.imageUrl}
                  alt=""
                  loading="lazy"
                  onError={() => setFailedLeadPhoto(lead.imageUrl)}
                />
              ) : null}
              <span className="sp-lead__tag">★ FOLLOWING / {lead.competitionLabel}</span>
              <span className="sp-lead__title">{lead.title}</span>
              {lead.summary ? <span className="sp-lead__dek">{lead.summary}</span> : null}
              <span className="sp-lead__link">The story behind the score ↗</span>
            </a>
            <StoryFeedbackMenu
              storyRef={lead.storyRef}
              surface="today"
              onChanged={onStoryChanged}
            />
          </div>
          {briefs.length > 0 ? (
            <ul className="sp-brief">
              {briefs.map((story) => (
                <li className="sp-brief__item" key={story.storyRef}>
                  <div className="sp-brief__row sp-fbhost">
                    <a className="sp-brief__link" href={story.url} target="_blank" rel="noreferrer">
                      <span className="sp-brief__tag">
                        {story.competitionLabel} · {story.publisherLabel}
                      </span>
                      <span className="sp-brief__title">{story.title}</span>
                    </a>
                    <StoryFeedbackMenu
                      storyRef={story.storyRef}
                      surface="today"
                      onChanged={onStoryChanged}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Followed-team/league cards below the world-of-sport stories, under their own subhead so
          the two zones read as distinct desk sections (Ben: "before we see the your teams card
          section"). Subhead is dropped when there are no cards (top-stories-only desk). */}
      {teamCards.length > 0 || leagueCards.length > 0 ? (
        <div className="desk-cards">
          <div className="desk-cards__head">
            <div className="sp-tksub">{cardsLabel}</div>
            {followingLine ? <span>{followingLine}</span> : null}
          </div>
          <div className="sp-tkgrid">
            {teamCards.map((card) => (
              <TickerTeam
                key={`${card.competitionKey}:${card.teamKey}`}
                card={card}
                hiddenStoryRefs={hiddenStoryRefs}
                onStoryChanged={onStoryChanged}
                surface="today"
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
                surface="today"
              />
            ))}
          </div>
        </div>
      ) : null}
      {/* The band stays last in DOM order so keyboard readers reach scores, lead, briefs,
          cards, then Tonight, while the desktop grid places it immediately below the
          score/story row. */}
      <div className="desk-tonight">
        <div className="desk-tonight__head">
          <div className="sp-tksub">Tonight</div>
          <span>
            {formatDate(now, locale, { weekday: "long", month: "long", day: "numeric" })}
            {formatTimeZoneShort(now, locale) ? ` · ${formatTimeZoneShort(now, locale)}` : ""}
          </span>
        </div>
        {hasTonight ? (
          <ul className="sp-tonight">
            {tonightRows.map((row) => (
              <TonightRow key={row.game.id} row={row} locale={locale} />
            ))}
            {postponedRows.map((row) => (
              <TonightRow key={row.game.id} row={row} locale={locale} />
            ))}
          </ul>
        ) : (
          <p className="sp-tonight__quiet">{QUIET_NIGHT_LINE}</p>
        )}
      </div>
    </section>
  );
}

// "Following 2 teams and 1 league" beside the teams-row label; empty when nothing is followed.
function followingSummary(teams: number, leagues: number): string {
  const parts = [
    teams > 0 ? `${teams} ${teams === 1 ? "team" : "teams"}` : "",
    leagues > 0 ? `${leagues} ${leagues === 1 ? "league" : "leagues"}` : ""
  ].filter(Boolean);
  return parts.length > 0 ? `Following ${parts.join(" and ")}` : "";
}
