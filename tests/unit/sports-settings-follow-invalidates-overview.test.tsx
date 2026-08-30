// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import SportsSettings from "../../packages/sports/src/settings/index.js";
import { sportsQueryKeys } from "../../packages/sports/src/web/query-keys.js";

const CATALOG_KEY = sportsQueryKeys.catalog;
const FOLLOWS_KEY = sportsQueryKeys.follows;

const NFL = {
  competitionKey: "nfl",
  label: "NFL",
  sportLabel: "Football",
  regionLabel: null,
  kind: "league" as const,
  marquee: false,
  standingsShape: "record" as const,
  confederation: "INTL" as const
};

type Follow = { id: string; competitionKey: string; teamKey: string | null; createdAt: string };

/** Routes fetch by URL/method so background refetches (staleTime 0) serve real shapes instead of
    corrupting query state, matching what the mutation's onSuccess actually triggers. */
function stubFetch(initialFollows: readonly Follow[]) {
  let follows = [...initialFollows];
  let nextId = 2;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/sports/catalog") {
      return new Response(JSON.stringify({ competitions: [NFL], degraded: false }), {
        status: 200
      });
    }
    if (url === "/api/sports/follows" && method === "GET") {
      return new Response(JSON.stringify({ follows }), { status: 200 });
    }
    if (url === "/api/sports/follows" && method === "POST") {
      const follow: Follow = {
        id: `f${nextId++}`,
        competitionKey: "nfl",
        teamKey: null,
        createdAt: "2026-01-01T00:00:00Z"
      };
      follows = [...follows, follow];
      return new Response(JSON.stringify({ follow }), { status: 200 });
    }
    if (url.startsWith("/api/sports/follows/") && method === "DELETE") {
      const id = decodeURIComponent(url.split("/").pop() ?? "");
      follows = follows.filter((f) => f.id !== id);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function findButton(renderer: ReactTestRenderer, ariaLabel: string) {
  return renderer.root
    .findAllByType("button")
    .find((item) => item.props["aria-label"] === ariaLabel)!;
}

describe("Sports settings follow/unfollow refreshes the standings overview (#2091)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("invalidates the overview query, not just the follows list, on unfollow", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const fetchMock = stubFetch([
      { id: "f1", competitionKey: "nfl", teamKey: null, createdAt: "2026-01-01T00:00:00Z" }
    ]);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(QueryClientProvider, { client }, createElement(SportsSettings))
      );
    });
    // Flush the initial follows/catalog fetches (each hop is fetch -> Response.json() -> setState,
    // several microtask turns) so the summary list (and its "Unfollow" button) has mounted.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const unfollowBtn = findButton(renderer, "Unfollow All NFL");
    await act(async () => {
      unfollowBtn.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sports/follows/f1",
      expect.objectContaining({ method: "DELETE" })
    );
    // #2091: the standings dropdown reads /api/sports/overview via sportsQueryKeys.overview, a
    // separate cache entry from the follows list this mutation used to invalidate on its own.
    // Without also invalidating overview here, the dropdown keeps showing the team as followed.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: FOLLOWS_KEY });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: sportsQueryKeys.overview });
  });

  it("invalidates the overview query on follow too, since both share one handler", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const fetchMock = stubFetch([]);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(QueryClientProvider, { client }, createElement(SportsSettings))
      );
    });

    const browseToggle = renderer.root
      .findAllByType("button")
      .find((item) => item.props.className === "sp-browse-toggle")!;
    await act(async () => {
      browseToggle.props.onClick();
    });
    const followBtn = findButton(renderer, "Follow all of NFL");
    await act(async () => {
      followBtn.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sports/follows",
      expect.objectContaining({ method: "POST" })
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: sportsQueryKeys.overview });
  });
});
