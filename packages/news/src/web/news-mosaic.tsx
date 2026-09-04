import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { NewsHeadline, NewsSourceGroup } from "@moss/shared";

import { featureEligible } from "../ranking.js";

import { StoryFeedbackMenu } from "./story-feedback-menu.js";

/* --------------------------------------------------------------- Pool helpers */

// The mosaic draws on every source group, but a straight concat would let the first source
// monopolize the top of the page. Round-robin interleave (each source's lead, then each
// source's second story, …) keeps the mix broadsheet-honest: the server already ranked each
// group internally, so position i is "the i-th best from that desk". Exported for unit tests.
export function interleaveGroups(groups: readonly NewsSourceGroup[]): NewsHeadline[] {
  const out: NewsHeadline[] = [];
  const deepest = groups.reduce((max, group) => Math.max(max, group.headlines.length), 0);
  for (let i = 0; i < deepest; i += 1) {
    for (const group of groups) {
      const headline = group.headlines[i];
      if (headline) out.push(headline);
    }
  }
  return out;
}

export interface MosaicPlan {
  readonly feature: NewsHeadline | null;
  /** Feature + majors + standards in pool order; majors flagged via `majorIds`. */
  readonly mosaic: readonly NewsHeadline[];
  readonly majorIds: ReadonlySet<string>;
  readonly briefs: readonly NewsHeadline[];
}

// Mosaic caps (spec "Page layout"): the feature breaks out full-width, two art-required
// majors take double columns, six standards fill the grid, and the tail collapses into a
// single "In brief" list so a busy day widens the tail instead of running the grid forever.
const MAJORS_CAP = 2;
const STANDARDS_CAP = 6;
const BRIEFS_CAP = 10;

// Pure tiering over an already-ordered pool (exported for unit tests). Majors need art —
// a double-column slot with no image is just a wide gap; the feature additionally needs a
// dek (featureEligible) to carry the top of the page.
export function composeMosaic(pool: readonly NewsHeadline[]): MosaicPlan {
  const feature = pool.find(featureEligible) ?? null;
  const rest = pool.filter((headline) => headline !== feature);
  const majorIds = new Set(
    rest
      .filter((headline) => headline.imageUrl)
      .slice(0, MAJORS_CAP)
      .map((headline) => headline.id)
  );
  const flow = rest.filter((headline) => !majorIds.has(headline.id));
  const standards = flow.slice(0, STANDARDS_CAP);
  const mosaicIds = new Set([...majorIds, ...standards.map((headline) => headline.id)]);
  return {
    feature,
    // Pool order preserved across both tiers so the page reads big → small.
    mosaic: rest.filter((headline) => mosaicIds.has(headline.id)),
    majorIds,
    briefs: flow.slice(STANDARDS_CAP, STANDARDS_CAP + BRIEFS_CAP)
  };
}

/* ------------------------------------------------------------- Hero carousel */

// Same rotation idiom as sports' quiet-day hero (packages/sports/src/web/sports-news.tsx):
// five slides max, slow crossfade, hover/focus pauses, reduced motion disables auto-advance.
const CAROUSEL_CAP = 5;
const CAROUSEL_ADVANCE_MS = 7000;

function kicker(headline: NewsHeadline): string {
  const topics = headline.topicLabels?.length
    ? headline.topicLabels
    : headline.topicLabel
      ? [headline.topicLabel]
      : [];
  return topics.length > 0
    ? `${headline.sourceLabel} · ${topics.join(" · ")}`
    : headline.sourceLabel;
}

function HeroSlide({ headline, active }: { readonly headline: NewsHeadline; active: boolean }) {
  return (
    <article
      className={active ? "nw-carousel__slide nw-carousel__slide--active" : "nw-carousel__slide"}
      role="group"
      aria-roledescription="slide"
      aria-hidden={!active}
    >
      <div className="nw-hero nw-fbhost">
        {headline.imageUrl ? (
          <img className="nw-hero__photo" src={headline.imageUrl} alt="" loading="lazy" />
        ) : (
          <div className="nw-hero__photo nw-hero__photo--empty" aria-hidden="true" />
        )}
        <div className="nw-hero__body">
          <p className="nw-hero__kicker">
            <span className="nw-hero__kicker-desk">Top story</span>
            <span className="nw-hero__kicker-src">{kicker(headline)}</span>
          </p>
          <h2 className="nw-hero__headline">
            {/* Inactive slides stay in the DOM for the crossfade but must not be tab stops */}
            <a
              className="nw-hero__link"
              href={headline.url}
              target="_blank"
              rel="noreferrer"
              tabIndex={active ? undefined : -1}
            >
              {headline.title}
            </a>
          </h2>
          {headline.summary ? <p className="nw-hero__dek">{headline.summary}</p> : null}
          <a
            className="nw-more"
            href={headline.url}
            target="_blank"
            rel="noreferrer"
            tabIndex={active ? undefined : -1}
          >
            Continue reading<span aria-hidden="true"> →</span>
          </a>
        </div>
        {/* Feedback dots sit in the hero's top-right corner and show on hover (.nw-fbhost). */}
        {active ? <StoryFeedbackMenu headline={headline} surface="news" /> : null}
      </div>
    </article>
  );
}

export function HeroCarousel({ headlines }: { readonly headlines: readonly NewsHeadline[] }) {
  const slides = headlines.slice(0, CAROUSEL_CAP);
  const count = slides.length;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  // A refetch can shrink the pool while we're pointing past its end — clamp, don't crash.
  const active = Math.min(index, Math.max(count - 1, 0));

  useEffect(() => {
    if (paused || count < 2) return;
    // matchMedia in an effect, not render: SSR has no window, and this respects a user
    // flipping the OS setting mid-session on the next slide change.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % count),
      CAROUSEL_ADVANCE_MS
    );
    return () => window.clearInterval(timer);
  }, [paused, count]);

  if (count === 0) return null;

  return (
    <section
      className="nw-carousel"
      aria-label="Top stories"
      aria-roledescription="carousel"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {/* All slides render stacked in one grid cell (CSS) so the stage holds the tallest
          slide's height — no reflow jump between a dek-heavy story and a bare headline. */}
      <div className="nw-carousel__stage">
        {slides.map((headline, i) => (
          <HeroSlide key={headline.id} headline={headline} active={i === active} />
        ))}
      </div>
      {count > 1 ? (
        <div className="nw-carousel__ctl">
          <button
            type="button"
            className="nw-carousel__nav"
            aria-label="Previous story"
            onClick={() => setIndex((active - 1 + count) % count)}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <div className="nw-carousel__dots">
            {slides.map((headline, i) => (
              <button
                key={headline.id}
                type="button"
                className="nw-carousel__dot"
                aria-label={`Story ${i + 1} of ${count}`}
                aria-current={i === active || undefined}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
          <button
            type="button"
            className="nw-carousel__nav"
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

/* -------------------------------------------------------------------- Mosaic */

function MosaicArticle({
  headline,
  major = false
}: {
  readonly headline: NewsHeadline;
  major?: boolean;
}) {
  // No-photo standard cards get a --textonly modifier so CSS can drop the line clamp and show the
  // full sanitized summary, filling the space the missing 16:9 image would have taken (Ben
  // 2026-07-09 /news: "pull in more body text so when there isn't a photo there isn't a large
  // gap"; #1185: show the complete available summary, not just a taller clamp). `summary` is the
  // only body field the feed ships, so a genuinely terse summary still reads short — this spends
  // whatever text exists instead of stopping at 3 lines beside a phantom image slot. Majors always
  // carry art (composeMosaic requires it), so this only ever hits standards.
  const className = ["nw-mosaic__art", "nw-fbhost", major ? "nw-mosaic__art--major" : ""];
  if (!major && !headline.imageUrl) className.push("nw-mosaic__art--textonly");
  return (
    <article className={className.filter(Boolean).join(" ")}>
      {headline.imageUrl ? (
        <img className="nw-mosaic__img" src={headline.imageUrl} alt="" loading="lazy" />
      ) : null}
      <p className="nw-mosaic__artkicker">{kicker(headline)}</p>
      <h4 className="nw-mosaic__title">{headline.title}</h4>
      {headline.summary ? <p className="nw-mosaic__blurb">{headline.summary}</p> : null}
      <a className="nw-more" href={headline.url} target="_blank" rel="noreferrer">
        Continue reading →
      </a>
      <StoryFeedbackMenu headline={headline} surface="news" />
    </article>
  );
}

function FeatureArticle({ headline }: { readonly headline: NewsHeadline }) {
  return (
    <article className="nw-feature nw-fbhost">
      {headline.imageUrl ? (
        <img className="nw-feature__img" src={headline.imageUrl} alt="" loading="lazy" />
      ) : null}
      <div className="nw-feature__body">
        <p className="nw-feature__kicker">{kicker(headline)}</p>
        <h3 className="nw-feature__title">{headline.title}</h3>
        {headline.summary ? <p className="nw-feature__blurb">{headline.summary}</p> : null}
        <a className="nw-more" href={headline.url} target="_blank" rel="noreferrer">
          Continue reading →
        </a>
      </div>
      <StoryFeedbackMenu headline={headline} surface="news" />
    </article>
  );
}

// Takes a pre-composed plan (was: raw `pool`, composing internally) so news-page can share the
// same plan with the rail's <NewsBriefs> — the briefs tail now lives in the rail, not here
// (Ben 2026-07-09 /news). Composing twice would risk the two blocks drifting apart.
export function NewsMosaic({ plan }: { readonly plan: MosaicPlan }) {
  if (!plan.feature && plan.mosaic.length === 0) return null;
  return (
    <section className="nw-band" aria-label="Today's stories">
      {plan.feature ? <FeatureArticle headline={plan.feature} /> : null}
      <div className="nw-mosaic">
        {plan.mosaic.map((headline) => (
          <MosaicArticle
            key={headline.id}
            headline={headline}
            major={plan.majorIds.has(headline.id)}
          />
        ))}
      </div>
    </section>
  );
}

// "In brief" tail. Ben 2026-07-09 (/news): "moving this to below the news from your sources in the
// right rail." Lifted out of the wide mosaic column — where it ran as a 2-up list under the cards —
// into the narrow rail beneath <SourceRail>, where it reads as a single-column digest (CSS). Renders
// nothing when the tail is empty so the rail just ends at the source list on a quiet day.
export function NewsBriefs({ briefs }: { readonly briefs: readonly NewsHeadline[] }) {
  if (briefs.length === 0) return null;
  return (
    <div className="nw-briefs">
      <p className="nw-briefs__label">In brief</p>
      <ul className="nw-briefs__list">
        {briefs.map((headline) => (
          <li className="nw-briefs__item nw-fbhost" key={headline.id}>
            <a className="nw-briefs__link" href={headline.url} target="_blank" rel="noreferrer">
              <span className="nw-briefs__tag">{headline.sourceLabel}</span>
              {headline.title}
            </a>
            <StoryFeedbackMenu headline={headline} surface="news" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------- Source rail */

// Show the full per-source depth the service ships (GROUP_HEADLINES_CAP = 12) rather than a
// tighter 5 (Ben 2026-07-09 "fill the rail after this section… otherwise the main panel is just
// condensed for no reason"): the rail was truncating real headlines, leaving the 1fr column short
// beside the long 2fr mosaic so the split read as wasted space. Server already bounds the payload.
const RAIL_ITEMS_CAP = 12;

// Right-rail "From your sources" digest: one block per enabled source, title-only links —
// the by-source complement to the cross-source mosaic (spec "Page layout").
export function SourceRail({ groups }: { readonly groups: readonly NewsSourceGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section className="nw-rail" aria-label="From your sources">
      {/*
       * #1759: every module page links to its own settings page. News only offered that link
       * from its empty state, so a user who already had sources had no way back to change
       * them. The head sits on the source list rather than in the masthead — Ben cleared the
       * masthead folio on the sibling Sports page (2026-07-07) and moved its Manage control
       * down onto the band it configures; this is the same placement for the same reason.
       */}
      <div className="nw-rail__head">
        <p className="nw-kicker">From your sources</p>
        <a className="nw-rail__manage" href="/settings?section=modules&module=news">
          Manage
        </a>
      </div>
      {groups.map((group) => (
        <div className="nw-rail__group" key={group.sourceKey}>
          <a className="nw-rail__src" href={group.homepageUrl} target="_blank" rel="noreferrer">
            {group.sourceLabel}
          </a>
          <ul className="nw-rail__list">
            {group.headlines.slice(0, RAIL_ITEMS_CAP).map((headline) => (
              <li className="nw-rail__item nw-fbhost" key={headline.id}>
                <a className="nw-rail__link" href={headline.url} target="_blank" rel="noreferrer">
                  {headline.title}
                </a>
                <StoryFeedbackMenu headline={headline} surface="news" />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
