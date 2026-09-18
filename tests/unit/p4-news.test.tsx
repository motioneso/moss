// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import type { NewsHeadline, NewsOverviewResponse } from "@moss/shared";
import { NewsTodayWidget } from "../../packages/news/src/web/today-widget.js";
import { newsQueryKeys } from "../../packages/news/src/web/query-keys.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function story(index: number): NewsHeadline {
  return {
    id: `lane-${index}`,
    sourceKey: "wire",
    sourceLabel: "Wire",
    topicKey: null,
    topicLabel: null,
    title: `Lane story ${index}`,
    url: `https://example.com/lane/${index}`,
    publishedAt: "2026-09-17T10:00:00.000Z",
    imageUrl: index === 1 ? "/api/news/images/lane-1" : null,
    faviconUrl: "/api/news/favicon/example.com",
    summary: "Lane summary",
    feedbackRef: `news:lane-${index}`
  };
}

function overview(topStories: NewsHeadline[]): NewsOverviewResponse {
  return {
    topStories,
    rankedStories: topStories,
    sourceGroups: [],
    activeTopics: [],
    enabledSources: [{ sourceKey: "wire", label: "Wire" }],
    degraded: false
  };
}

function renderWith(client: QueryClient): string {
  return renderToString(
    createElement(QueryClientProvider, { client }, createElement(NewsTodayWidget))
  );
}

function seededClient(topStories: NewsHeadline[]): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(newsQueryKeys.overview, overview(topStories));
  return client;
}

describe("p4-news lane", () => {
  it("renders nothing until stories exist, so a fresh install stays clean", () => {
    const pending = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    expect(renderWith(pending)).toBe("");
    expect(renderWith(seededClient([]))).toBe("");
  });

  it("links the lead and every brief to its real destination in a new tab", () => {
    const html = renderWith(
      seededClient(Array.from({ length: 4 }, (_, index) => story(index + 1)))
    );
    for (let index = 1; index <= 4; index += 1) {
      expect(html).toContain(`href="https://example.com/lane/${index}"`);
    }
    expect(html.match(/target="_blank"/g)).toHaveLength(4);
    expect(html.match(/rel="noreferrer"/g)).toHaveLength(4);
  });

  it("recovers the lead photo slot when a later lead has a good photo", async () => {
    const client = seededClient(Array.from({ length: 4 }, (_, index) => story(index + 1)));
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(QueryClientProvider, { client }, createElement(NewsTodayWidget))
      );
    });

    expect(renderer!.root.findAllByProps({ src: "/api/news/images/lane-1" }).length).toBe(1);
    await act(async () => {
      renderer!.root.findAllByProps({ src: "/api/news/images/lane-1" })[0]!.props.onError();
    });
    expect(renderer!.root.findAllByProps({ src: "/api/news/images/lane-1" }).length).toBe(0);

    const next = Array.from({ length: 4 }, (_, index) =>
      index === 0 ? { ...story(10), imageUrl: "/api/news/images/lane-10" } : story(index + 1)
    );
    client.setQueryData(newsQueryKeys.overview, overview(next));
    const tree = createElement(QueryClientProvider, { client }, createElement(NewsTodayWidget));
    await act(async () => {
      renderer!.update(tree);
    });
    expect(renderer!.root.findAllByProps({ src: "/api/news/images/lane-10" }).length).toBe(1);
    expect(renderer!.root.findAllByProps({ children: "Lane story 10" }).length).toBe(1);
  });
});
