import type { Page } from "@playwright/test";
import type {
  NewsEnabledSource,
  NewsHeadline,
  NewsOverviewResponse,
  NewsSourceGroup
} from "@moss/shared";

import { modulesResponse, myModulesResponse } from "./mock-modules.js";

// #899: shared fixture + route registration so the e2e suite covers /news without live RSS.
// Unlike mock-sports-api.ts (built for the since-removed capture harness and wired to nothing),
// this file exists to be consumed by news-overview.spec.ts. It deliberately does NOT touch the
// default fixtures in mock-modules.ts — adding news there would change the default nav under
// every existing spec.

export const NEWS_MODULE = {
  id: "news",
  name: "News",
  version: "0.1.0",
  lifecycle: "user-toggleable" as const,
  navigation: [{ id: "news", label: "News", path: "/news", icon: "newspaper", order: 34 }],
  settings: []
};

// 1x1 transparent PNG so "has art" tiles render without any network image request.
export const INLINE_IMG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let seq = 0;
export function newsHeadline(overrides: Partial<NewsHeadline> = {}): NewsHeadline {
  seq += 1;
  return {
    id: `h-${seq}`,
    sourceKey: "bbc",
    sourceLabel: "BBC News",
    topicKey: null,
    topicLabel: null,
    title: `Default headline ${seq}`,
    url: `https://example.com/story-${seq}`,
    publishedAt: "2026-08-22T08:00:00Z",
    imageUrl: null,
    faviconUrl: null,
    summary: "",
    ...overrides
  };
}

export function newsOverviewFixture(): NewsOverviewResponse {
  seq = 0;
  const world = { topicKey: "world", topicLabel: "World", topicLabels: ["World"] };
  const tech = {
    topicKey: "technology",
    topicLabel: "Technology",
    topicLabels: ["Technology"]
  };
  const bbc: NewsHeadline[] = [
    newsHeadline({
      ...world,
      title: "Summit reaches climate accord",
      summary: "Delegates agreed a binding emissions framework overnight.",
      imageUrl: INLINE_IMG
    }),
    newsHeadline({ ...world, title: "Markets steady after rate decision" }),
    newsHeadline({ ...tech, title: "Chipmaker unveils desktop accelerator" })
  ];
  const verge: NewsHeadline[] = [
    newsHeadline({
      ...tech,
      sourceKey: "verge",
      sourceLabel: "The Verge",
      title: "Hands-on with the new folding phone",
      summary: "A week with the hinge that finally disappears.",
      imageUrl: INLINE_IMG
    }),
    newsHeadline({
      ...tech,
      sourceKey: "verge",
      sourceLabel: "The Verge",
      title: "Browser ships tab groups sync"
    }),
    newsHeadline({
      ...world,
      sourceKey: "verge",
      sourceLabel: "The Verge",
      title: "Satellite internet reaches the archipelago"
    })
  ];
  const sourceGroups: NewsSourceGroup[] = [
    {
      sourceKey: "bbc",
      sourceLabel: "BBC News",
      homepageUrl: "https://www.bbc.com/news",
      headlines: bbc
    },
    {
      sourceKey: "verge",
      sourceLabel: "The Verge",
      homepageUrl: "https://www.theverge.com",
      headlines: verge
    }
  ];
  const enabledSources: NewsEnabledSource[] = [
    { sourceKey: "bbc", label: "BBC News" },
    { sourceKey: "verge", label: "The Verge" }
  ];
  return {
    topStories: [bbc[0]!, verge[0]!, bbc[1]!],
    sourceGroups,
    activeTopics: ["world", "technology"],
    enabledSources,
    degraded: false
  };
}

export async function registerMockNewsRoutes(
  page: Page,
  overview: NewsOverviewResponse
): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
  await page.route("**/api/modules", (route) =>
    route.fulfill(json({ modules: [...modulesResponse.modules, NEWS_MODULE] }))
  );
  await page.route("**/api/me/modules", (route) =>
    route.fulfill(
      json({
        modules: [
          ...myModulesResponse.modules,
          {
            ...NEWS_MODULE,
            required: false,
            supportsUserDisable: true,
            instanceDisabled: false,
            userDisabled: false,
            active: true,
            hasPreferences: false,
            hasUserCredentials: false
          }
        ]
      })
    )
  );
  await page.route("**/api/news/overview", (route) => route.fulfill(json(overview)));
  await page.route("**/api/news/catalog", (route) =>
    route.fulfill(
      json({
        sources: [
          {
            sourceKey: "bbc",
            label: "BBC News",
            homepageUrl: "https://www.bbc.com/news",
            defaultEnabled: true,
            topics: ["world"]
          }
        ],
        topics: [{ topicKey: "world", label: "World" }]
      })
    )
  );
  await page.route("**/api/news/prefs", (route) => route.fulfill(json({ prefs: [] })));
}
