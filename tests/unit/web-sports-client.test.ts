import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSportsFollow,
  confirmSportsSourceRecipe,
  confirmSportsSourceAssignments,
  deleteSportsFollow,
  getSportsCatalog,
  getSportsOverview,
  createSportsStoryFeedback,
  listSportsStoryFeedback,
  listSportsSources,
  listSportsFollows,
  previewSportsSourceAssignments,
  previewSportsSourceRecipe,
  retrySportsSource,
  undoSportsStoryFeedback,
  updateSportsStoryFeedbackReason,
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

  it("calls the story feedback endpoints with the shared request bodies", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await createSportsStoryFeedback({
      targetKind: "sports_story",
      targetRef: "story-ref-1",
      surface: "today",
      kind: "less_like_this",
      reason: "Not useful today"
    });
    await listSportsStoryFeedback();
    await updateSportsStoryFeedbackReason("feedback-1", { reason: "Updated reason" });
    await undoSportsStoryFeedback("feedback-1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/me/usefulness-feedback",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          targetKind: "sports_story",
          targetRef: "story-ref-1",
          surface: "today",
          kind: "less_like_this",
          reason: "Not useful today"
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/me/usefulness-feedback?module=sports&status=active",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/me/usefulness-feedback/feedback-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ reason: "Updated reason" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/me/usefulness-feedback/feedback-1/undo",
      expect.objectContaining({ method: "POST" })
    );
  });
});
