import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { NewsHeadline, NewsOverviewResponse } from "@moss/shared";
import { NewsTodayWidget } from "../../packages/news/src/web/today-widget.js";
import { newsQueryKeys } from "../../packages/news/src/web/query-keys.js";

function story(index: number): NewsHeadline {
  return {
    id: `today-${index}`,
    sourceKey: "wire",
    sourceLabel: "Wire",
    topicKey: null,
    topicLabel: null,
    title: `Today story ${index}`,
    url: `https://example.com/${index}`,
    publishedAt: "2026-07-11T10:00:00.000Z",
    imageUrl: index === 1 ? "/api/news/images/today-1" : null,
    faviconUrl: index === 2 ? null : "/api/news/favicon/example.com",
    summary: "Summary",
    feedbackRef: `news:today-${index}`
  };
}

describe("News Today widget", () => {
  it("uses the shared overview query and renders one lead plus three briefs", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const topStories = Array.from({ length: 6 }, (_, index) => story(index + 1));
    const data: NewsOverviewResponse = {
      topStories,
      rankedStories: topStories,
      sourceGroups: [],
      activeTopics: [],
      enabledSources: [{ sourceKey: "wire", label: "Wire" }],
      degraded: false
    };
    client.setQueryData(newsQueryKeys.overview, data);

    const html = renderToString(
      <QueryClientProvider client={client}>
        <NewsTodayWidget />
      </QueryClientProvider>
    );

    for (let index = 1; index <= 4; index += 1) expect(html).toContain(`Today story ${index}`);
    expect(html).not.toContain("Today story 5");
    expect(html).toContain("/api/news/images/today-1");
    expect(client.getQueryData(newsQueryKeys.overview)).toBe(data);
  });

  it("shows each brief story's favicon, with the publisher name as alt text and tooltip, and falls back to the name when a story has no favicon", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const topStories = Array.from({ length: 4 }, (_, index) => story(index + 1));
    const data: NewsOverviewResponse = {
      topStories,
      rankedStories: topStories,
      sourceGroups: [],
      activeTopics: [],
      enabledSources: [{ sourceKey: "wire", label: "Wire" }],
      degraded: false
    };
    client.setQueryData(newsQueryKeys.overview, data);

    const html = renderToString(
      <QueryClientProvider client={client}>
        <NewsTodayWidget />
      </QueryClientProvider>
    );

    // Stories 3 and 4 have a favicon (see the `story()` fixture above): an image tag naming the
    // publisher, not the bare publisher name as visible text.
    expect(html).toContain('src="/api/news/favicon/example.com"');
    expect(html).toContain('alt="Wire"');
    expect(html).toContain('title="Wire"');
    // Story 2 has no favicon, so its brief row falls back to the plain publisher name.
    expect(html).toContain(">Wire<");
  });
});
