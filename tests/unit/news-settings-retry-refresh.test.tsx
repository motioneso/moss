// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GetNewsPersonalizationResponse } from "@moss/shared";

import NewsSettings from "../../packages/news/src/settings/index.js";
import { newsQueryKeys } from "../../packages/news/src/web/query-keys.js";

// #3227: Retry only queues a background re-check, so the screen must look again afterwards
// or the "temporarily unavailable" mark never clears.

const personalization: GetNewsPersonalizationResponse = {
  availability: {
    aiConfigured: true,
    webSearchConfigured: true,
    customSourceByUrlEnabled: true,
    customSourceByNameEnabled: true,
    freeformTopicsEnabled: true
  },
  customSources: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      label: "The Atlantic",
      canonicalDomain: "theatlantic.com",
      homepageUrl: "https://www.theatlantic.com",
      feedUrl: null,
      retrievalMethod: "scrape",
      workaround: false,
      validationStatus: "approved",
      healthStatus: "temporarily_unavailable",
      createdAt: "2026-07-11T00:00:00.000Z"
    }
  ],
  customTopics: [],
  sourceExclusions: [],
  snapshot: null,
  refresh: {
    state: "idle",
    updatedAt: null,
    lastRequestedAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureKind: null
  }
};

let tree: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("news settings Retry refresh", () => {
  it("refetches the source list after Retry queues the re-check", async () => {
    vi.useFakeTimers();
    const personalizationReads = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = String(url);
        if (init?.method === "POST" && path.endsWith("/api/news/revalidation")) {
          return new Response(JSON.stringify({ queued: true }), {
            status: 202,
            headers: { "content-type": "application/json" }
          });
        }
        if (path.endsWith("/api/news/personalization")) {
          personalizationReads();
          return new Response(JSON.stringify(personalization), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      })
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    client.setQueryData(newsQueryKeys.catalog, { sources: [], topics: [] });
    client.setQueryData(newsQueryKeys.prefs, { prefs: [] });
    client.setQueryData(newsQueryKeys.personalization, personalization);
    client.setQueryData(newsQueryKeys.feedback, { feedback: [] });

    await act(async () => {
      tree = create(createElement(QueryClientProvider, { client }, createElement(NewsSettings)));
    });
    const retry = tree!.root.findByProps({ "aria-label": "Retry The Atlantic" });
    await act(async () => {
      retry.props.onClick();
    });
    expect(personalizationReads).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(personalizationReads).toHaveBeenCalled();
  });
});
