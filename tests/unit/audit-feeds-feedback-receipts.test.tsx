// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewsHeadline, UsefulnessFeedbackDto } from "@moss/shared";
import { NewsPage } from "../../packages/news/src/web/news-page.js";
import { StoryFeedbackMenu } from "../../packages/news/src/web/story-feedback-menu.js";
import { StoryFeedbackSettings } from "../../packages/news/src/settings/story-feedback.js";
import { newsQueryKeys } from "../../packages/news/src/web/query-keys.js";
import { resetDismissedStoriesForTests } from "../../packages/news/src/web/dismissed-story-tracker.js";

let tree: ReactTestRenderer;
let client: QueryClient;
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object" && "children" in value) return text(value.children);
  if (value && typeof value === "object" && "props" in value)
    return text((value.props as { children?: unknown }).children);
  return "";
}
function button(label: string) {
  const found = tree.root
    .findAllByType("button")
    .find((item) => item.props["aria-label"] === label || text(item.props.children) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status });
}
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
async function click(label: string) {
  await act(async () => {
    button(label).props.onClick();
    await flush();
  });
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const story: NewsHeadline = {
  id: "one",
  feedbackRef: "news:one",
  sourceKey: "wire",
  sourceLabel: "Wire",
  topicKey: null,
  topicLabel: null,
  title: "First story",
  url: "https://example.com/one",
  publishedAt: "2026-10-11T00:00:00Z",
  imageUrl: null,
  faviconUrl: null,
  summary: ""
};
const feedback: UsefulnessFeedbackDto = {
  id: "feedback-one",
  ownerUserId: "synthetic-owner",
  targetKind: "news_story",
  targetRef: "news:one",
  surface: "news",
  kind: "less_like_this",
  sourceKind: "news",
  sourceLabel: "Wire",
  priorityBand: null,
  effectKind: null,
  effectRef: null,
  metadata: { headline: "First story" },
  status: "active",
  reason: "Original reason",
  revision: 1,
  ruleVersion: null,
  createdAt: "2026-10-11T00:00:00Z",
  updatedAt: "2026-10-11T00:00:00Z",
  resolvedAt: null
};
async function mountMenu() {
  await act(async () => {
    tree = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(StoryFeedbackMenu, { headline: story, surface: "news" })
      )
    );
  });
}
async function mountSettings() {
  client.setQueryData(newsQueryKeys.feedback, { feedback: [feedback] });
  await act(async () => {
    tree = create(
      createElement(QueryClientProvider, { client }, createElement(StoryFeedbackSettings))
    );
  });
}
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } }
  });
});
afterEach(() => {
  act(() => tree?.unmount());
  client.clear();
  resetDismissedStoriesForTests();
  vi.unstubAllGlobals();
});

describe("audit feeds: feedback creation receipts", () => {
  it("shows pending and saved receipts for positive feedback", async () => {
    const request = deferred();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => request.promise)
    );
    await mountMenu();
    await click("Feedback for First story");
    await click("More like this");
    expect(text(tree.toJSON())).toContain("Saving feedback");
    await act(async () => {
      request.resolve(response({ feedback: { ...feedback, kind: "more_like_this" } }));
      await flush();
    });
    expect(text(tree.toJSON())).toContain("Preference saved");
  });

  it("shows a positive-feedback failure outside the closed menu and can retry", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValue(response({ feedback: { ...feedback, kind: "more_like_this" } }));
    vi.stubGlobal("fetch", fetch);
    await mountMenu();
    await click("Feedback for First story");
    await click("More like this");
    expect(text(tree.toJSON())).toContain("Could not save that feedback. Try again.");
    await click("Feedback for First story");
    await click("More like this");
    expect(text(tree.toJSON())).toContain("Preference saved");
  });

  it("retains the less-like-this draft on rejection and blocks cancellation while saving", async () => {
    const request = deferred();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => request.promise)
    );
    await mountMenu();
    await click("Feedback for First story");
    await click("Less like this");
    await act(async () =>
      tree.root.findByType("textarea").props.onChange({ target: { value: "Keep this reason" } })
    );
    await act(async () => {
      tree.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
      await flush();
    });
    expect(button("Cancel").props.disabled).toBe(true);
    await act(async () => {
      request.resolve(response({}, 503));
      await flush();
    });
    expect(tree.root.findByType("textarea").props.value).toBe("Keep this reason");
    expect(text(tree.toJSON())).toContain("Could not save that feedback");
  });
});

describe("audit feeds: assembled dismissal receipt", () => {
  it("keeps the persisted outcome visible after the dismissed story unmounts", async () => {
    client.setQueryData(newsQueryKeys.overview, {
      topStories: [story],
      rankedStories: [story],
      sourceGroups: [],
      activeTopics: [],
      enabledSources: [{ sourceKey: "wire", label: "Wire" }],
      degraded: false
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    );
    const request = deferred();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => request.promise)
    );
    await act(async () => {
      tree = create(createElement(QueryClientProvider, { client }, createElement(NewsPage)));
    });
    await click("Feedback for First story");
    await click("Less like this");
    await act(async () =>
      tree.root.findByType("textarea").props.onChange({ target: { value: "Different angle" } })
    );
    await act(async () => {
      tree.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
      await flush();
    });
    expect(text(tree.toJSON())).not.toContain("Preference saved.");
    await act(async () => {
      request.resolve(response({ feedback }));
      await flush();
    });
    expect(
      tree.root
        .findAllByType("button")
        .filter((item) => item.props["aria-label"] === "Feedback for First story")
    ).toHaveLength(0);
    expect(text(tree.toJSON())).toContain(
      "Preference saved. Manage or remove it in News settings."
    );
    await act(async () => tree.unmount());
    await act(async () => {
      tree = create(createElement(QueryClientProvider, { client }, createElement(NewsPage)));
    });
    expect(text(tree.toJSON())).not.toContain("Preference saved.");
  });
});

describe("audit feeds: editing and undo receipts", () => {
  it("keeps a failed edit draft and scopes its retry message to the row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({}, 503))
    );
    await mountSettings();
    await click("Edit reason");
    await act(async () =>
      tree.root.findByType("textarea").props.onChange({ target: { value: "Revised reason" } })
    );
    await act(async () => {
      tree.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
      await flush();
    });
    expect(tree.root.findByType("textarea").props.value).toBe("Revised reason");
    expect(text(tree.toJSON())).toContain("Could not save that reason. Try again.");
    expect(button("Save reason").props.disabled).toBe(false);
  });

  it("disables remove and cancel during a delayed edit and shows the saved outcome", async () => {
    const request = deferred();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "PATCH"
          ? request.promise
          : Promise.resolve(response({ feedback: [{ ...feedback, reason: "Revised reason" }] }))
      )
    );
    await mountSettings();
    await click("Edit reason");
    await act(async () =>
      tree.root.findByType("textarea").props.onChange({ target: { value: "Revised reason" } })
    );
    await act(async () => {
      tree.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
      await flush();
    });
    expect(button("Remove").props.disabled).toBe(true);
    expect(button("Cancel").props.disabled).toBe(true);
    expect(text(tree.toJSON())).toContain("Saving reason");
    await act(async () => {
      request.resolve(response({ feedback: { ...feedback, reason: "Revised reason" } }));
      await flush();
    });
    expect(text(tree.toJSON())).toContain("Reason saved");
    expect(tree.root.findAllByType("textarea")).toHaveLength(0);
  });

  it("keeps removal failure visible and preserves a receipt after the last row disappears", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({}, 503))
      .mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? response({ feedback: { ...feedback, status: "resolved" } })
          : response({ feedback: [] })
      );
    vi.stubGlobal("fetch", fetch);
    await mountSettings();
    await click("Remove");
    expect(text(tree.toJSON())).toContain("Could not remove that preference. Try again.");
    expect(button("Remove").props.disabled).toBe(false);
    await click("Remove");
    expect(tree.root.findAllByType("li")).toHaveLength(0);
    expect(text(tree.toJSON())).toContain("Preference removed");
  });
});
