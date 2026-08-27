import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { FollowedLeagueCard, FollowedNextMatch, FollowedTeamCard } from "@moss/shared";
import { localDay, type LocaleSettingsDto } from "@moss/shared";

import { TOURNAMENT_COMPETITIONS } from "./competitions.js";
import { formatDate, formatTime, useUserLocale } from "./locale.js";
import { Crest, FormPips, LiveDot } from "./sports-parts.js";
import { StoryFeedbackMenu, type StoryFeedbackChange } from "./story-feedback-menu.js";

// Server sends "#0 · -7.5 pts" when ESPN has no real rank/points for a league (MLB GB leaks
// into points) — a nonsense line is worse than none. Also hidden for knockout tournaments,
// where a group-stage standing reads as a league position, and for leagues that aren't in
// progress: "#14 · 0 pts" / "#3 · 0-0" is last season's rank next to a blank record (live
// feedback mra39rlv; the server now nulls these too, this guards the older prod payload).
function standingIsSane(card: FollowedTeamCard): boolean {
  if (!card.standing) return false;
  if (TOURNAMENT_COMPETITIONS.has(card.competitionKey)) return false;
  if (/·\s*(0 pts|0-0)$/.test(card.standing)) return false;
  // Negative-points guard is anchored after the separator: the old bare /-\d/ also matched
  // every W-L record ("#3 · 10-2") and silently hid ALL US-league standings on live data
  // (live feedback mraxrdxr, mraz6m43) — fixtures never caught it because they used the
  // already-fixed "2nd · NFC North" form.
  return !card.standing.startsWith("#0") && !/·\s*-\d/.test(card.standing);
}

// Reader priority (live feedback mra54n4h): live game first, then any team whose season is
// actually in motion — played within the last ten days or plays within the next ten — then the
// idle/off-season rest. Within each tier the freshest news wins (newsRecency); teams with no
// recent story sink to the tier's tail in server order.
const IN_SEASON_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;

function inSeason(card: FollowedTeamCard, now: number): boolean {
  if (card.status === "live" || card.status === "today") return true;
  // Optional-chained reads: the prod API may still serve pre-#845 cards without these fields.
  const last = card.lastMatchAt ? new Date(card.lastMatchAt).getTime() : null;
  if (last !== null && now - last <= IN_SEASON_WINDOW_MS) return true;
  const next = card.nextMatch ? new Date(card.nextMatch.startsAt).getTime() : null;
  return next !== null && next - now <= IN_SEASON_WINDOW_MS;
}

function tickerPriority(card: FollowedTeamCard, now: number): number {
  if (card.status === "live") return 0;
  return inSeason(card, now) ? 1 : 2;
}

// Newest-first news timestamp; teams without a story rank behind any team that has one.
// stories arrive newest-first from the service, so [0] is the freshest.
function newsRecency(card: FollowedTeamCard): number {
  const newest = card.stories[0];
  return newest ? new Date(newest.publishedAt).getTime() : Number.NEGATIVE_INFINITY;
}

// Reader-priority ordering, shared with the Today widget so both surfaces agree on which
// teams matter right now (live feedback mrb4mhxt — the widget used to show raw server order).
export function orderFollowedCards(
  cards: readonly FollowedTeamCard[],
  now: number
): FollowedTeamCard[] {
  return [...cards].sort(
    (a, b) => tickerPriority(a, now) - tickerPriority(b, now) || newsRecency(b) - newsRecency(a)
  );
}

// "vs Green Bay Packers" + "Sat, Jul 4 · 3:00 PM" — user's persisted locale + timezone (spec D2).
// Split so the ticker can stack opponent and kickoff on their own lines (live feedback mra387k7).
// Whole-day gap from `now` to the fixture, both collapsed to the user's local calendar day via
// localDay's tz-stable "YYYY-MM-DD" keys — so an evening kickoff or a DST edge can't off-by-one the
// count the way a raw millisecond diff would.
function daysUntilLocal(startsAt: string, locale: LocaleSettingsDto, now: Date): number {
  // localDay always yields a well-formed "YYYY-MM-DD"; the ?? fallbacks only satisfy
  // noUncheckedIndexedAccess (split() elements are typed `string | undefined`).
  const keyToUTC = (key: string): number => {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  };
  const ms =
    keyToUTC(localDay(startsAt, locale.timezone)) - keyToUTC(localDay(now, locale.timezone));
  return Math.round(ms / 86_400_000);
}

export function nextMatchParts(
  next: FollowedNextMatch,
  locale: LocaleSettingsDto,
  now: Date = new Date()
): { opponent: string; when: string } {
  const at = next.startsAt;
  const time = formatTime(at, locale);
  // Date granularity by proximity (Ben 2026-07-09): inside a week the weekday alone reads fastest
  // ("Sun · 10:00"); a week or more out we need month + day ("Sep 13 · 10:00"). Cutover is < 7, not
  // <= 7, because at exactly 7 days the weekday equals today's — "Sun" would be ambiguous between
  // this Sunday and next, so the dated form is clearer there. Dot separator, never a dash.
  const days = daysUntilLocal(at, locale, now);
  const date =
    days < 7
      ? formatDate(at, locale, { weekday: "short" })
      : formatDate(at, locale, { month: "short", day: "numeric" });
  return {
    opponent: `${next.homeAway === "home" ? "vs" : "at"} ${next.opponentName}`,
    when: `${date} · ${time}`
  };
}

/**
 * True when the fixture starts on the user's local calendar day (#877 finding 1).
 * Derived from the fixture instant + persisted locale tz — NEVER from card.status:
 * status "today" is ESPN-Eastern and stays true after today's game goes final,
 * when nextMatch has already advanced to tomorrow's fixture.
 */
export function nextMatchIsToday(
  next: FollowedNextMatch,
  locale: LocaleSettingsDto,
  now: Date = new Date()
): boolean {
  return localDay(next.startsAt, locale.timezone) === localDay(now, locale.timezone);
}

// Newspaper-style scoreboard strip: one dense block per followed team. Horizontal scroll;
// tabIndex + role="region" make the overflow keyboard-reachable (arrow keys scroll a focused
// scrollable region). Whole-league follows no longer render a block here (header redesign
// pass) — the league-grouped sections below already carry them. Team stories now arrive on
// the card itself (card.stories, mrb0pk1n), so the old headlines prop + client-side
// title-matching are gone: the service's teamKeys tagging is the one source of truth.
// Settings deep-link for the followed-teams Manage control (Task B / ticker note). Kept as a
// local copy rather than imported from sports-page.tsx to avoid a circular import — sports-page
// imports this module for SportsTicker. Mirror of SETTINGS_HREF there; both target the sports
// module's settings section.
const SETTINGS_HREF = "/settings?section=modules&module=sports";

export function SportsTicker(props: {
  followed: readonly FollowedTeamCard[];
  hiddenStoryRefs?: ReadonlySet<string>;
  onStoryChanged?: StoryFeedbackChange;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  function updateEdges(): void {
    const el = scrollRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }

  // Re-measure the scroll edges when content or viewport changes, so the arrows only render
  // when there is actually somewhere to scroll.
  useEffect(() => {
    updateEdges();
    window.addEventListener("resize", updateEdges);
    return () => window.removeEventListener("resize", updateEdges);
  }, [props.followed]);

  if (props.followed.length === 0) return null;
  const ordered = orderFollowedCards(props.followed, Date.now());

  function nudge(direction: -1 | 1): void {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.round(el.clientWidth * 0.8), behavior: "smooth" });
  }

  // Pointer drag-to-scroll (mrb7mwhv): the strip is wide editorial cards now, so click-and-drag
  // is the natural gesture across the row. The arrows STAY (Ben's ask) as the discoverable
  // affordance for anyone who doesn't think to drag. A 4px movement threshold latches `moved`
  // so a drag that ends over a story link doesn't also fire that link's click (onClickCapture
  // swallows it) — dragging never accidentally opens a story. Touch is left to native scroll.
  const dragRef = useRef<{ startX: number; startLeft: number; moved: boolean } | null>(null);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const el = scrollRef.current;
    if (!el || event.pointerType === "touch") return;
    dragRef.current = { startX: event.clientX, startLeft: el.scrollLeft, moved: false };
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const el = scrollRef.current;
    const drag = dragRef.current;
    if (!el || !drag) return;
    const dx = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < 4) return;
    drag.moved = true;
    el.setPointerCapture(event.pointerId);
    el.scrollLeft = drag.startLeft - dx;
  }
  function onPointerEnd(event: ReactPointerEvent<HTMLDivElement>): void {
    const el = scrollRef.current;
    if (el?.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
    // Clear on the next tick so the click that fires right after pointerup can still read
    // `moved` and be suppressed; a plain click (moved === false) passes through untouched.
    window.setTimeout(() => {
      dragRef.current = null;
    }, 0);
  }
  function onClickCapture(event: ReactMouseEvent<HTMLDivElement>): void {
    if (dragRef.current?.moved) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  return (
    <section className="sp-ticker" aria-label="Followed">
      {/* Section head (Task B / ticker note, Ben 2026-07-07): labels the band as the followed set
          and carries Manage, both relocated down here from the masthead folio Ben cleared.
          Reverses mrb8sxx6 (head removed) + mrb8p4e2 (Manage lifted up to the folio) — the "my
          teams" strip now owns its own titled head instead of borrowing the masthead's. */}
      {/* Ben 2026-07-09 (/sports): make this head speak the carousel's "TOP STORY | LEAGUE"
          kicker voice and shorten to FOLLOWED | MANAGE. The pipe is now the hairline divider on
          .sp-ticker__manage (like .sp-hero__kicker-comp), not a literal glyph — so the old sep
          span is gone. CSS uppercases "Followed", so the source text stays sentence-case. */}
      <div className="sp-ticker__head">
        <h2 className="sp-ticker__label">Followed</h2>
        <a className="sp-ticker__manage" href={SETTINGS_HREF}>
          Manage
        </a>
      </div>
      <div className="sp-ticker__row">
        <button
          type="button"
          className="sp-ticker__nav"
          aria-label="Scroll left"
          hidden={atStart}
          onClick={() => nudge(-1)}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <div
          className="sp-ticker__scroll"
          ref={scrollRef}
          onScroll={updateEdges}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerLeave={onPointerEnd}
          onClickCapture={onClickCapture}
          tabIndex={0}
          role="region"
          aria-label="Followed teams"
        >
          {ordered.map((card) => (
            <FeaturedTeamCard
              key={`${card.competitionKey}:${card.teamKey}`}
              card={card}
              hiddenStoryRefs={props.hiddenStoryRefs}
              onStoryChanged={props.onStoryChanged}
            />
          ))}
        </div>
        <button
          type="button"
          className="sp-ticker__nav"
          aria-label="Scroll right"
          hidden={atEnd}
          onClick={() => nudge(1)}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

// Desk-strip card (mrb7mwhv): the /sports followed strip deliberately diverges from the
// compact /today widget. Ben wanted far more room per team — "not so compact and busy" — and
// the strip to lead the page, so this is the roomy, image-forward variant: a wide lead-story
// banner, a serif team name at display size, and generous spacing. /today keeps the dense
// TickerTeam below. The team-semantics helpers (standingIsSane, NextGameContent, Crest/FormPips)
// are shared so the two layouts can't drift on what a team's status/standing means.
function FeaturedTeamCard(props: {
  card: FollowedTeamCard;
  hiddenStoryRefs?: ReadonlySet<string>;
  onStoryChanged?: StoryFeedbackChange;
}) {
  const { card } = props;
  // Body slot rule (#963 supersedes the live half of mrawrk0e): pre-game/idle AND live cards
  // lead with news — a live game's score lives in the footer strip now, not the body — while
  // a finished game still leads with its result.
  const showNews =
    card.status === "news" ||
    card.status === "live" ||
    (card.status === "today" && card.todayGameState !== "final");
  const stories = card.stories.filter((story) => !props.hiddenStoryRefs?.has(story.storyRef ?? ""));
  const lead = stories[0] ?? null;
  // The footer bar renders for an upcoming fixture OR a live game (#963). A card with no
  // footer at all spends that space on one more headline instead of leaving a gap (Ben
  // 2026-07-09 /sports: "for teams/leagues not active and without the next game bar, add
  // another story headline"). Footer-bearing cards keep the tighter two-link cap.
  const hasFooterBar = card.status === "live" || Boolean(card.nextMatch);
  const storyCap = hasFooterBar ? 2 : 3;
  // A score card never spent stories[0] on its headline, so its link list starts at 0; a news
  // card already showed stories[0] as the headline, so its list starts at 1. Cap governed by
  // hasNextBar above — air, not a wall of headlines (mrb7mwhv).
  const secondary = showNews ? stories.slice(1, 1 + storyCap) : stories.slice(0, storyCap);
  const isScore = !showNews && /\d/.test(card.primary);

  return (
    <article className="sp-feat">
      {/* Lead-story art is the banner even on score cards — it fills the new width and gives the
          strip the image-forward, editorial feel Ben referenced. Crest plate is the artless
          fallback. alt="" — the headline/name beside it already names the content. The status
          flag overlays the banner's top-left the way a broadcast bug sits on a video frame. */}
      <div className="sp-feat__banner">
        {lead?.imageUrl ? (
          <img className="sp-feat__img" src={lead.imageUrl} alt="" loading="lazy" />
        ) : (
          <span className="sp-feat__plate">
            <Crest name={card.name} crestUrl={card.crestUrl} size="lg" />
          </span>
        )}
        {card.status === "live" ? (
          <span className="sp-feat__flag sp-feat__flag--live">
            <LiveDot />
            Live
          </span>
        ) : card.status === "today" ? (
          <span className="sp-feat__flag sp-feat__flag--today">Today</span>
        ) : null}
      </div>
      <div className="sp-feat__body">
        <div className="sp-feat__idn">
          <Crest name={card.name} crestUrl={card.crestUrl} size="sm" />
          <h3 className="sp-feat__name">{card.name}</h3>
        </div>
        {/* Always render the sub row — even when a team has no standing OR form — so its fixed
            height is reserved on every card and the news/lead below lines up across the four-up
            strip regardless of league (Ben 2026-07-08 /sports annotation #2: "reserve this space
            for all teams/leagues so the news sections line up, even if there's nothing to draw
            from"). The standing chip and form pips stay conditional INSIDE the reserved row. */}
        <div className="sp-feat__sub">
          {standingIsSane(card) ? <span className="sp-feat__standing">{card.standing}</span> : null}
          <FormPips form={card.form} detail={card.formDetail} />
        </div>
        {/* Headline slot: a live/final score reads as the lede in tabular figures; otherwise the
            lead story headline carries it, set in the display face. */}
        {showNews ? (
          lead ? (
            <>
              <a className="sp-feat__lead" href={lead.url} target="_blank" rel="noreferrer">
                {lead.title}
                {lead.publisherDomain === "espn.com" ? null : ` · ${lead.publisherLabel}`}
              </a>
              <StoryFeedbackMenu
                storyRef={lead.storyRef}
                surface="sports"
                onChanged={props.onStoryChanged ?? (() => undefined)}
              />
            </>
          ) : (
            // Storyless pre-game/idle card: an honest placeholder, NEVER the matchup — the Next
            // footer already carries the fixture, so echoing card.primary here is the duplication
            // mrawrk0e forbids (the else-branch used to leak it, contradicting this card's own
            // "news-or-score, never matchup" rule). Mirrors TickerTeam's "No recent news" so the
            // /sports strip and the /today widget stay in lockstep (top-area feedback 2026-07-07).
            <span className="sp-feat__lead sp-feat__lead--empty">No recent news</span>
          )
        ) : card.resultMatch ? (
          // Finished game: lead with the opponent crest and show just "L 3–9" — the crest carries
          // the opponent's identity so the "vs Blue Jays" text tail (which read as cheap, Ben
          // 2026-07-08 /sports annotation #2) is gone. Same crest-leads treatment as the Next
          // footer below. The sr-only name keeps the opponent reachable for screen readers.
          <div className="sp-feat__result">
            <Crest
              name={card.resultMatch.opponentName}
              crestUrl={card.resultMatch.opponentCrestUrl}
              size="sm"
            />
            <p className="sp-feat__score">{card.resultMatch.scoreText}</p>
            <span className="sp-sronly">vs {card.resultMatch.opponentName}</span>
          </div>
        ) : (
          <p className={isScore ? "sp-feat__score" : "sp-feat__matchup"}>
            {card.primary.replace(/\s*·\s*Scheduled$/i, "")}
          </p>
        )}
        {secondary.length > 0 ? (
          <ul className="sp-feat__stories">
            {secondary.map((story) => (
              <li key={story.url}>
                <a className="sp-feat__storylink" href={story.url} target="_blank" rel="noreferrer">
                  {story.title}
                  {story.publisherDomain === "espn.com" ? null : ` · ${story.publisherLabel}`}
                </a>
                <StoryFeedbackMenu
                  storyRef={story.storyRef}
                  surface="sports"
                  onChanged={props.onStoryChanged ?? (() => undefined)}
                />
              </li>
            ))}
          </ul>
        ) : null}
        {/* Footer strip (#963): a live game shows its current score here — the same dark
            .sp-next bar the next fixture uses (shared with /today, Ben 2026-07-09), so the
            strip is the one place a live card differs from its neighbors. Otherwise the
            upcoming fixture renders as before; no footer when there is neither. */}
        {card.status === "live" ? (
          <div className="sp-feat__next sp-next">
            <LiveNowContent scoreText={card.primary} />
          </div>
        ) : card.nextMatch ? (
          <div className="sp-feat__next sp-next">
            <NextGameContent next={card.nextMatch} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

// Exported for the Today widget (mrb4mhxt): one card component for both surfaces, so every
// desk-page refinement (thumbnails, cut status pills, standing+form in the identity block)
// shows up on /today for free instead of drifting in a parallel FollowedCard copy.
//
// Layout follows Ben's "Minimalist Sports Card V3" mockup (2026-07-09): header row = crest +
// (name over standing) with form pips right-aligned; body = lead-story art as a left media
// column with the headline + bulleted secondary links beside it; footer = full-width inverted
// "Next game" bar. Supersedes the mrawlzb7 standing/form sub-row and the mra5xnt2 40px inline
// thumb. Never-red form pips and the news-or-score primary-slot rule (mrawrk0e) are unchanged.
export function TickerTeam(props: {
  card: FollowedTeamCard;
  hiddenStoryRefs?: ReadonlySet<string>;
  onStoryChanged?: StoryFeedbackChange;
}) {
  const { card } = props;
  // Pre-game today cards drop the matchup line (the Next footer already names the fixture,
  // mrawrk0e) — but blanking the whole primary slot left those cards a hollow void next to
  // their news-status neighbors (top-area feedback 2026-07-07). Only the matchup text was
  // redundant; fill the slot with news instead so every non-score card shares one anatomy.
  // #963 extends that to live: the in-progress score moved to the footer strip, so the live
  // body shows news too — same rule as FeaturedTeamCard, both surfaces in lockstep.
  const showNews =
    card.status === "news" ||
    card.status === "live" ||
    (card.status === "today" && card.todayGameState !== "final");
  const stories = card.stories.filter((story) => !props.hiddenStoryRefs?.has(story.storyRef ?? ""));
  const lead = stories[0] ?? null;
  // Same slicing rule as FeaturedTeamCard: a news card spent stories[0] on its headline so
  // bullets start at 1; a score/result card never did, so its freshest story leads the bullets
  // (the old flat slice(1) silently dropped it on score cards). Two bullets max — the V3
  // mockup's card is air, not a wall of links.
  const secondary = showNews ? stories.slice(1, 3) : stories.slice(0, 2);
  return (
    <article className="sp-tk">
      {/* Identity header (V3): crest at md so it anchors the row, name with the standing
          stacked directly beneath, recent-form pips on the right edge. The live signal stays
          folded into the name row (eyebrow row cut per mratgoq4). */}
      <header className="sp-tk__head">
        <Crest name={card.name} crestUrl={card.crestUrl} size="md" />
        <div className="sp-tk__ident">
          <div className="sp-tk__hd">
            <span className="sp-tk__name">{card.name}</span>
            {card.status === "live" ? (
              <span className="sp-tk__live">
                <LiveDot />
                Live
              </span>
            ) : null}
          </div>
          {standingIsSane(card) ? <span className="sp-tk__standing">{card.standing}</span> : null}
        </div>
        <FormPips form={card.form} detail={card.formDetail} />
      </header>
      {/* Body: media-left split when the lead story carries art; otherwise the text column runs
          full width (no artless placeholder plate — minimalist card, nothing to fake). alt="" on
          the art: the linked headline beside it already names the story. */}
      <div className="sp-tk__body">
        {showNews && lead?.imageUrl ? (
          <img className="sp-tk__media" src={lead.imageUrl} alt="" loading="lazy" />
        ) : null}
        <div className="sp-tk__col">
          {showNews ? (
            lead ? (
              <>
                <a className="sp-tk__newstx" href={lead.url} target="_blank" rel="noreferrer">
                  {lead.title}
                  {lead.publisherDomain === "espn.com" ? null : ` · ${lead.publisherLabel}`}
                </a>
                <StoryFeedbackMenu
                  storyRef={lead.storyRef}
                  surface="today"
                  onChanged={props.onStoryChanged ?? (() => undefined)}
                />
              </>
            ) : (
              <span className="sp-tk__newstx sp-tk__newstx--empty">No recent news</span>
            )
          ) : card.resultMatch ? (
            // Finished game: crest-leads score, same treatment as FeaturedTeamCard on /sports
            // (#867, #885). The crest carries the opponent identity; the "vs X" text tail is
            // dropped (Ben /sports annotation #2), sr-only name keeps it reachable.
            <div className="sp-tk__result">
              <Crest
                name={card.resultMatch.opponentName}
                crestUrl={card.resultMatch.opponentCrestUrl}
                size="sm"
              />
              <span className="sp-tk__score">{card.resultMatch.scoreText}</span>
              <span className="sp-sronly">vs {card.resultMatch.opponentName}</span>
            </div>
          ) : (
            // Matchup lines ("Blue Jays @ Giants") get body type and wrap; score lines stay mono.
            // "· Scheduled" is server noise; the kickoff time lives in the Next footer below
            // (live feedback mrawhf6q), not appended here.
            <span className={/\d/.test(card.primary) ? "sp-tk__score" : "sp-tk__matchup"}>
              {card.primary.replace(/\s*·\s*Scheduled$/i, "")}
            </span>
          )}
          {secondary.length > 0 ? (
            <ul className="sp-tk__stories">
              {/* FollowedTeamNews carries no id — the url is the stable identity (service dedups by it) */}
              {secondary.map((story) => (
                <li key={story.url}>
                  <a className="sp-tk__storylink" href={story.url} target="_blank" rel="noreferrer">
                    {story.title}
                    {story.publisherDomain === "espn.com" ? null : ` · ${story.publisherLabel}`}
                  </a>
                  <StoryFeedbackMenu
                    storyRef={story.storyRef}
                    surface="today"
                    onChanged={props.onStoryChanged ?? (() => undefined)}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      {/* Footer bar: the V3 inverted strip. A live game shows its current score here (#963 —
          supersedes mrawrk0e's hide-while-live rule; the score left the body for this bar).
          Otherwise the next fixture renders as one line of text — opponent as TEXT on THIS
          surface (mockup "vs Rockies", reversing mrawvc48 here only; /sports keeps its crest
          footer). Today games read "Today · 6:45 PM" (mrawhf6q). */}
      {card.status === "live" ? (
        <div className="sp-tk__next sp-next">
          <LiveNowContent scoreText={card.primary} />
        </div>
      ) : card.nextMatch ? (
        <NextGameBar next={card.nextMatch} />
      ) : null}
    </article>
  );
}

// Followed whole-competition card for /today (Ben 2026-07-09: "show news/results for a followed
// league/tournament when it's active — look like the team cards but for the league"). Mirrors
// TickerTeam's anatomy so the two read as one grid: crest + label header (kind label sits where a
// team's standing sits), lead-story media + headline + secondary links body, and — replacing the
// Next-game footer, since a league has no single fixture — a recent-results strip (live/final rows).
// League/tournament cards carry the competition's official logo (Ben 2026-07-09 "I would prefer to
// have the logo to be clear"); <Crest> falls back to the initials swatch only when the catalog has
// no logo for that competition.
export function TickerLeague(props: {
  card: FollowedLeagueCard;
  hiddenStoryRefs?: ReadonlySet<string>;
  onStoryChanged?: StoryFeedbackChange;
}) {
  const { card } = props;
  const stories = card.stories.filter((story) => !props.hiddenStoryRefs?.has(story.storyRef ?? ""));
  const lead = stories[0] ?? null;
  // Lead story owns the headline slot; bullets start at the next story. Two max — same air-not-wall
  // rule as the team card (mockup keeps these cards light).
  const secondary = stories.slice(1, 3);
  const kindLabel = card.kind === "tournament" ? "Tournament" : "League";
  return (
    <article className="sp-tk">
      <header className="sp-tk__head">
        <Crest name={card.competitionLabel} crestUrl={card.logoUrl} size="md" />
        <div className="sp-tk__ident">
          <div className="sp-tk__hd">
            <span className="sp-tk__name">{card.competitionLabel}</span>
            {card.status === "live" ? (
              <span className="sp-tk__live">
                <LiveDot />
                Live
              </span>
            ) : null}
          </div>
          {/* Kind label fills the standing slot — a league card has no table position of its own. */}
          <span className="sp-tk__standing">{kindLabel}</span>
        </div>
      </header>
      <div className="sp-tk__body">
        {lead?.imageUrl ? (
          <img className="sp-tk__media" src={lead.imageUrl} alt="" loading="lazy" />
        ) : null}
        <div className="sp-tk__col">
          {lead ? (
            <>
              <a className="sp-tk__newstx" href={lead.url} target="_blank" rel="noreferrer">
                {lead.title}
                {lead.publisherDomain === "espn.com" ? null : ` · ${lead.publisherLabel}`}
              </a>
              <StoryFeedbackMenu
                storyRef={lead.storyRef}
                surface="today"
                onChanged={props.onStoryChanged ?? (() => undefined)}
              />
            </>
          ) : (
            <span className="sp-tk__newstx sp-tk__newstx--empty">No recent news</span>
          )}
          {secondary.length > 0 ? (
            <ul className="sp-tk__stories">
              {secondary.map((story) => (
                <li key={story.url}>
                  <a className="sp-tk__storylink" href={story.url} target="_blank" rel="noreferrer">
                    {story.title}
                    {story.publisherDomain === "espn.com" ? null : ` · ${story.publisherLabel}`}
                  </a>
                  <StoryFeedbackMenu
                    storyRef={story.storyRef}
                    surface="today"
                    onChanged={props.onStoryChanged ?? (() => undefined)}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      {/* Recent-results strip: the league's live/final games (leagueResults, ≤3). Replaces the
          team card's Next-game bar — a whole competition has no single "next fixture". Each row is
          the score line + a state chip (Live/Final detail). Rendered only when results exist. */}
      {card.results.length > 0 ? (
        <ul className="sp-tk__scores">
          {card.results.map((r) => (
            <li key={`${r.startsAt}-${r.line}`} className="sp-tk__scorerow">
              <span className="sp-tk__scoreline">{r.line}</span>
              <span
                className={`sp-tk__scorechip${r.state === "live" ? " sp-tk__scorechip--live" : ""}`}
              >
                {r.state === "live" ? (
                  <>
                    <LiveDot />
                    {r.detail}
                  </>
                ) : (
                  r.detail
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

// /today footer wrapper: the shared bar content in this surface's full-bleed container. The
// container class (.sp-tk__next) supplies the /today bleed; .sp-next + venue modifier supply
// the shared look, matched to the /sports footer (Ben 2026-07-09 "similar look across the
// bottom"). homeAway is "home"|"away" → --home solid accent / --away soft steel.
function NextGameBar(props: { next: FollowedNextMatch }) {
  return (
    <div className="sp-tk__next sp-next">
      <NextGameContent next={props.next} />
    </div>
  );
}

// Live-score footer content for BOTH surfaces (#963): while a game is in progress, the strip
// that normally carries the next fixture carries the current score instead — same dark
// .sp-next bar, so live and upcoming read as one system across the card bases. Composition
// mirrors NextGameContent: status token on the left (where the venue token sits), score
// floated right in the kickoff slot. scoreText is card.primary — the server already writes
// scoreLine(game) there for a live game, so no new data crosses the contract.
function LiveNowContent(props: { scoreText: string }) {
  return (
    <>
      <span className="sp-next__livetag">
        <LiveDot />
        Live
      </span>
      <span className="sp-next__when sp-next__score">{props.scoreText}</span>
    </>
  );
}

// Shared next-game footer content for BOTH surfaces — /today and /sports render it identically
// so the two pages read as siblings across the bottom (Ben 2026-07-09). Composition (Ben
// 2026-07-09 "change the bottom bar again"): venue token + opponent crest hug the LEFT, the
// date/time floats to the RIGHT (space-between via .sp-next__when margin-left:auto). The old
// bold "Next game:" label is gone — the bar's position under the card already says "next game".
//
// The crest carries the opponent identity visually (mrawvc48, supersedes the visible "vs Green
// Bay Packers" line from mra387k7), so the name is sr-only: sighted users see logo + kickoff,
// screen readers still hear "vs Green Bay Packers". For a game later today the date is dead
// weight — "Today · 6:45 PM" reads faster than "Tue, Jul 7" (mrawhf6q).
//
// nextMatchIsToday is computed here from the fixture instant + persisted locale (not a prop):
// card.status is ESPN-Eastern and stayed "today" after a game went final, so the footer kept
// reading "Today" for a fixture that had already rolled to tomorrow (#877 finding 1). Keeping
// the derivation in one component means only one place can get the local-day rule wrong.
function NextGameContent(props: { next: FollowedNextMatch }) {
  const locale = useUserLocale();
  const { opponent, when } = nextMatchParts(props.next, locale);
  const isToday = nextMatchIsToday(props.next, locale);
  // Venue now reads from the "vs"/"@" token instead of a home/away color — one dark bar for all
  // next matches (Ben 2026-07-09: dropped the color-coding as too much). aria-hidden because the
  // sr-only opponent below already carries "vs"/"at <team>" for assistive tech.
  const venue = props.next.homeAway === "home" ? "vs" : "@";
  return (
    <>
      <span className="sp-next__venue" aria-hidden="true">
        {venue}
      </span>
      <Crest
        name={props.next.opponentName}
        crestUrl={props.next.opponentCrestUrl ?? null}
        size="sm"
      />
      <span className="sp-next__when">
        <span className="sp-sronly">{opponent}</span>
        {isToday ? `Today · ${formatTime(props.next.startsAt, locale)}` : when}
      </span>
    </>
  );
}
