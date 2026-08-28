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
});
