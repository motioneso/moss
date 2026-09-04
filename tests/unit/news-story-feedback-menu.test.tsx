// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NewsHeadline, NewsOverviewResponse } from "@moss/shared";
import { StoryFeedbackMenu } from "../../packages/news/src/web/story-feedback-menu.js";
import { newsQueryKeys } from "../../packages/news/src/web/query-keys.js";

function makeHeadline(id: string, feedbackRef = `news:${id}`): NewsHeadline {
  return {
    id,
    sourceKey: "wire",
    sourceLabel: "Wire",
    topicKey: null,
    topicLabel: "AI",
    title: `Story ${id}`,
    url: `https://example.com/${id}`,
    publishedAt: "2026-07-11T10:00:00.000Z",
    summary: "Summary",
    imageUrl: null,
    faviconUrl: null,
    feedbackRef
  };
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object" && "props" in value) {
    return text((value as { props: { children?: unknown } }).props.children);
  }
  return "";
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType("button")
    .find((item) => item.props["aria-label"] === label || text(item.props.children) === label)!;
}

describe("News story feedback menu", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not render when headline has no feedbackRef", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const headline = makeHeadline("1");
    delete (headline as { feedbackRef?: string }).feedbackRef;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(StoryFeedbackMenu, { headline, surface: "news" })
        )
      );
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it("drops the story from the overview query data at once when saving less like this", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ feedback: {} }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const h1 = makeHeadline("1");
    const h2 = makeHeadline("2");
    const initialData: NewsOverviewResponse = {
      topStories: [h1, h2],
      rankedStories: [h1, h2],
      sourceGroups: [
        {
          sourceKey: "wire",
          sourceLabel: "Wire",
          homepageUrl: "https://example.com",
          headlines: [h1, h2]
        }
      ],
      activeTopics: [],
      enabledSources: [{ sourceKey: "wire", label: "Wire" }],
      degraded: false
    };
    client.setQueryData(newsQueryKeys.overview, initialData);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(StoryFeedbackMenu, { headline: h1, surface: "news" })
        )
      );
    });

    // Open menu and select less_like_this
    await act(async () => button(renderer, "Feedback for Story 1").props.onClick());
    await act(async () => button(renderer, "Less like this").props.onClick());

    // Enter reason and submit form
    const textarea = renderer.root.findByType("textarea");
    await act(async () => textarea.props.onChange({ target: { value: "Not interesting" } }));
    const form = renderer.root.findByType("form");
    await act(async () => {
      form.props.onSubmit({ preventDefault: vi.fn() });
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me/usefulness-feedback",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          targetKind: "news_story",
          targetRef: "news:1",
          surface: "news",
          kind: "less_like_this",
          reason: "Not interesting"
        })
      })
    );

    const updatedData = client.getQueryData<NewsOverviewResponse>(newsQueryKeys.overview);
    expect(updatedData?.topStories.map((h) => h.id)).toEqual(["2"]);
    expect(updatedData?.rankedStories?.map((h) => h.id)).toEqual(["2"]);
    expect(updatedData?.sourceGroups[0]?.headlines.map((h) => h.id)).toEqual(["2"]);
  });

  it("does not drop the story on more like this", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ feedback: {} }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const h1 = makeHeadline("1");
    const h2 = makeHeadline("2");
    const initialData: NewsOverviewResponse = {
      topStories: [h1, h2],
      rankedStories: [h1, h2],
      sourceGroups: [],
      activeTopics: [],
      enabledSources: [],
      degraded: false
    };
    client.setQueryData(newsQueryKeys.overview, initialData);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(StoryFeedbackMenu, { headline: h1, surface: "news" })
        )
      );
    });

    await act(async () => button(renderer, "Feedback for Story 1").props.onClick());
    await act(async () => {
      button(renderer, "More like this").props.onClick();
      await Promise.resolve();
    });

    const updatedData = client.getQueryData<NewsOverviewResponse>(newsQueryKeys.overview);
    expect(updatedData?.topStories.map((h) => h.id)).toEqual(["1", "2"]);
  });
});
