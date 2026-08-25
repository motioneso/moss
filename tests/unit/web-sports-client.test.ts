import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSportsFollow,
  confirmSportsSourceRecipe,
  confirmSportsSourceAssignments,
  deleteSportsFollow,
  getSportsCatalog,
  getSportsOverview,
  listSportsSources,
  listSportsFollows,
  previewSportsSourceAssignments,
  previewSportsSourceRecipe,
  retrySportsSource,
  updateSportsEspnCoverage
} from "../../packages/sports/src/web/sports-client.js";
import { sportsQueryKeys } from "../../packages/sports/src/web/query-keys.js";

describe("sports API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defines sports query keys", () => {
    expect(sportsQueryKeys.overview).toEqual(["sports", "overview"]);
    expect(sportsQueryKeys.catalog).toEqual(["sports", "catalog"]);
    expect(sportsQueryKeys.follows).toEqual(["sports", "follows"]);
  });

  it("calls sports endpoints with expected methods and paths", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await getSportsOverview();
    await getSportsCatalog();
    await listSportsFollows();
    await createSportsFollow({ competitionKey: "nfl", teamKey: "dal" });
    await deleteSportsFollow("follow-1");
    await previewSportsSourceAssignments("source-1", { assignments: [] });
    await confirmSportsSourceAssignments("source-1", {
      confirmationId: "preview-1",
      authorizationAcknowledgement: "acknowledged",
      canonicalDomain: "publisher.example",
      confirmedFetchHosts: ["publisher.example"],
      targets: []
    });
    await retrySportsSource("source-1");
    await previewSportsSourceRecipe("source-1");
    await confirmSportsSourceRecipe("source-1", {
      confirmationId: "preview-2",
      authorizationAcknowledgement: "acknowledged",
      canonicalDomain: "publisher.example",
      confirmedFetchHosts: ["publisher.example"],
      targets: []
    });
    await listSportsSources();
    await updateSportsEspnCoverage({ assignments: [{ kind: "sport", sportKey: "soccer" }] });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/sports/overview",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/sports/catalog",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/sports/follows",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/sports/follows",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ competitionKey: "nfl", teamKey: "dal" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "/api/sports/follows/follow-1",
      expect.objectContaining({ method: "DELETE" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "/api/sports/sources/source-1/assignments/preview",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ assignments: [] }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      7,
      "/api/sports/sources/source-1/assignments",
      expect.objectContaining({ method: "PATCH" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      8,
      "/api/sports/sources/source-1/retry",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      9,
      "/api/sports/sources/source-1/rebuild/preview",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      10,
      "/api/sports/sources/source-1/rebuild",
      expect.objectContaining({ method: "PATCH" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      11,
      "/api/sports/sources",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      12,
      "/api/sports/sources/espn/coverage",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ assignments: [{ kind: "sport", sportKey: "soccer" }] })
      })
    );
  });
});
