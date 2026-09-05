import type { NewsTopicKey, NewsTopicOption } from "@moss/shared";

/**
 * Curated V1 source catalog (spec docs/superpowers/specs/2026-07-08-news-module.md). Every feed
 * URL below was live-verified (HTTP 200 + RSS/Atom root) on 2026-07-08; fixtures for the three
 * parser shapes (RSS2 + media:thumbnail, RSS2 + media:content, Atom) live in `__fixtures__/`.
 * Feed URLs are static data — request params can never steer the fetch target, and the dataset
 * runtime additionally pins fetches to the hosts declared in the manifest.
 */
export interface NewsSourceEntry {
  readonly sourceKey: string;
  readonly label: string;
  readonly homepageUrl: string;
  /** Part of the effective source set for users with no explicit `source` prefs. */
  readonly defaultEnabled: boolean;
  readonly topFeedUrl: string;
  readonly topicFeeds: Readonly<Partial<Record<NewsTopicKey, string>>>;
  /** Hosts the feeds themselves are served from (manifest fetchHosts). */
  readonly feedHosts: readonly string[];
  /** Hosts item artwork may come from; anything else is nulled by the adapter. */
  readonly imageHosts: readonly string[];
}

export const NEWS_TOPICS: readonly NewsTopicOption[] = [
  { topicKey: "world", label: "World" },
  { topicKey: "us", label: "U.S." },
  { topicKey: "politics", label: "Politics" },
  { topicKey: "business", label: "Business" },
  { topicKey: "technology", label: "Technology" },
  { topicKey: "science", label: "Science" },
  { topicKey: "health", label: "Health" },
  { topicKey: "culture", label: "Culture" }
];

const TOPIC_BY_KEY = new Map(NEWS_TOPICS.map((t) => [t.topicKey, t]));

export function topicOption(topicKey: string): NewsTopicOption | undefined {
  return TOPIC_BY_KEY.get(topicKey as NewsTopicKey);
}

export const NEWS_CATALOG: readonly NewsSourceEntry[] = [
  {
    sourceKey: "bbc",
    label: "BBC News",
    homepageUrl: "https://www.bbc.com/news",
    defaultEnabled: true,
    topFeedUrl: "https://feeds.bbci.co.uk/news/rss.xml",
    topicFeeds: {
      // BBC publishes no dedicated politics feed; politics selections skip this source.
      world: "https://feeds.bbci.co.uk/news/world/rss.xml",
      us: "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml",
      business: "https://feeds.bbci.co.uk/news/business/rss.xml",
      technology: "https://feeds.bbci.co.uk/news/technology/rss.xml",
      science: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
      health: "https://feeds.bbci.co.uk/news/health/rss.xml",
      culture: "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml"
    },
    feedHosts: ["feeds.bbci.co.uk"],
    imageHosts: ["ichef.bbci.co.uk"]
  },
  {
    sourceKey: "guardian",
    label: "The Guardian",
    homepageUrl: "https://www.theguardian.com",
    defaultEnabled: true,
    topFeedUrl: "https://www.theguardian.com/international/rss",
    topicFeeds: {
      world: "https://www.theguardian.com/world/rss",
      us: "https://www.theguardian.com/us-news/rss",
      politics: "https://www.theguardian.com/us-news/us-politics/rss",
      business: "https://www.theguardian.com/business/rss",
      technology: "https://www.theguardian.com/technology/rss",
      science: "https://www.theguardian.com/science/rss",
      culture: "https://www.theguardian.com/culture/rss"
    },
    feedHosts: ["www.theguardian.com"],
    imageHosts: ["i.guim.co.uk"]
  },
  {
    // AP News publishes no public first-party RSS feed (its page source declares index.rss,
    // which returns HTTP 401 Invalid client credentials). Uses Open RSS (openrss.org) as a
    // third-party feed provider for top headlines and topic desks.
    sourceKey: "ap",
    label: "AP News",
    homepageUrl: "https://apnews.com",
    defaultEnabled: true,
    topFeedUrl: "https://openrss.org/feed/apnews.com",
    topicFeeds: {
      world: "https://openrss.org/feed/apnews.com/world-news",
      us: "https://openrss.org/feed/apnews.com/us-news",
      politics: "https://openrss.org/feed/apnews.com/politics",
      business: "https://openrss.org/feed/apnews.com/business",
      technology: "https://openrss.org/feed/apnews.com/technology",
      science: "https://openrss.org/feed/apnews.com/science",
      health: "https://openrss.org/feed/apnews.com/health",
      culture: "https://openrss.org/feed/apnews.com/entertainment"
    },
    feedHosts: ["openrss.org"],
    imageHosts: ["dims.apnews.com", "assets.apnews.com"]
  },
  {
    sourceKey: "nytimes",
    label: "The New York Times",
    homepageUrl: "https://www.nytimes.com",
    defaultEnabled: false,
    topFeedUrl: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
    topicFeeds: {
      world: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
      us: "https://rss.nytimes.com/services/xml/rss/nyt/US.xml",
      politics: "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml",
      business: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",
      technology: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
      science: "https://rss.nytimes.com/services/xml/rss/nyt/Science.xml",
      health: "https://rss.nytimes.com/services/xml/rss/nyt/Health.xml",
      culture: "https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml"
    },
    feedHosts: ["rss.nytimes.com"],
    imageHosts: ["static01.nyt.com"]
  },
  {
    sourceKey: "npr",
    label: "NPR",
    homepageUrl: "https://www.npr.org",
    defaultEnabled: true,
    topFeedUrl: "https://feeds.npr.org/1001/rss.xml",
    topicFeeds: {
      world: "https://feeds.npr.org/1004/rss.xml",
      us: "https://feeds.npr.org/1003/rss.xml",
      politics: "https://feeds.npr.org/1014/rss.xml",
      business: "https://feeds.npr.org/1006/rss.xml",
      technology: "https://feeds.npr.org/1019/rss.xml",
      science: "https://feeds.npr.org/1007/rss.xml",
      health: "https://feeds.npr.org/1128/rss.xml",
      culture: "https://feeds.npr.org/1008/rss.xml"
    },
    feedHosts: ["feeds.npr.org"],
    // NPR's RSS carries no media:content/media:thumbnail/enclosure tags; the story image comes
    // from the first <img> in content:encoded instead, so these hosts gate that fallback too.
    imageHosts: ["media.npr.org", "npr.brightspotcdn.com"]
  },
  {
    sourceKey: "aljazeera",
    label: "Al Jazeera",
    homepageUrl: "https://www.aljazeera.com",
    defaultEnabled: false,
    topFeedUrl: "https://www.aljazeera.com/xml/rss/all.xml",
    topicFeeds: {},
    feedHosts: ["www.aljazeera.com"],
    imageHosts: []
  },
  {
    sourceKey: "verge",
    label: "The Verge",
    homepageUrl: "https://www.theverge.com",
    defaultEnabled: false,
    topFeedUrl: "https://www.theverge.com/rss/index.xml",
    // Single-beat outlet: its firehose IS its technology coverage.
    topicFeeds: { technology: "https://www.theverge.com/rss/index.xml" },
    feedHosts: ["www.theverge.com"],
    imageHosts: ["platform.theverge.com"]
  },
  {
    sourceKey: "arstechnica",
    label: "Ars Technica",
    homepageUrl: "https://arstechnica.com",
    defaultEnabled: false,
    topFeedUrl: "https://feeds.arstechnica.com/arstechnica/index",
    topicFeeds: {
      technology: "https://feeds.arstechnica.com/arstechnica/index",
      science: "https://feeds.arstechnica.com/arstechnica/science"
    },
    feedHosts: ["feeds.arstechnica.com"],
    imageHosts: ["cdn.arstechnica.net"]
  },
  {
    sourceKey: "wired",
    label: "Wired",
    homepageUrl: "https://www.wired.com",
    defaultEnabled: false,
    topFeedUrl: "https://www.wired.com/feed/rss",
    topicFeeds: { technology: "https://www.wired.com/feed/rss" },
    feedHosts: ["www.wired.com"],
    imageHosts: ["media.wired.com"]
  }
];

const BY_KEY = new Map(NEWS_CATALOG.map((e) => [e.sourceKey, e]));

export function sourceEntry(sourceKey: string): NewsSourceEntry | undefined {
  return BY_KEY.get(sourceKey);
}

function sortedUnion(hostLists: readonly (readonly string[])[]): string[] {
  return [...new Set(hostLists.flat())].sort();
}

/** Manifest fetch/image host allow-lists — derived so the catalog stays the single source of truth. */
export const NEWS_FETCH_HOSTS: readonly string[] = sortedUnion(
  NEWS_CATALOG.map((e) => e.feedHosts)
);
export const NEWS_IMAGE_HOSTS: readonly string[] = sortedUnion(
  NEWS_CATALOG.map((e) => e.imageHosts)
);
