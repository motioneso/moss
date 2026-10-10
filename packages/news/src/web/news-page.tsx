import "./styles/news-1.css";
import "./styles/news-2.css";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Newspaper } from "lucide-react";
import { Button, ButtonLink, EmptyState as SharedEmptyState, SectionHead } from "@moss/ui";
import type { NewsHeadline, NewsOverviewResponse } from "@moss/shared";

import { topicOption } from "../source/catalog.js";
import { getNewsOverview } from "./news-client.js";
import { newsQueryKeys } from "./query-keys.js";
import {
  HeroCarousel,
  NewsMosaic,
  NewsBriefs,
  SourceRail,
  composeMosaic,
  interleaveGroups
} from "./news-mosaic.js";

const SETTINGS_HREF = "/settings?section=modules&module=news";

type TopicFilter = string | null;

// Chips carry a topic key ("us") while headlines carry display labels ("U.S."), so a
// filter matches the raw value or its display label, ignoring case.
export function matchesTopic(headline: NewsHeadline, filter: TopicFilter): boolean {
  if (filter === null) return true;
  const wanted = new Set([filter, topicLabel(filter)].map((v) => v.toLowerCase()));
  const candidates = [...(headline.topicLabels ?? []), headline.topicKey, headline.topicLabel];
  return candidates.some((value) => value != null && wanted.has(value.toLowerCase()));
}

function topicLabel(key: string): string {
  return topicOption(key)?.label ?? key;
}

export function NewsPage() {
  const overviewQuery = useQuery({
    queryKey: newsQueryKeys.overview,
    queryFn: () => getNewsOverview()
    // No refetch interval: feeds move on the server's 10-minute dataset TTL, so polling
    // faster than that only re-reads the cache. Default window-focus refetch is enough.
  });
  const data = overviewQuery.data;
  const [topicFilter, setTopicFilter] = useState<TopicFilter>(null);

  if (!data) {
    return (
      <div className="nw-wrap">
        <Masthead activeTopics={[]} filter={null} onFilter={setTopicFilter} />
        {overviewQuery.isError ? (
          <p className="nw-lede" role="status">
            News is unavailable right now.{" "}
            <Button variant="link" onClick={() => void overviewQuery.refetch()}>
              Try again
            </Button>
          </p>
        ) : (
          <NewsLoading />
        )}
      </div>
    );
  }

  const hasStories =
    data.sourceGroups.length > 0 ||
    data.topStories.length > 0 ||
    Boolean(data.rankedStories?.length);
  const activeTopics = data.activeTopics;
  // The chip row only offers topics the user actually follows — in top-front-page mode every
  // headline's topicKey is null, so topic chips would filter everything out and lie.
  const filter: TopicFilter =
    topicFilter !== null && activeTopics.includes(topicFilter) ? topicFilter : null;

  const topStories = data.topStories.filter((h) => matchesTopic(h, filter));
  const groups = data.sourceGroups
    .map((group) => ({
      ...group,
      headlines: group.headlines.filter((h) => matchesTopic(h, filter))
    }))
    .filter((group) => group.headlines.length > 0);
  // The mosaic pool excludes the carousel's slides so no story renders twice on one page.
  const carouselIds = new Set(topStories.slice(0, 5).map((h) => h.id));
  const rankedPool = (data.rankedStories ?? interleaveGroups(groups)).filter((headline) =>
    matchesTopic(headline, filter)
  );
  const pool = rankedPool.filter((h) => !carouselIds.has(h.id));
  // Compose once here so the mosaic and the rail's "In brief" tail share one plan — the tail was
  // moved out of the mosaic column into the rail (Ben 2026-07-09 /news).
  const plan = composeMosaic(pool);

  return (
    <div className="nw-wrap">
      <Masthead activeTopics={activeTopics} filter={filter} onFilter={setTopicFilter} />
      {overviewQuery.isError ? (
        <p className="nw-lede" role="status">
          Could not refresh news. Showing the last loaded front page.{" "}
          <Button variant="link" onClick={() => void overviewQuery.refetch()}>
            Try again
          </Button>
        </p>
      ) : null}
      {hasStories ? (
        <>
          <HeroCarousel headlines={topStories} />
          <div className="nw-grid">
            <div className="nw-grid__main">
              <NewsMosaic plan={plan} />
            </div>
            <aside className="nw-grid__rail">
              <SourceRail groups={groups} />
              <NewsBriefs briefs={plan.briefs} />
            </aside>
          </div>
          {data.degraded ? (
            <p className="nw-degraded" role="status">
              Some sources didn&rsquo;t respond just now — this front page may be incomplete.
            </p>
          ) : null}
        </>
      ) : (
        <EmptyState data={data} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Masthead */

// Editorial page identity with functional topic filters over the loaded page.
// "All" + one chip per followed topic; hidden entirely in top-front-page mode (no topics).
function Masthead(props: {
  activeTopics: readonly string[];
  filter: TopicFilter;
  onFilter: (filter: TopicFilter) => void;
}) {
  return (
    <header className="nw-mast">
      <SectionHead title="Your front page" titleAs="h1" />
      {props.activeTopics.length > 0 ? (
        <nav className="nw-mast__nav" aria-label="Filter by topic">
          <Button
            variant="chip"
            size="sm"
            active={props.filter === null}
            aria-pressed={props.filter === null}
            onClick={() => props.onFilter(null)}
          >
            All
          </Button>
          {props.activeTopics.map((topicKey) => (
            <Button
              key={topicKey}
              variant="chip"
              size="sm"
              active={props.filter === topicKey}
              aria-pressed={props.filter === topicKey}
              onClick={() => props.onFilter(topicKey)}
            >
              {topicLabel(topicKey)}
            </Button>
          ))}
        </nav>
      ) : (
        // Top-front-page mode: no functional chips, so the band carries the section identity
        // instead of sitting empty between its two rules.
        <p className="nw-mast__plate">Front pages from your sources</p>
      )}
    </header>
  );
}

/* ---------------------------------------------------------------- Skeleton */

function NewsLoading() {
  return (
    <p className="nw-lede" role="status">
      Loading news…
    </p>
  );
}

/* ---------------------------------------------------------------- Empty state */

function EmptyState({ data }: { readonly data: NewsOverviewResponse }) {
  const noSources = data.enabledSources.length === 0;
  return (
    <SharedEmptyState
      icon={<Newspaper size={28} aria-hidden="true" />}
      title={noSources ? "Choose your sources" : "Nothing on the wire"}
      description={
        noSources
          ? "Pick the publications and topics you care about. This page becomes their combined front page."
          : "Your sources didn't return any stories just now. Check back shortly, or adjust your sources and topics."
      }
    >
      <ButtonLink href={SETTINGS_HREF} variant="secondary">
        Choose sources
      </ButtonLink>
    </SharedEmptyState>
  );
}
