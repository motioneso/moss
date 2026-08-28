import { useCallback, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Headline, SportsNewsGroup } from "@moss/shared";
import { useAutoAdvance } from "./use-auto-advance.js";
// Ranking now lives in a shared pure module (#857) so the server computes the SAME featured pick
// it needs to fetch the article body for. Re-export `isFollowed` because sports-around-ticker /
// sports-standings still import it from here.
import { isWrittenArticle, rankStories, BIG_STORY_WEIGHT } from "../news-ranking.js";
import { StoryFeedbackMenu, type StoryFeedbackChange } from "./story-feedback-menu.js";
export { isFollowed } from "../news-ranking.js";

function storyKey(headline: Headline): string {
  return headline.storyRef ?? headline.url;
}

export function NewsIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 5h13v14H4zM17 8h3v9a2 2 0 0 1-2 2h-1M7 8h7M7 12h7M7 16h4" />
    </svg>
  );
}

/* ------------------------------------------------------------- Hero carousel */

// Carousel sizing (live feedback mrb4w77y, "the hero could be a carousel of the top
// stories"): the old single StoryHero becomes a rotation over the topStories pool. Five
// slides is the cap — past that the dots stop being scannable and the tail stories are
// better served by the news band below. Auto-advance is slow enough to read a dek.
const CAROUSEL_CAP = 5;
const CAROUSEL_ADVANCE_MS = 7000;

// One slide = the exact split-hero layout StoryHero used to render (art beside display
// headline + dek), so the carousel is a rotation of front pages, not a new component idiom.
function HeroSlide({
  headline,
  active,
  onStoryChanged
}: {
  readonly headline: Headline;
  active: boolean;
  readonly onStoryChanged: StoryFeedbackChange;
}) {
  return (
    <article
      className={active ? "sp-carousel__slide sp-carousel__slide--active" : "sp-carousel__slide"}
      role="group"
      aria-roledescription="slide"
      aria-hidden={!active}
    >
      <div className="sp-hero sp-hero--story sp-hero--split">
        {headline.imageUrl ? (
          <img
            className="sp-photo sp-photo--herostory sp-photo--img"
            src={headline.imageUrl}
            alt=""
            loading="lazy"
          />
        ) : (
          <div className="sp-photo sp-photo--herostory" aria-hidden="true" />
        )}
        <div className="sp-hero__storybody">
          {/* Front-page furniture (mrbalm9x): a lead carries a desk kicker so it reads as the
              top story, not a promo — a "TOP STORY" desk tag beside the league section. This is
              exactly what a display ad never has, and it's what made the boxed hero read like
              one. Deliberately REVERSES the bare-eyebrow cut (mrb0opaa) under the new front-page
              model: that eyebrow was a lone floating mono word; this is anchored furniture at
              the head of the lead with an accent desk tag + hairline, not an orphaned label. */}
          <p className="sp-hero__kicker">
            <span className="sp-hero__kicker-desk">Top story</span>
            <span className="sp-hero__kicker-comp">
              {headline.competitionLabel} · {headline.publisherLabel}
            </span>
          </p>
          <h2 className="sp-hero__headline">
            {/* Inactive slides stay in the DOM for the crossfade but must not be tab stops */}
            <a
              className="sp-hero__link"
              href={headline.url}
              target="_blank"
              rel="noreferrer"
              tabIndex={active ? undefined : -1}
            >
              {headline.title}
            </a>
          </h2>
          {/* Standfirst: the article's summary as a dek under the headline, so the hero reads
              like a front page and not a bare link (live feedback mrawc8ww) */}
          {/* The competition credit line ("NHL") under the dek was cut entirely — headline +
              photo already say what the story is (live feedback mrb0opaa, ends mratrvvg). */}
          {headline.summary ? <p className="sp-hero__dek">{headline.summary}</p> : null}
          {/* Newspaper jump line (mrbalm9x round 2): the summary is the lead paragraph; this is
              the "continued on page A12" affordance that carries the reader into the full story.
              Same target as the headline, but the explicit link is the front-page idiom Ben
              wants on every lead. ESPN's feed gives only this one-paragraph description as body
              text — a deeper excerpt would need per-article fetching (own task+spec). Kept out
              of the tab order on inactive slides like the headline link. */}
          <a
            className="sp-hero__more"
            href={headline.url}
            target="_blank"
            rel="noreferrer"
            tabIndex={active ? undefined : -1}
          >
            Continue reading<span aria-hidden="true"> →</span>
          </a>
          {active ? (
            <StoryFeedbackMenu
              storyRef={headline.storyRef}
              surface="sports"
              onChanged={onStoryChanged}
            />
          ) : null}
        </div>
      </div>
    </article>
  );
}

// Quiet-day hero carousel (mrb4w77y): rotates the topStories pool where a single story hero
// stood. Slides crossfade on a timer; hover/focus pauses (reading beats rotation), reduced
// motion disables auto-advance entirely and leaves the arrows/dots as the only navigation.
// On a gameday this never mounts — the featured-game bar owns the hero slot and the same
// topStories collapse into the combined list in the grid instead.
export function HeroCarousel({
  headlines,
  hiddenStoryRefs,
  onStoryChanged = () => undefined
}: {
  readonly headlines: readonly Headline[];
  readonly hiddenStoryRefs?: ReadonlySet<string>;
  readonly onStoryChanged?: StoryFeedbackChange;
}) {
  const slides = headlines
    .filter((headline) => !hiddenStoryRefs?.has(headline.storyRef ?? ""))
    .slice(0, CAROUSEL_CAP);
  const count = slides.length;
  const [index, setIndex] = useState(0);
  // A refetch can shrink the pool while we're pointing past its end — clamp, don't crash.
  const active = Math.min(index, Math.max(count - 1, 0));
  const advance = useCallback(() => setIndex((current) => (current + 1) % count), [count]);
  const pauseHandlers = useAutoAdvance(count, advance, CAROUSEL_ADVANCE_MS);

  if (count === 0) {
    // Same placeholder the null-headline StoryHero rendered — a quiet day with no stories
    // still shows the hero slot's shape instead of collapsing the page.
    return (
      <section className="sp-hero sp-hero--story sp-hero--split" aria-label="Top story">
        <div className="sp-photo sp-photo--herostory" aria-hidden="true" />
        <div className="sp-hero__storybody">
          <h2 className="sp-hero__headline">No followed game today</h2>
        </div>
      </section>
    );
  }

  return (
    <section
      className="sp-carousel"
      aria-label="Top stories"
      aria-roledescription="carousel"
      {...pauseHandlers}
    >
      {/* All slides render stacked in one grid cell (CSS) so the stage holds the tallest
          slide's height — no reflow jump between a dek-heavy story and a bare headline. */}
      <div className="sp-carousel__stage">
        {slides.map((headline, i) => (
          <HeroSlide
            key={storyKey(headline)}
            headline={headline}
            active={i === active}
            onStoryChanged={onStoryChanged}
          />
        ))}
      </div>
      {count > 1 ? (
        <div className="sp-carousel__ctl">
          <button
            type="button"
            className="sp-carousel__nav"
            aria-label="Previous story"
            onClick={() => setIndex((active - 1 + count) % count)}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <div className="sp-carousel__dots">
            {slides.map((headline, i) => (
              <button
                key={storyKey(headline)}
                type="button"
                className="sp-carousel__dot"
                aria-label={`Story ${i + 1} of ${count}`}
                aria-current={i === active || undefined}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
          <button
            type="button"
            className="sp-carousel__nav"
            aria-label="Next story"
            onClick={() => setIndex((active + 1) % count)}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------- Latest column */

export function LatestColumn(props: {
  headlines: readonly Headline[];
  hiddenStoryRefs?: ReadonlySet<string>;
  onStoryChanged?: StoryFeedbackChange;
}) {
  // Kicker renamed "Latest" → "Top stories": the pool is ranked by ESPN's editorial feed
  // position with recency only as tiebreak (mrb51pnq), so "Latest" would now lie.
  const headlines = props.headlines.filter(
    (headline) => !props.hiddenStoryRefs?.has(headline.storyRef ?? "")
  );
  if (headlines.length === 0) return null;
  return (
    <section className="sp-latest" aria-label="Top stories">
      <p className="sp-col__kicker">Top stories</p>
      <ol className="sp-latest__list">
        {headlines.slice(0, 6).map((headline) => (
          <li className="sp-latest__item" key={storyKey(headline)}>
            <a className="sp-hl" href={headline.url} target="_blank" rel="noreferrer">
              {headline.imageUrl ? (
                <img className="sp-hl__thumb" src={headline.imageUrl} alt="" loading="lazy" />
              ) : (
                <span className="sp-hl__thumb sp-hl__thumb--empty" aria-hidden="true" />
              )}
              <span className="sp-hl__body">
                <span className="sp-hl__comp">{headline.competitionLabel}</span>
                <span className="sp-hl__title">{headline.title}</span>
              </span>
            </a>
            <StoryFeedbackMenu
              storyRef={headline.storyRef}
              surface="sports"
              onChanged={props.onStoryChanged ?? (() => undefined)}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ----------------------------------------------------------------- News band */

// Mosaic caps (live feedback mrb5reqq): the one-column-per-league grid read as "too many same
// sized stories", so the band below the feature is now a single weight-ranked mosaic across
// every shown league. Two stories earn a double-column slot with more visible text, a handful
// run as single-column standards, and the tail collapses into one combined "In brief" rail.
const MAJORS_CAP = 2;
const STANDARDS_CAP = 6;
const BRIEFS_CAP = 10;

// `isWrittenArticle`, `storyWeight`, `rankStories`, and `BIG_STORY_WEIGHT` moved to
// ../news-ranking.js (#857) so the server can compute the identical feature pick. Written majors
// still get a longform blurb clamp via isWrittenArticle below.

// Mosaic cell: every story now carries its own league kicker because the per-league section
// headers went with the per-league columns (mrb5reqq). `major` is the double-column tier;
// `longform` (written major, isWrittenArticle) trades the tight clamp for a real paragraph.
function NewsArticle({
  headline,
  major = false,
  onStoryChanged
}: {
  readonly headline: Headline;
  major?: boolean;
  readonly onStoryChanged: StoryFeedbackChange;
}) {
  const className = [
    "sp-newsband__art",
    major ? "sp-newsband__art--major" : null,
    major && isWrittenArticle(headline) ? "sp-newsband__art--longform" : null
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <article className={className}>
      {headline.imageUrl ? (
        <img className="sp-newsband__img" src={headline.imageUrl} alt="" loading="lazy" />
      ) : null}
      <p className="sp-newsband__artkicker">
        {headline.competitionLabel} · {headline.publisherLabel}
      </p>
      <h4 className="sp-newsband__title">{headline.title}</h4>
      {headline.summary ? <p className="sp-newsband__blurb">{headline.summary}</p> : null}
      <a className="sp-newsband__more" href={headline.url} target="_blank" rel="noreferrer">
        Continue reading →
      </a>
      <StoryFeedbackMenu storyRef={headline.storyRef} surface="sports" onChanged={onStoryChanged} />
    </article>
  );
}

// The band's single biggest story breaks out of the mosaic entirely: full-width split
// layout above the sections, art beside a display-size headline (mrb47x3h "give them some
// more space"). Only a story that clears BIG_STORY_WEIGHT earns the slot — on a quiet day
// the band opens straight with the mosaic.
function FeatureArticle({
  headline,
  onStoryChanged
}: {
  readonly headline: Headline;
  readonly onStoryChanged: StoryFeedbackChange;
}) {
  // ESPN sometimes hands back a small square team logo/crest instead of story art. Stretched to
  // fill the feature column (object-fit: cover on width:100%) it upscales and pixelates badly
  // (Ben 2026-07-08 /sports annotation #6). Measure the image's INTRINSIC width once it loads and,
  // when it's logo-sized rather than a real 16:9 photo, flip the frame to a "logo" treatment that
  // shows it centered at its natural size on a plate — never enlarged past its own pixels.
  const [isLogo, setIsLogo] = useState(false);
  return (
    <article className="sp-newsband__feature">
      {headline.imageUrl ? (
        <div className={`sp-newsband__imgframe${isLogo ? " sp-newsband__imgframe--logo" : ""}`}>
          <img
            className="sp-newsband__img sp-newsband__img--feature"
            src={headline.imageUrl}
            alt=""
            loading="lazy"
            onLoad={(event) => {
              // < 400px natural width ⇒ a logo/crest, well under the rendered column, so it would
              // only ever be blown up. Real story photos come through far wider and stay on cover.
              const img = event.currentTarget;
              if (img.naturalWidth > 0 && img.naturalWidth < 400) setIsLogo(true);
            }}
          />
        </div>
      ) : null}
      <div className="sp-newsband__featurebody">
        <p className="sp-newsband__featurekicker">
          {headline.competitionLabel} · {headline.publisherLabel}
        </p>
        <h3 className="sp-newsband__title sp-newsband__title--feature">{headline.title}</h3>
        {/* Fill the hero with real article body (#857, Ben's "fill the height with more article
            body"). The service fetches + SANITIZES-to-plaintext the featured story's ESPN body and
            hands it here already stripped of all HTML/tokens and length-capped. We render it as
            React text ({paragraph}) split on the blank lines the sanitizer inserts — text nodes,
            never dangerouslySetInnerHTML, so no ESPN markup can ever enter the DOM. Falls back to
            the one-paragraph dek when no body came through (fetch failed, or not the featured pick). */}
        {headline.body ? (
          headline.body.split("\n\n").map((paragraph, index) => (
            <p
              className="sp-newsband__blurb sp-newsband__blurb--feature"
              key={`${storyKey(headline)}-p${index}`}
            >
              {paragraph}
            </p>
          ))
        ) : headline.summary ? (
          <p className="sp-newsband__blurb sp-newsband__blurb--feature">{headline.summary}</p>
        ) : null}
        <a className="sp-newsband__more" href={headline.url} target="_blank" rel="noreferrer">
          Continue reading →
        </a>
        <StoryFeedbackMenu
          storyRef={headline.storyRef}
          surface="sports"
          onChanged={onStoryChanged}
        />
      </div>
    </article>
  );
}

export function NewsBand({
  groups,
  followedPairs,
  hiddenStoryRefs,
  onStoryChanged = () => undefined
}: {
  readonly groups: readonly SportsNewsGroup[];
  readonly followedPairs: ReadonlySet<string>;
  readonly hiddenStoryRefs?: ReadonlySet<string>;
  readonly onStoryChanged?: StoryFeedbackChange;
}) {
  const [filterKey, setFilterKey] = useState<string>("all");
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      headlines: group.headlines.filter(
        (headline) => !hiddenStoryRefs?.has(headline.storyRef ?? "")
      )
    }))
    .filter((group) => group.headlines.length > 0);
  if (visibleGroups.length === 0) return null;
  const groupKey = (group: SportsNewsGroup) =>
    group.kind === "sport" ? `sport:${group.sportKey}` : `competition:${group.competitionKey}`;
  const shown =
    filterKey === "all"
      ? visibleGroups
      : filterKey.startsWith("sport:")
        ? visibleGroups.filter((group) => `sport:${group.sportKey}` === filterKey)
        : visibleGroups.filter((group) => groupKey(group) === filterKey);

  // Flatten every shown league into one weight-ranked pool (mrb5reqq: "we don't really need it
  // to be one column per sport"). Ranking lives in ../news-ranking.js so the server picks the
  // identical feature to attach the article body to (#857) — see there for the +2 first-of-league
  // editorial bonus and the deterministic tie-break.
  const ranked = rankStories(shown, followedPairs);

  // Feature pick: heaviest story overall, first-found on ties (stable sort). It leaves the
  // mosaic so the same story never renders twice (mrb47x3h). MUST match the server's selectFeature
  // over the unfiltered groups so the body it fetched lands on this exact headline.
  const feature = ranked[0] && ranked[0].weight >= BIG_STORY_WEIGHT ? ranked[0].headline : null;
  const rest = feature ? ranked.slice(1) : ranked;

  // Majors need art — a double-column slot with no image is just a wide gap. Standards take
  // the next slice of the pool; everything past the caps collapses into the brief rail so a
  // busy day widens the tail instead of running the mosaic forever (mrb5reqq).
  const majorIds = new Set(
    rest
      .filter((s) => s.headline.imageUrl)
      .slice(0, MAJORS_CAP)
      .map((s) => storyKey(s.headline))
  );
  const flow = rest.filter((s) => !majorIds.has(storyKey(s.headline)));
  const standards = flow.slice(0, STANDARDS_CAP);
  const mosaicIds = new Set([...majorIds, ...standards.map((s) => storyKey(s.headline))]);
  // Weight order preserved across both tiers so the page reads big → small.
  const mosaic = rest.filter((s) => mosaicIds.has(storyKey(s.headline)));
  const briefs = flow.slice(STANDARDS_CAP, STANDARDS_CAP + BRIEFS_CAP);

  return (
    <section className="sp-newsband" aria-label="Sports news">
      <div className="sp-newsband__head">
        <p className="sp-col__kicker">News</p>
        <select
          className="sp-newsband__filter"
          aria-label="Filter sports news"
          value={filterKey}
          onChange={(event) => setFilterKey(event.currentTarget.value)}
        >
          <option value="all">All</option>
          {visibleGroups.map((group) => (
            <option key={groupKey(group)} value={groupKey(group)}>
              {group.competitionLabel}
            </option>
          ))}
        </select>
      </div>
      {feature ? <FeatureArticle headline={feature} onStoryChanged={onStoryChanged} /> : null}
      {/* Cross-league mosaic (mrb5reqq): replaces the one-column-per-league sections — spans
          and text length now vary by story weight instead of every league getting the same
          lead/short/brief ration regardless of how big its day was. */}
      <div className="sp-newsband__mosaic">
        {mosaic.map(({ headline }) => (
          <NewsArticle
            key={storyKey(headline)}
            headline={headline}
            major={majorIds.has(storyKey(headline))}
            onStoryChanged={onStoryChanged}
          />
        ))}
      </div>
      {briefs.length > 0 ? (
        <div className="sp-newsband__briefs">
          <p className="sp-newsband__briefslabel">In brief</p>
          <ul className="sp-newsband__brieflist">
            {briefs.map(({ headline }) => (
              <li className="sp-newsband__brief" key={storyKey(headline)}>
                <a
                  className="sp-newsband__brieflink"
                  href={headline.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {/* League tag replaces the section header the briefs used to sit under */}
                  <span className="sp-newsband__brieftag">{headline.competitionLabel}</span>
                  {headline.title}
                </a>
                <StoryFeedbackMenu
                  storyRef={headline.storyRef}
                  surface="sports"
                  onChanged={onStoryChanged}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
