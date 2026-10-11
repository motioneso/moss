// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeroCarousel } from "../../packages/sports/src/web/sports-news.js";
import { SportsPage, LIVE_REFETCH_INTERVAL_MS } from "../../packages/sports/src/web/sports-page.js";
import { sportsQueryKeys } from "../../packages/sports/src/web/query-keys.js";
import { gamedayHero, headline, liveGame, makeOverview } from "./sports-page-fixtures.js";

let tree: ReactTestRenderer;
let client: QueryClient;
let motionChange: ((event: { matches: boolean }) => void) | undefined;
let reduced = false;
const removeMotionListener = vi.fn();
const stories = [headline("a", "nfl", "First story"), headline("b", "nfl", "Second story")];

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

function carousel() {
  return tree.root.findByProps({ className: "sp-carousel" });
}

function activeTitle() {
  const active = tree.root.findByProps({
    className: "sp-carousel__slide sp-carousel__slide--active"
  });
  return active.findByProps({ className: "sp-hero__link" }).props.children;
}

async function tick(ms = 7_001) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mountStories() {
  await act(async () => {
    tree = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(HeroCarousel, { headlines: stories })
      )
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  motionChange = undefined;
  removeMotionListener.mockClear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return reduced;
      },
      addEventListener: (_type: string, listener: typeof motionChange) => {
        motionChange = listener;
      },
      removeEventListener: removeMotionListener
    }))
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
});

afterEach(() => {
  act(() => tree?.unmount());
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("audit feeds: Sports rotation", () => {
  it("keeps focus paused after the mouse leaves", async () => {
    await mountStories();
    await act(async () => {
      carousel().props.onMouseEnter();
      carousel().props.onFocus();
      carousel().props.onMouseLeave();
    });
    await tick();
    expect(activeTitle()).toBe("First story");
  });

  it("keeps hover paused after focus leaves", async () => {
    await mountStories();
    const currentTarget = document.createElement("section");
    await act(async () => {
      carousel().props.onMouseEnter();
      carousel().props.onFocus();
      carousel().props.onBlur({ currentTarget, relatedTarget: null });
    });
    await tick();
    expect(activeTitle()).toBe("First story");
  });

  it("keeps focus paused across an internal control-to-control move", async () => {
    await mountStories();
    const currentTarget = document.createElement("section");
    const relatedTarget = document.createElement("button");
    currentTarget.append(relatedTarget);
    await act(async () => carousel().props.onFocus());
    await act(async () => carousel().props.onBlur({ currentTarget, relatedTarget }));
    await tick();
    expect(activeTitle()).toBe("First story");
  });

  it("preserves an explicit pause through hover, focus departure and manual next", async () => {
    await mountStories();
    await act(async () => button("Pause rotation").props.onClick());
    expect(button("Resume rotation").props["aria-pressed"]).toBe(true);
    await act(async () => {
      carousel().props.onMouseEnter();
      carousel().props.onFocus();
      carousel().props.onMouseLeave();
      carousel().props.onBlur({
        currentTarget: document.createElement("section"),
        relatedTarget: null
      });
      button("Next story").props.onClick();
    });
    expect(activeTitle()).toBe("Second story");
    await tick(21_000);
    expect(activeTitle()).toBe("Second story");
    await act(async () => button("Resume rotation").props.onClick());
    await tick();
    expect(activeTitle()).toBe("First story");
  });

  it("responds to live reduced-motion changes and retains the explicit stop", async () => {
    await mountStories();
    expect(motionChange).toBeDefined();
    await act(async () => {
      reduced = true;
      motionChange?.({ matches: true });
    });
    await tick();
    expect(activeTitle()).toBe("First story");
    expect(button("Pause rotation").props.disabled).toBe(true);
    await act(async () => {
      reduced = false;
      motionChange?.({ matches: false });
    });
    await tick();
    expect(activeTitle()).toBe("Second story");
    await act(async () => button("Pause rotation").props.onClick());
    await act(async () => {
      reduced = true;
      motionChange?.({ matches: true });
    });
    await act(async () => {
      reduced = false;
      motionChange?.({ matches: false });
    });
    await tick();
    expect(activeTitle()).toBe("Second story");
  });

  it("clears rotation when the pool shrinks to one and preserves a user pause when it grows", async () => {
    await mountStories();
    await act(async () => button("Pause rotation").props.onClick());
    await act(async () => {
      tree.update(
        createElement(
          QueryClientProvider,
          { client },
          createElement(HeroCarousel, { headlines: [stories[0]!] })
        )
      );
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(removeMotionListener).toHaveBeenCalled();
    await act(async () => {
      tree.update(
        createElement(
          QueryClientProvider,
          { client },
          createElement(HeroCarousel, { headlines: stories })
        )
      );
    });
    expect(button("Resume rotation").props["aria-pressed"]).toBe(true);
    await tick();
    expect(activeTitle()).toBe("First story");
  });

  it("cleans up motion listeners and the interval on unmount", async () => {
    await mountStories();
    const listener = motionChange;
    await act(async () => tree.unmount());
    expect(removeMotionListener).toHaveBeenCalledWith("change", listener);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps live score polling while the gameday carousel is explicitly paused", async () => {
    const first = liveGame();
    const second = {
      ...first,
      id: "second",
      home: { ...first.home, name: "Second home", shortName: "SH" }
    };
    const initial = makeOverview({ hero: gamedayHero(first, second) });
    client.setQueryData(sportsQueryKeys.overview, initial);
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...initial,
            hero: gamedayHero({ ...first, home: { ...first.home, score: 99 } }, second)
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetch);
    await act(async () => {
      tree = create(createElement(QueryClientProvider, { client }, createElement(SportsPage)));
    });
    await act(async () => button("Pause rotation").props.onClick());
    await tick(LIVE_REFETCH_INTERVAL_MS + 1);
    expect(fetch).toHaveBeenCalledWith("/api/sports/overview", expect.anything());
    const active = tree.root.findAllByProps({ "data-active": "true" })[0]!;
    expect(
      active.findAllByProps({ className: "sp-scorebar__score" }).map((node) => node.props.children)
    ).toContain(99);
    expect(button("Resume rotation").props["aria-pressed"]).toBe(true);
  });

  it("names unavailable empty coverage rather than asserting no followed game", async () => {
    client.setQueryData(
      sportsQueryKeys.overview,
      makeOverview({ hero: { mode: "story", headline: null }, topStories: [], degraded: true })
    );
    await act(async () => {
      tree = create(createElement(QueryClientProvider, { client }, createElement(SportsPage)));
    });
    expect(tree.root.findByProps({ className: "sp-hero__headline" }).props.children).toBe(
      "Sports information is unavailable"
    );
  });
});
