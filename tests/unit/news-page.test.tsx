import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { NewsHeadline, NewsOverviewResponse } from "@moss/shared";
import { NewsPage, matchesTopic } from "../../packages/news/src/web/news-page.js";
import { newsQueryKeys } from "../../packages/news/src/web/query-keys.js";

function story(id: string, overrides: Partial<NewsHeadline> = {}): NewsHeadline {
  return {
    id,
    sourceKey: "preferred.example",
    sourceLabel: "Preferred Wire",
    topicKey: null,
    topicLabel: "AI",
    topicLabels: ["AI", "Watches", "3D printing"],
    title: `Story ${id}`,
    url: `https://preferred.example/${id}`,
    publishedAt: "2026-07-11T10:00:00.000Z",
    imageUrl: `/api/news/images/${id}`,
    summary: "A useful summary.",
    ...overrides
  };
}

function renderNews(data: NewsOverviewResponse): string {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(newsQueryKeys.overview, data);
  return renderToString(
    <QueryClientProvider client={client}>
      <NewsPage />
    </QueryClientProvider>
  );
}

describe("personalized News page", () => {
  it("renders the full ranked feed, preferred rail, safe images, and matched labels", () => {
    const rankedStories = Array.from({ length: 7 }, (_, index) =>
      story(
        String(index + 1),
        index === 6
          ? {
              sourceKey: "neutral.example",
              sourceLabel: "Neutral Journal",
              title: "Neutral ranked story"
            }
          : index === 0
            ? { feedbackRef: "news:story-1" }
            : {}
      )
    );
    const data: NewsOverviewResponse = {
      topStories: rankedStories.slice(0, 6),
      rankedStories,
      sourceGroups: [
        {
          sourceKey: "preferred.example",
          sourceLabel: "Preferred Wire",
          homepageUrl: "https://preferred.example",
          headlines: rankedStories.slice(0, 2)
        }
      ],
      activeTopics: ["AI", "All"],
      enabledSources: [{ sourceKey: "preferred.example", label: "Preferred Wire" }],
      degraded: false
    };

    const html = renderNews(data);

    expect(html).toContain("Neutral ranked story");
    expect(html).toContain("From your sources");
    expect(html).toContain("/api/news/images/1");
    expect(html).toContain("Preferred Wire · AI · Watches · 3D printing");
    expect(html).toContain("Feedback for Story 1");
    expect(html).not.toContain("images.example");
  });

  // The News settings link now lives next to the section name in the topbar (replaced the
  // #1759 masthead text link).
  it("renders a populated feed without the empty state once stories exist", () => {
    const data: NewsOverviewResponse = {
      topStories: [story("1")],
      rankedStories: [story("1")],
      sourceGroups: [
        {
          sourceKey: "preferred.example",
          sourceLabel: "Preferred Wire",
          homepageUrl: "https://preferred.example",
          headlines: [story("1")]
        }
      ],
      activeTopics: [],
      enabledSources: [{ sourceKey: "preferred.example", label: "Preferred Wire" }],
      degraded: false
    };

    const html = renderNews(data);

    expect(html).not.toContain("Choose your sources");
  });

  it("uses null for All so a custom topic literally named All remains filterable", () => {
    const candidate = story("all", { topicLabel: "All", topicLabels: ["All"] });
    expect(matchesTopic(candidate, null)).toBe(true);
    expect(matchesTopic(candidate, "All")).toBe(true);
    expect(matchesTopic(candidate, "AI")).toBe(false);
  });
});
