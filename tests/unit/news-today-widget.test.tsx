// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import type { NewsHeadline, NewsOverviewResponse } from "@moss/shared";
import { NewsTodayWidget } from "../../packages/news/src/web/today-widget.js";
import { newsQueryKeys } from "../../packages/news/src/web/query-keys.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

// A `.nw-twlist__tag` span's only child is the `SourceTag` component instance, not raw text, so
// reading its rendered text means unwrapping one more level: the plain-name fallback renders as a
// single string child of that instance.
function tagText(tag: ReactTestInstance): string | null {
  const child = tag.children[0];
  if (typeof child === "string") return child;
  if (!child) return null;
  const grandchild = child.children[0];
  return typeof grandchild === "string" ? grandchild : null;
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

  it("removes a brief story's icon and shows the publisher name when the icon fails to load", async () => {
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

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(QueryClientProvider, { client }, createElement(NewsTodayWidget))
      );
    });

    // Stories 3 and 4 both have the same favicon address (see the `story()` fixture above), so
    // two brief rows start out as an image naming the publisher; story 2 has none and already
    // shows the plain name.
    const imagesBefore = renderer!.root.findAllByProps({ src: "/api/news/favicon/example.com" });
    expect(imagesBefore.length).toBe(2);
    const tagsBefore = renderer!.root.findAllByProps({ className: "nw-twlist__tag" });
    expect(tagsBefore.filter((tag) => tagText(tag) === "Wire").length).toBe(1);

    await act(async () => {
      imagesBefore[0]!.props.onError();
    });

    // One row's image is gone, and one more row now shows the plain publisher name in its place
    // — the other favicon row is untouched, so this is a per-row fallback, not a global one.
    const imagesAfter = renderer!.root.findAllByProps({ src: "/api/news/favicon/example.com" });
    expect(imagesAfter.length).toBe(1);
    const tagsAfter = renderer!.root.findAllByProps({ className: "nw-twlist__tag" });
    expect(tagsAfter.filter((tag) => tagText(tag) === "Wire").length).toBe(2);
  });
});
