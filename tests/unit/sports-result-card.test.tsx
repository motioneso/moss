import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { VisualSnapshotV1 } from "@moss/shared";
import { SportsResultCard } from "../../packages/sports/src/results/card.js";

const snapshot: VisualSnapshotV1 = {
  ref: "snapshot",
  kind: "sports.result",
  origin: "source",
  source: { id: "espn", label: "ESPN" },
  retrievedAt: "2026-10-23T12:00:00Z",
  coverage: "Latest available result. Cup coverage unavailable.",
  fields: {
    id: "1",
    sport: "soccer",
    competitionKey: "eng.1",
    competition: "Premier League",
    startsAt: "2026-10-22T18:00:00Z",
    status: "After penalties",
    home: {
      id: "364",
      name: "Liverpool",
      crestUrl: "https://a.espncdn.com/liverpool.png",
      score: null,
      shootout: 5,
      aggregate: 2
    },
    away: { id: "2", name: "Opponent", crestUrl: null, score: 0, shootout: 4, aggregate: 2 }
  }
};

describe("saved sourced scorecard", () => {
  it("keeps names and score readable when artwork is absent or fails", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(SportsResultCard, { snapshot }));
    });
    const initial = JSON.stringify(renderer.toJSON());
    expect(initial).toContain("Liverpool");
    expect(initial).toContain("Opponent");
    expect(initial).toContain("Unknown");
    expect(initial).toContain('"0"');
    expect(initial).toContain("Shootout:");
    expect(initial).toContain("Aggregate:");
    expect(initial).toContain("Cup coverage unavailable");
    const image = renderer.root.findByType("img");
    expect(image.props.alt).toBe("Liverpool crest");
    await act(async () => image.props.onError());
    expect(renderer.root.findAllByType("img")).toHaveLength(0);
    const failed = JSON.stringify(renderer.toJSON());
    expect(failed).toContain("Liverpool");
    expect(failed).toContain("Unknown");
    expect(failed).toContain('"L"');
    await act(async () => renderer.unmount());
  });
});
