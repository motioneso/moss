// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewsHeadline, NewsOverviewResponse } from "@moss/shared";
import NewsSettings from "../../packages/news/src/settings/index.js";
import { NewsPage } from "../../packages/news/src/web/news-page.js";
import { newsQueryKeys } from "../../packages/news/src/web/query-keys.js";

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
    .find((item) => text(item.props.children) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function mount(component: typeof NewsSettings | typeof NewsPage) {
  await act(async () => {
    tree = create(createElement(QueryClientProvider, { client }, createElement(component)));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnMount: false, retryOnMount: false }
    }
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  );
});

afterEach(() => {
  act(() => tree?.unmount());
  client.clear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
});

function primeSettings() {
  client.setQueryData(newsQueryKeys.catalog, {
    sources: [
      {
        sourceKey: "bbc",
        label: "BBC News",
        homepageUrl: "https://bbc.com",
        defaultEnabled: true,
        topics: ["world"]
      },
      {
        sourceKey: "extra",
        label: "Extra Wire",
        homepageUrl: "https://extra.example",
        defaultEnabled: false,
        topics: ["world"]
      }
    ],
    topics: [{ topicKey: "world", label: "World" }]
  });
  client.setQueryData(newsQueryKeys.personalization, {
    customSources: [],
    customTopics: [],
    sourceExclusions: [],
    availability: null
  });
  client.setQueryData(newsQueryKeys.credentials, { credentials: [] });
  client.setQueryData(newsQueryKeys.feedback, { feedback: [] });
}

describe("audit feeds: preference reads", () => {
  it.each([false, true])(
    "never offers editable defaults after a failed preferences read (cached=%s)",
    async (cached) => {
      primeSettings();
      if (cached) client.setQueryData(newsQueryKeys.prefs, { prefs: [] });
      const query = client.getQueryCache().build(client, { queryKey: newsQueryKeys.prefs });
      query.setState({ status: "error", error: new Error("offline"), fetchStatus: "idle" });
      const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        response({}, 503)
      );
      vi.stubGlobal("fetch", fetch);
      await mount(NewsSettings);
      const source = tree.root
        .findAllByType("button")
        .find((item) => text(item.props.children).startsWith("Extra Wire"))!;
      expect(source.props.disabled).toBe(true);
      expect(source.props["aria-pressed"]).toBeUndefined();
      expect(text(source.props.children)).toContain("Unavailable");
      expect(button("World").props.disabled).toBe(true);
      expect(button("World").props["aria-pressed"]).toBeUndefined();
      // Guard the planner itself, in addition to the DOM's disabled affordance.
      await act(async () => source.props.onClick());
      expect(
        fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      ).toHaveLength(0);
      expect(text(tree.toJSON())).not.toContain("No sources enabled");
    }
  );

  it("retries failed reads and uses the saved explicit source set", async () => {
    primeSettings();
    const query = client.getQueryCache().build(client, { queryKey: newsQueryKeys.prefs });
    query.setState({ status: "error", error: new Error("offline"), fetchStatus: "idle" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/prefs"))
          return response({ prefs: [{ id: "pref-extra", kind: "source", key: "extra" }] });
        return response(client.getQueryData(newsQueryKeys.catalog));
      })
    );
    await mount(NewsSettings);
    await act(async () => {
      button("Retry preferences").props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const source = tree.root
      .findAllByType("button")
      .find((item) => text(item.props.children).startsWith("Extra Wire"))!;
    expect(source.props.disabled).toBe(false);
    expect(source.props["aria-pressed"]).toBe(true);
    const bbc = tree.root
      .findAllByType("button")
      .find((item) => text(item.props.children).startsWith("BBC News"))!;
    expect(bbc.props["aria-pressed"]).toBe(false);
  });
});

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sourceButton(name: string) {
  const found = tree.root
    .findAllByType("button")
    .find((item) => text(item.props.children).startsWith(name));
  if (!found) throw new Error(`Missing source: ${name}`);
  return found;
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("audit feeds: curated preference receipts", () => {
  it("keeps choices locked until the saved preference set has refreshed", async () => {
    primeSettings();
    client.setQueryData(newsQueryKeys.prefs, { prefs: [] });
    const write = deferred();
    const read = deferred();
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return write.promise;
      if (String(input).endsWith("/prefs")) return read.promise;
      return Promise.resolve(response({}));
    });
    vi.stubGlobal("fetch", fetch);
    await mount(NewsSettings);
    await act(async () => {
      button("World").props.onClick();
      await flush();
    });
    expect(text(tree.toJSON())).toContain("Saving preferences");
    expect(button("World").props.disabled).toBe(true);
    await act(async () => sourceButton("Extra Wire").props.onClick());
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await act(async () => {
      write.resolve(response({ pref: { id: "world", kind: "topic", key: "world" } }));
      await flush();
    });
    expect(button("World").props.disabled).toBe(true);
    expect(text(tree.toJSON())).not.toContain("Preferences saved.");
    await act(async () => {
      read.resolve(response({ prefs: [{ id: "world", kind: "topic", key: "world" }] }));
      await flush();
    });
    expect(button("World").props.disabled).toBe(false);
    expect(button("World").props["aria-pressed"]).toBe(true);
    expect(text(tree.toJSON())).toContain("Preferences saved.");
    await act(async () => {
      button("World").props.onClick();
      await flush();
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/news/prefs/world",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("refreshes a partially saved source sequence before a retry plans its remaining operation", async () => {
    primeSettings();
    client.setQueryData(newsQueryKeys.prefs, { prefs: [] });
    const saved = [{ id: "bbc-pin", kind: "source", key: "bbc" }];
    let writes = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes += 1;
        return writes === 2
          ? response({}, 503)
          : response({ pref: { id: "saved", kind: "source", key: "extra" } });
      }
      if (String(input).endsWith("/prefs")) return response({ prefs: saved });
      return response({});
    });
    vi.stubGlobal("fetch", fetch);
    await mount(NewsSettings);
    await act(async () => {
      sourceButton("Extra Wire").props.onClick();
      await flush();
    });
    expect(text(tree.toJSON())).toContain("Could not save all preferences");
    expect(text(tree.toJSON())).toContain("Some changes may have saved");
    expect(sourceButton("BBC News").props["aria-pressed"]).toBe(true);
    expect(sourceButton("Extra Wire").props["aria-pressed"]).toBe(false);
    await act(async () => {
      sourceButton("Extra Wire").props.onClick();
      await flush();
    });
    const bodies = fetch.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(init!.body as string));
    expect(bodies).toEqual([
      { kind: "source", key: "bbc" },
      { kind: "source", key: "extra" },
      { kind: "source", key: "extra" }
    ]);
    expect(text(tree.toJSON())).toContain("Preferences saved.");
    expect(text(tree.toJSON())).not.toContain("Could not save all preferences");
  });

  it("keeps a pending write locked across remount and plans from the read-back source set", async () => {
    client.setDefaultOptions({ queries: { retry: false, staleTime: 15_000 } });
    primeSettings();
    client.setQueryData(newsQueryKeys.prefs, {
      prefs: [
        { id: "bbc-pin", kind: "source", key: "bbc" },
        { id: "extra-pin", kind: "source", key: "extra" }
      ]
    });
    const write = deferred();
    const read = deferred();
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/prefs/bbc-pin") && init?.method === "DELETE")
        return write.promise;
      if (String(input).endsWith("/prefs") && !init?.method) return read.promise;
      return Promise.resolve(response({}));
    });
    vi.stubGlobal("fetch", fetch);
    await mount(NewsSettings);
    await act(async () => {
      sourceButton("BBC News").props.onClick();
      await flush();
    });
    await act(async () => tree.unmount());
    await mount(NewsSettings);
    expect(sourceButton("Extra Wire").props.disabled).toBe(true);
    await act(async () => sourceButton("Extra Wire").props.onClick());
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    await act(async () => {
      write.resolve(response({ ok: true }));
      await flush();
    });
    expect(sourceButton("Extra Wire").props.disabled).toBe(true);
    await act(async () => {
      read.resolve(response({ prefs: [{ id: "extra-pin", kind: "source", key: "extra" }] }));
      await flush();
    });
    expect(sourceButton("Extra Wire").props.disabled).toBe(false);
    expect(sourceButton("BBC News").props["aria-pressed"]).toBe(false);
    await act(async () => {
      sourceButton("Extra Wire").props.onClick();
      await flush();
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/news/prefs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ kind: "source_exclude", key: "extra" })
      })
    );
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("starts authoritative readback while unmounted and holds cached-success choices through remount", async () => {
    client.setDefaultOptions({ queries: { retry: false, staleTime: 15_000 } });
    primeSettings();
    client.setQueryData(newsQueryKeys.prefs, {
      prefs: [
        { id: "bbc-pin", kind: "source", key: "bbc" },
        { id: "extra-pin", kind: "source", key: "extra" }
      ]
    });
    const write = deferred();
    const read = deferred();
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return write.promise;
      if (String(input).endsWith("/prefs") && !init?.method) return read.promise;
      return Promise.resolve(response({}));
    });
    vi.stubGlobal("fetch", fetch);
    await mount(NewsSettings);
    await act(async () => {
      sourceButton("BBC News").props.onClick();
      await flush();
    });
    await act(async () => tree.unmount());
    await act(async () => {
      write.resolve(response({ ok: true }));
      await flush();
    });
    expect(fetch).toHaveBeenCalledWith("/api/news/prefs", expect.anything());
    await mount(NewsSettings);
    expect(sourceButton("Extra Wire").props.disabled).toBe(true);
    expect(sourceButton("Extra Wire").props["aria-pressed"]).toBeUndefined();
    await act(async () => sourceButton("Extra Wire").props.onClick());
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    await act(async () => {
      read.resolve(response({ prefs: [{ id: "extra-pin", kind: "source", key: "extra" }] }));
      await flush();
    });
    expect(sourceButton("Extra Wire").props.disabled).toBe(false);
    expect(sourceButton("Extra Wire").props["aria-pressed"]).toBe(true);
    expect(sourceButton("BBC News").props["aria-pressed"]).toBe(false);
  });

  it("holds cached-success choices during an authoritative refresh without a local mutation", async () => {
    primeSettings();
    client.setQueryData(newsQueryKeys.prefs, {
      prefs: [{ id: "extra-pin", kind: "source", key: "extra" }]
    });
    const read = deferred();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => read.promise)
    );
    await mount(NewsSettings);
    expect(sourceButton("Extra Wire").props.disabled).toBe(false);
    await act(async () => {
      void client.refetchQueries({ queryKey: newsQueryKeys.prefs });
      await flush();
    });
    expect(sourceButton("Extra Wire").props.disabled).toBe(true);
    expect(sourceButton("Extra Wire").props["aria-pressed"]).toBeUndefined();
    await act(async () => {
      read.resolve(response({ prefs: [] }));
      await flush();
    });
    expect(sourceButton("Extra Wire").props.disabled).toBe(false);
    expect(sourceButton("Extra Wire").props["aria-pressed"]).toBe(false);
  });

  it("holds an offline readback across remount and unlocks only after the online read succeeds", async () => {
    client.setDefaultOptions({ queries: { retry: false, staleTime: 15_000 } });
    primeSettings();
    client.setQueryData(newsQueryKeys.prefs, {
      prefs: [
        { id: "bbc-pin", kind: "source", key: "bbc" },
        { id: "extra-pin", kind: "source", key: "extra" }
      ]
    });
    const write = deferred();
    const read = deferred();
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return write.promise;
      if (String(input).endsWith("/prefs") && !init?.method) return read.promise;
      return Promise.resolve(response(client.getQueryData(newsQueryKeys.catalog)));
    });
    vi.stubGlobal("fetch", fetch);
    await mount(NewsSettings);
    await act(async () => {
      sourceButton("BBC News").props.onClick();
      await flush();
    });
    await act(async () => {
      onlineManager.setOnline(false);
      tree.unmount();
      write.resolve(response({ ok: true }));
      await flush();
    });
    expect(client.getQueryState(newsQueryKeys.prefs)).toMatchObject({
      status: "success",
      fetchStatus: "paused",
      isInvalidated: true
    });
    expect(client.isMutating()).toBe(0);
    expect(fetch.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(0);
    await mount(NewsSettings);
    expect(sourceButton("Extra Wire").props.disabled).toBe(true);
    expect(sourceButton("Extra Wire").props["aria-pressed"]).toBeUndefined();
    await act(async () => sourceButton("Extra Wire").props.onClick());
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    await act(async () => {
      await client.cancelQueries({ queryKey: newsQueryKeys.prefs });
      await flush();
    });
    expect(client.getQueryState(newsQueryKeys.prefs)).toMatchObject({
      status: "success",
      fetchStatus: "idle",
      isInvalidated: true
    });
    expect(sourceButton("Extra Wire").props.disabled).toBe(true);
    expect(button("Retry preferences").props.disabled).toBe(false);
    await act(async () => {
      button("Retry preferences").props.onClick();
      await flush();
    });
    expect(sourceButton("Extra Wire").props.disabled).toBe(true);
    await act(async () => {
      onlineManager.setOnline(true);
      await flush();
    });
    expect(fetch).toHaveBeenCalledWith("/api/news/prefs", expect.anything());
    expect(sourceButton("Extra Wire").props.disabled).toBe(true);
    await act(async () => {
      read.resolve(response({ prefs: [{ id: "extra-pin", kind: "source", key: "extra" }] }));
      await flush();
    });
    expect(sourceButton("Extra Wire").props.disabled).toBe(false);
    expect(sourceButton("Extra Wire").props["aria-pressed"]).toBe(true);
    expect(sourceButton("BBC News").props["aria-pressed"]).toBe(false);
    expect(client.getQueryState(newsQueryKeys.prefs)).toMatchObject({
      fetchStatus: "idle",
      isInvalidated: false
    });
  });

  it("blocks edits if the refresh following a write fails", async () => {
    primeSettings();
    client.setQueryData(newsQueryKeys.prefs, { prefs: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? response({ pref: { id: "world", kind: "topic", key: "world" } })
          : response({}, 503)
      )
    );
    await mount(NewsSettings);
    await act(async () => {
      button("World").props.onClick();
      await flush();
    });
    expect(button("World").props.disabled).toBe(true);
    expect(button("World").props["aria-pressed"]).toBeUndefined();
    expect(text(sourceButton("Extra Wire").props.children)).toContain("Unavailable");
    expect(button("Retry preferences").props.disabled).toBe(false);
  });
});

const story: NewsHeadline = {
  id: "one",
  sourceKey: "wire",
  sourceLabel: "Wire",
  topicKey: "us",
  topicLabel: "U.S.",
  title: "A US story",
  url: "https://example.com/one",
  publishedAt: "2026-10-11T00:00:00Z",
  imageUrl: null,
  faviconUrl: null,
  summary: ""
};
const overview: NewsOverviewResponse = {
  topStories: [story],
  rankedStories: [story],
  sourceGroups: [],
  activeTopics: ["us", "world"],
  enabledSources: [{ sourceKey: "wire", label: "Wire" }],
  degraded: false
};

describe("audit feeds: News matching and freshness", () => {
  it("shows a healthy topic's zero-result state and returns to All", async () => {
    client.setQueryData(newsQueryKeys.overview, overview);
    await mount(NewsPage);
    await act(async () => button("World").props.onClick());
    expect(text(tree.toJSON())).toContain("No stories for World");
    expect(tree.root.findAllByProps({ className: "nw-grid" })).toHaveLength(0);
    await act(async () => button("Show all stories").props.onClick());
    expect(text(tree.toJSON())).toContain("A US story");
    expect(text(tree.toJSON())).not.toContain("No stories for World");
  });

  it("does not describe unavailable empty sources as a confirmed quiet wire", async () => {
    client.setQueryData(newsQueryKeys.overview, {
      ...overview,
      topStories: [],
      rankedStories: [],
      degraded: true
    });
    await mount(NewsPage);
    expect(text(tree.toJSON())).toContain("News is unavailable");
    expect(text(tree.toJSON())).not.toContain("Nothing on the wire");
  });

  it("refreshes an aged mounted page on focus despite the disabled app default", async () => {
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false, refetchOnMount: false }
      }
    });
    client.setQueryData(newsQueryKeys.overview, overview, { updatedAt: Date.now() - 11 * 60_000 });
    const fetch = vi.fn(async () =>
      response({ ...overview, topStories: [{ ...story, title: "Fresh US story" }] })
    );
    vi.stubGlobal("fetch", fetch);
    focusManager.setFocused(false);
    await mount(NewsPage);
    await act(async () => {
      focusManager.setFocused(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(fetch).toHaveBeenCalledWith("/api/news/overview", expect.anything());
    expect(text(tree.toJSON())).toContain("Fresh US story");
  });
});
