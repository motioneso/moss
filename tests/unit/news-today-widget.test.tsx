// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import type { NewsHeadline, NewsOverviewResponse } from "@moss/shared";
import { drawLeadContours } from "../../packages/news/src/web/lead-art.js";
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
    // Each favicon sits on the light tile (#2290): the image is the tile span's direct child, so
    // dark or transparent icons read in both themes. Dropping the tile would fail this line.
    expect(html).toContain(
      '<span class="nw-twlist__favicon-tile"><img class="nw-twlist__favicon" src="/api/news/favicon/example.com"'
    );
    // Exactly one tile per favicon row (stories 3 and 4), and none around the text fallback.
    expect(html.match(/class="nw-twlist__favicon-tile"/g)).toHaveLength(2);
    expect(html).not.toContain('nw-twlist__favicon-tile">Wire<');
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

  it("shows the topic label as the secondary kicker with a one-line dek", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const topStories = [
      story(1),
      { ...story(2), topicKey: "climate", topicLabel: "Climate" },
      story(3),
      story(4)
    ];
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

    expect(html).toContain("Climate");
    expect(html.match(/class="nw-twlist__dek"/g)).toHaveLength(3);
    expect(html).toContain("Summary");
  });

  it("renders the editorial desk head with the lead before the list", () => {
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

    expect(html).toContain("jds-brief--news");
    expect(html).toContain("02");
    expect(html).toContain("The wider world");
    expect(html).not.toContain("Top stories");
    expect(html.indexOf("nw-twlead")).toBeLessThan(html.indexOf("nw-twlist"));
  });

  it("drops a lead photo that fails to load and keeps the story", async () => {
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

    const imagesBefore = renderer!.root.findAllByProps({ src: "/api/news/images/today-1" });
    expect(imagesBefore.length).toBe(1);
    await act(async () => {
      imagesBefore[0]!.props.onError();
    });

    expect(renderer!.root.findAllByProps({ src: "/api/news/images/today-1" }).length).toBe(0);
    expect(renderer!.root.findAllByProps({ children: "Today story 1" }).length).toBe(1);
    expect(leadArt(renderer!).length).toBe(1);
  });

  it("shows only the photo when the lead has one that loads", async () => {
    const renderer = await renderWidget(Array.from({ length: 4 }, (_, index) => story(index + 1)));

    const frame = renderer.root.findByProps({ className: "nw-twlead__frame" });
    expect(frame.findAllByType("img").map((image) => image.props.src)).toEqual([
      "/api/news/images/today-1"
    ]);
    expect(leadArt(renderer).length).toBe(0);
  });

  it("draws decorative topic art in the photo frame when the lead has no photo", async () => {
    const lead = { ...story(1), imageUrl: null, topicKey: "culture", topicLabel: "Culture" };
    const renderer = await renderWidget([lead, story(2), story(3)]);

    const frame = renderer.root.findByProps({ className: "nw-twlead__frame" });
    expect(frame.findAllByType("img").length).toBe(0);
    const [art] = leadArt(renderer);
    expect(art!.props.className).toBe("nw-leadart nw-leadart--culture");
    expect(art!.props["aria-hidden"]).toBe("true");
    expect(art!.findAllByType("path").length).toBeGreaterThan(3);
    // The terrain follows the topic, not just the colors.
    const drawn = art!.findAllByType("path").map((path) => path.props.d);
    for (const line of drawLeadContours(art!.props["data-seed"], "culture")) {
      expect(drawn).toContain(line.d);
    }
    // The rest of the lead is unchanged.
    expect(renderer.root.findAllByProps({ children: "Today story 1" }).length).toBe(1);
    expect(renderer.root.findAllByProps({ className: "nw-twlead__dek" }).length).toBe(1);
  });

  it("draws a different picture for a different lead story", async () => {
    const first = await renderWidget([{ ...story(1), imageUrl: null }]);
    const second = await renderWidget([{ ...story(1), imageUrl: null, title: "Another lead" }]);
    const again = await renderWidget([{ ...story(1), imageUrl: null }]);

    const seedOf = (renderer: ReactTestRenderer): unknown =>
      leadArt(renderer)[0]!.props["data-seed"];
    expect(seedOf(first)).not.toBe(seedOf(second));
    expect(seedOf(first)).toBe(seedOf(again));
  });
});

function leadArt(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) => typeof node.type === "string" && node.props.className?.startsWith?.("nw-leadart ")
  );
}

async function renderWidget(topStories: NewsHeadline[]): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
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
  return renderer!;
}
