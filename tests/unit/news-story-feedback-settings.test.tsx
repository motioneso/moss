// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NewsHeadline, NewsOverviewResponse, UsefulnessFeedbackDto } from "@moss/shared";
import { StoryFeedbackSettings } from "../../packages/news/src/settings/story-feedback.js";
import { newsQueryKeys } from "../../packages/news/src/web/query-keys.js";
import {
  markStoryDismissed,
  resetDismissedStoriesForTests
} from "../../packages/news/src/web/dismissed-story-tracker.js";

afterEach(() => {
  resetDismissedStoriesForTests();
  vi.unstubAllGlobals();
});

function makeHeadline(id: string, feedbackRef: string): NewsHeadline {
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

function makeFeedback(overrides: Partial<UsefulnessFeedbackDto> = {}): UsefulnessFeedbackDto {
  return {
    id: "fb-1",
    ownerUserId: "user-1",
    targetKind: "news_story",
    targetRef: "news:1",
    surface: "news",
    kind: "less_like_this",
    sourceKind: null,
    sourceLabel: "Wire",
    priorityBand: null,
    effectKind: null,
    effectRef: null,
    metadata: { headline: "Story 1" },
    status: "active",
    reason: "Not interesting",
    revision: 1,
    ruleVersion: null,
    createdAt: "2026-07-11T10:00:00.000Z",
    updatedAt: "2026-07-11T10:00:00.000Z",
    resolvedAt: null,
    ...overrides
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

describe("News settings: removing a saved dismissal", () => {
  it("lets the story appear again on the next overview answer", async () => {
    // This story was dismissed earlier in this browser tab, exactly like clicking
    // "Less like this" would do.
    markStoryDismissed("news:1");

    const feedback = makeFeedback();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/undo") && init?.method === "POST") {
        return new Response(JSON.stringify({ feedback: { ...feedback, status: "resolved" } }), {
          status: 200
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Prime the list the way an already-loaded settings pane would have it, so the row is
    // there to click without needing to mock the list request too.
    client.setQueryData(newsQueryKeys.feedback, { feedback: [feedback] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(QueryClientProvider, { client }, createElement(StoryFeedbackSettings, {}))
      );
    });

    await act(async () => {
      button(renderer, "Remove").props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // A fresh answer from the server, as if the story had never been dismissed.
    const h1 = makeHeadline("1", "news:1");
    const h2 = makeHeadline("2", "news:2");
    const freshAnswer: NewsOverviewResponse = {
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
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify(freshAnswer), { status: 200 })
    );
    const { getNewsOverview } = await import("../../packages/news/src/web/news-client.js");
    const result = await getNewsOverview();

    // The removed dismissal must no longer hide story 1 from a new answer.
    expect(result.topStories.map((h) => h.id)).toEqual(["1", "2"]);
  });
});
