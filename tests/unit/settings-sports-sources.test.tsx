// @vitest-environment jsdom
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompetitionRef, SportsFollowDto, TeamRef } from "@moss/shared";

import { SourceAssignmentPicker } from "../../packages/sports/src/settings/source-assignment-picker.js";
import { AddSourceFlow, SportsSourcesSection } from "../../packages/sports/src/settings/sources.js";
import { sportsQueryKeys } from "../../packages/sports/src/web/query-keys.js";

const NFL: CompetitionRef = {
  competitionKey: "nfl",
  label: "NFL",
  sportLabel: "Football",
  regionLabel: null,
  kind: "league",
  marquee: true,
  standingsShape: "record",
  confederation: "INTL"
};
const FOLLOWS: readonly SportsFollowDto[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    competitionKey: "nfl",
    teamKey: null,
    createdAt: "2026-08-25T12:00:00.000Z"
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    competitionKey: "nfl",
    teamKey: "dal",
    createdAt: "2026-08-25T12:00:00.000Z"
  }
];
const DAL: TeamRef = {
  teamKey: "dal",
  competitionKey: "nfl",
  name: "Dallas Cowboys",
  shortName: "DAL",
  crestUrl: null
};
const COMPETITIONS = new Map([[NFL.competitionKey, NFL]]);
const TEAMS = new Map([[NFL.competitionKey, [DAL]]]);

const espn = {
  kind: "builtin" as const,
  id: "espn" as const,
  label: "ESPN" as const,
  enabled: true,
  usesDefaultCoverage: true,
  assignments: []
};
const fotmobSourceId = "33333333-3333-3333-3333-333333333333";
const fotmobFeedUrl = "https://fotmob.com/feed.xml";
const fotmob = {
  kind: "custom" as const,
  id: fotmobSourceId,
  label: "FotMob",
  canonicalDomain: "fotmob.com",
  homepageUrl: "https://fotmob.com/",
  feedUrl: fotmobFeedUrl,
  retrievalMethod: "feed" as const,
  enabled: true,
  healthState: "healthy" as const,
  healthReasonCode: null,
  healthMessage: null,
  lastCheckedAt: "2026-08-25T12:00:00.000Z",
  lastSuccessAt: "2026-08-25T12:00:00.000Z",
  recipeStatus: "feed" as const,
  assignedFollowIds: [FOLLOWS[0]!.id],
  assignments: [
    {
      id: "44444444-4444-4444-4444-444444444444",
      followId: FOLLOWS[0]!.id,
      sportKey: null,
      targetUrl: fotmobFeedUrl,
      previewStatus: "verified" as const,
      healthState: "healthy" as const,
      healthReasonCode: null,
      healthMessage: null,
      lastCheckedAt: "2026-08-25T12:00:00.000Z",
      lastSuccessAt: "2026-08-25T12:00:00.000Z",
      createdAt: "2026-08-25T12:00:00.000Z"
    }
  ],
  createdAt: "2026-08-25T12:00:00.000Z"
};

function renderSection(client: QueryClient): string {
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(SportsSourcesSection, {
        follows: FOLLOWS,
        competitionsByKey: COMPETITIONS,
        teamsByCompetition: TEAMS
      })
    )
  );
}

function renderedText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(renderedText).join("");
  if (typeof node === "object" && "children" in (node as Record<string, unknown>)) {
    return renderedText((node as { children: unknown }).children);
  }
  return "";
}

describe("Sports source coverage settings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders Sports, Leagues, and Teams with the shared checkbox primitive", () => {
    const html = renderToString(
      createElement(SourceAssignmentPicker, {
        follows: FOLLOWS,
        competitionsByKey: COMPETITIONS,
        teamsByCompetition: TEAMS,
        selected: new Set(["sport:soccer", `follow:${FOLLOWS[0]!.id}`]),
        onToggle: () => {},
        idPrefix: "test-picker"
      })
    );

    expect(html).toContain("Sports");
    expect(html).toContain("Soccer");
    expect(html).toContain("Leagues");
    expect(html).toContain("All NFL");
    expect(html).toContain("Teams");
    expect(html).toContain("DAL");
    expect(html).toContain('class="jds-check sp-src__check"');
  });

  it("shows ESPN first as built-in with truthful default and disabled summaries", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } }
    });
    client.setQueryData(sportsQueryKeys.sources, { sources: [espn] });
    const enabledHtml = renderSection(client);

    expect(enabledHtml).toContain("ESPN");
    expect(enabledHtml).toContain("Built-in");
    expect(enabledHtml).toContain("Coverage: All sports");
    expect(enabledHtml).toContain("Edit coverage");
    expect(enabledHtml).not.toContain(">Retry<");
    expect(enabledHtml).not.toContain(">Rebuild<");
    expect(enabledHtml).not.toContain(">Remove<");

    client.setQueryData(sportsQueryKeys.sources, {
      sources: [
        {
          ...espn,
          usesDefaultCoverage: false,
          assignments: [
            { kind: "sport", sportKey: "soccer" },
            { kind: "follow", followId: FOLLOWS[0]!.id }
          ]
        }
      ]
    });
    expect(renderSection(client)).toContain("Coverage: Soccer, All NFL");

    client.setQueryData(sportsQueryKeys.sources, {
      sources: [{ ...espn, enabled: false, usesDefaultCoverage: false }]
    });
    expect(renderSection(client)).toContain("Inactive for headlines.");
  });

  it("refetches the normalized source list after clearing ESPN coverage", async () => {
    const disabled = { ...espn, enabled: false, usesDefaultCoverage: false };
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        expect(JSON.parse(String(init.body))).toEqual({ assignments: [] });
        return new Response(JSON.stringify({ source: disabled }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ sources: [disabled] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sportsQueryKeys.sources, { sources: [espn] });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(SportsSourcesSection, {
            follows: FOLLOWS,
            competitionsByKey: COMPETITIONS,
            teamsByCompetition: TEAMS
          })
        )
      );
    });

    const button = (label: string) =>
      renderer.root
        .findAllByType("button")
        .find((candidate) => renderedText(candidate.props.children) === label);
    act(() => button("Edit coverage")?.props.onClick());
    for (const input of renderer.root.findAllByType("input")) {
      if (String(input.props.id).includes("-sport-")) act(() => input.props.onChange());
    }
    await act(async () => button("Save coverage")?.props.onClick());

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sports/sources/espn/coverage",
      expect.objectContaining({ method: "PUT" })
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === undefined)).toBe(true);
    expect(renderedText(renderer.toJSON())).toContain("Inactive for headlines.");
  });

  it("previews a Soccer assignment while retaining a custom source's league coverage", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "rejected", reason: "unreachable" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } }
    });
    client.setQueryData(sportsQueryKeys.sources, {
      sources: [espn, fotmob]
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(SportsSourcesSection, {
            follows: FOLLOWS,
            competitionsByKey: COMPETITIONS,
            teamsByCompetition: TEAMS
          })
        )
      );
    });

    expect(renderedText(renderer.toJSON())).not.toContain(fotmobFeedUrl);
    const assignmentLogo = renderer.root.findAllByType("img")[0];
    expect(assignmentLogo?.props).toMatchObject({ alt: "", "aria-hidden": "true" });

    const edit = renderer.root
      .findAllByType("button")
      .find((candidate) => candidate.props["aria-label"] === "Edit coverage for FotMob");
    act(() => edit?.props.onClick());
    const soccer = renderer.root
      .findAllByType("input")
      .find((input) => String(input.props.id).includes(`${fotmobSourceId}-sport-sport:soccer`));
    act(() => soccer?.props.onChange());
    const review = renderer.root
      .findAllByType("button")
      .find((candidate) => renderedText(candidate.props.children) === "Review changes");
    await act(async () => review?.props.onClick());

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/sports/sources/${fotmobSourceId}/assignments/preview`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          assignments: [
            { target: { kind: "follow", followId: FOLLOWS[0]!.id } },
            { target: { kind: "sport", sportKey: "soccer" } }
          ]
        })
      })
    );
    expect(renderedText(renderer.toJSON())).not.toContain(fotmobFeedUrl);
    const error = renderer.root.findAllByProps({ role: "alert" })[0];
    expect(error?.props.className).toBe("sp-src__err");
    expect(renderedText(error)).toContain("Those assignments could not be verified.");
  });

  it("shows successful assignment previews as identities without raw feed URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "ok",
              confirmationId: "confirmation-1",
              authorizationAcknowledgement: "I confirm this public source.",
              candidate: {
                label: "FotMob",
                canonicalDomain: "fotmob.com",
                homepageUrl: "https://fotmob.com/",
                retrievalMethod: "feed",
                sampleCount: 0,
                confirmedFetchHosts: ["fotmob.com"],
                sampleHeadlines: [],
                targets: [
                  {
                    target: { kind: "follow", followId: FOLLOWS[0]!.id },
                    label: "All NFL",
                    scope: "league",
                    targetUrl: fotmobFeedUrl,
                    sampleHeadlines: []
                  },
                  {
                    target: { kind: "sport", sportKey: "soccer" },
                    label: "Soccer",
                    scope: "sport",
                    targetUrl: fotmobFeedUrl,
                    sampleHeadlines: []
                  }
                ]
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } }
    });
    client.setQueryData(sportsQueryKeys.sources, { sources: [espn, fotmob] });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(SportsSourcesSection, {
            follows: FOLLOWS,
            competitionsByKey: COMPETITIONS,
            teamsByCompetition: TEAMS
          })
        )
      );
    });

    const button = (label: string) =>
      renderer.root
        .findAllByType("button")
        .find((candidate) => renderedText(candidate.props.children) === label);
    const edit = renderer.root
      .findAllByType("button")
      .find((candidate) => candidate.props["aria-label"] === "Edit coverage for FotMob");
    act(() => edit?.props.onClick());
    const soccer = renderer.root
      .findAllByType("input")
      .find((input) => String(input.props.id).includes(`${fotmobSourceId}-sport-sport:soccer`));
    act(() => soccer?.props.onChange());
    await act(async () => button("Review changes")?.props.onClick());

    const text = renderedText(renderer.toJSON());
    expect(text).toContain("All NFL");
    expect(text).toContain("Soccer");
    expect(text).not.toContain(fotmobFeedUrl);
  });
});

describe("Sports add-source preview card", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function previewWith(overrides: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "ok",
              confirmationId: "confirmation-1",
              authorizationAcknowledgement: "I confirm this public source.",
              candidate: {
                label: "FotMob",
                canonicalDomain: "fotmob.com",
                homepageUrl: "https://fotmob.com/",
                retrievalMethod: "feed",
                sampleCount: 1,
                confirmedFetchHosts: ["fotmob.com"],
                sampleHeadlines: ["Shared headline"],
                targets: [
                  {
                    target: { kind: "sport", sportKey: "soccer" },
                    label: "Soccer",
                    scope: "sport",
                    targetUrl: fotmobFeedUrl,
                    sampleHeadlines: ["Per-coverage headline"]
                  }
                ]
              },
              ...overrides
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(AddSourceFlow, {
            follows: FOLLOWS,
            competitionsByKey: COMPETITIONS,
            teamsByCompetition: TEAMS
          })
        )
      );
    });
    const input = renderer.root
      .findAllByType("input")
      .find((candidate) => candidate.props.id === "sp-addsource-input");
    act(() => input?.props.onChange({ target: { value: "fotmob.com" } }));
    const form = renderer.root.findByType("form");
    await act(async () => form.props.onSubmit({ preventDefault() {} }));
    return renderer;
  }

  it("shows sample headlines once, without the per-coverage repeats", async () => {
    const renderer = await previewWith({});
    const text = renderedText(renderer.toJSON());
    expect(text).toContain("Shared headline");
    expect(text).not.toContain("Per-coverage headline");
    expect(text).toContain("I confirm this public source.");
    expect(
      renderer.root
        .findAllByType("button")
        .some((button) => renderedText(button.props.children) === "Add this source")
    ).toBe(true);
  });

  it("makes a duplicate publication obvious and hides the add controls", async () => {
    const renderer = await previewWith({ duplicateOfSourceId: fotmobSourceId });
    const notice = renderer.root.findAllByProps({ role: "status" })[0];
    expect(notice?.props.className).toBe("sp-src__dupe");
    expect(renderedText(notice)).toContain("Already added");
    const buttons = renderer.root
      .findAllByType("button")
      .map((b) => renderedText(b.props.children));
    expect(buttons).not.toContain("Add this source");
    expect(buttons).toContain("Close");
    expect(renderedText(renderer.toJSON())).not.toContain("I confirm this public source.");
  });
});
